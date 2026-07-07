//! OpenAI-compatible relay client (reqwest).
//!
//! Talks to the same relay that Codex uses. Credentials are reused from the
//! `engine_config` layer:
//!   - `base_url` comes from `~/.codex/config.toml`
//!   - the API key comes from `~/.codex/auth.json` (`OPENAI_API_KEY`)
//!
//! Security: the API key is NEVER written to logs, error messages, SQLite, or
//! returned to the frontend. `RelayCreds` has a custom `Debug` that redacts it.
//!
//! Endpoints:
//!   - `GET  /v1/models`              model id list
//!   - `POST /v1/chat/completions`    streamed SSE (manual `data:` parsing)
//!   - `POST /v1/images/generations`  url OR b64_json (dual mode) local file
//!   - `POST /v1/videos`              capability probe (404 == unsupported)

use base64::Engine as _;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

// -- Credentials -------------------------------------------------------------

/// Relay credentials. The `api_key` field is private and never exposed.
pub struct RelayCreds {
    pub base_url: String,
    api_key: String,
    /// `"chat"` (/v1/chat/completions) or `"responses"` (/v1/responses).
    pub wire_api: String,
}

impl RelayCreds {
    /// Build credentials directly (used by the multi-provider layer, where the
    /// key comes from the OS credential store rather than `~/.codex`).
    pub(crate) fn new(base_url: String, api_key: String, wire_api: String) -> Self {
        let wire_api = if wire_api == "responses" {
            "responses".to_string()
        } else {
            "chat".to_string()
        };
        Self {
            base_url: base_url.trim().to_string(),
            api_key,
            wire_api,
        }
    }

    /// Load credentials from the real Codex config + auth files.
    pub fn load() -> Result<Self, String> {
        let config_path = crate::mcp::codex_config_path();
        let auth_path = crate::engine_config::auth_json_path();
        Self::load_from(&config_path, &auth_path)
    }

    /// Load credentials from explicit paths (used by tests).
    ///
    /// The legacy Codex relay is OpenAI-compatible and serves
    /// `/v1/chat/completions`, so we pin `wire_api = "chat"` here for the proven
    /// studio chat path regardless of the Codex config's own `wire_api` value.
    pub fn load_from(config_path: &Path, auth_path: &Path) -> Result<Self, String> {
        let info = crate::engine_config::engine_config_get(config_path, auth_path)?;
        let base_url = info.base_url.trim().to_string();
        if base_url.is_empty() {
            return Err("中继 base_url 未配置（请在设置中填写 API 地址）".to_string());
        }
        let api_key = read_api_key(auth_path)?;
        if api_key.is_empty() {
            return Err("未找到 API key（请在设置中填写 API key）".to_string());
        }
        Ok(Self {
            base_url,
            api_key,
            wire_api: "chat".to_string(),
        })
    }
}

// Redact the key when formatted for debugging.
impl std::fmt::Debug for RelayCreds {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayCreds")
            .field("base_url", &self.base_url)
            .field("wire_api", &self.wire_api)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

/// Read `OPENAI_API_KEY` from auth.json. Returns empty string when absent.
fn read_api_key(auth_path: &Path) -> Result<String, String> {
    if !auth_path.exists() {
        return Ok(String::new());
    }
    let content = std::fs::read_to_string(auth_path).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&content).map_err(|_| "auth.json 解析失败".to_string())?;
    Ok(v.get("OPENAI_API_KEY")
        .and_then(|k| k.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

// -- Output types ------------------------------------------------------------

/// Result of a streamed chat completion.
#[derive(Debug, Clone)]
pub struct ChatOutcome {
    /// Full accumulated assistant text.
    pub text: String,
    /// True when the stream was cancelled before the server finished.
    pub stopped: bool,
}

/// One generated image already downloaded to the local media directory.
#[derive(Debug, Clone, Serialize)]
pub struct GeneratedImage {
    pub local_path: String,
    pub source_url: Option<String>,
}

// -- Public API --------------------------------------------------------------

/// `GET /v1/models` list of model ids.
pub async fn list_models(creds: &RelayCreds) -> Result<Vec<String>, String> {
    let url = api_url(&creds.base_url, "models");
    let resp = json_client(30)?
        .get(&url)
        .bearer_auth(&creds.api_key)
        .send()
        .await
        .map_err(|e| format!("请求模型列表失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "模型列表 HTTP {}: {}",
            status.as_u16(),
            truncate(&text, 300)
        ));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("模型列表解析失败: {e}"))?;
    let mut ids = Vec::new();
    if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
        for m in arr {
            if let Some(id) = m.get("id").and_then(|i| i.as_str()) {
                ids.push(id.to_string());
            }
        }
    }
    Ok(ids)
}

/// `POST /v1/chat/completions` with `stream: true`.
///
/// SSE is hand-parsed from `bytes_stream()`: bytes are buffered so lines that
/// straddle chunk boundaries are reassembled, only `data:` lines are decoded,
/// `[DONE]` ends the stream, and only choice 0 is read. `on_delta` is called for
/// every non-empty content delta. Cancellation via `cancel` stops the stream and
/// returns the partial text with `stopped = true`.
pub async fn chat_stream<F>(
    creds: &RelayCreds,
    model: &str,
    messages: Vec<Value>,
    cancel: CancellationToken,
    mut on_delta: F,
) -> Result<ChatOutcome, String>
where
    F: FnMut(&str),
{
    let responses_api = creds.wire_api == "responses";
    let (url, body) = if responses_api {
        (
            api_url(&creds.base_url, "responses"),
            json!({ "model": model, "input": messages, "stream": true }),
        )
    } else {
        (
            api_url(&creds.base_url, "chat/completions"),
            json!({ "model": model, "messages": messages, "stream": true }),
        )
    };
    let resp = stream_client()?
        .post(&url)
        .bearer_auth(&creds.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("chat 请求失败: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "chat HTTP {}: {}",
            status.as_u16(),
            truncate(&text, 500)
        ));
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();
    let mut stopped = false;

    'outer: loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => { stopped = true; break 'outer; }
            item = stream.next() => {
                match item {
                    None => break 'outer,
                    Some(Err(e)) => return Err(format!("chat 流读取失败: {e}")),
                    Some(Ok(bytes)) => {
                        buf.extend_from_slice(&bytes);
                        let cb = &mut |d: &str| {
                            full.push_str(d);
                            on_delta(d);
                        };
                        let done = if responses_api {
                            process_sse_buffer_responses(&mut buf, cb)
                        } else {
                            process_sse_buffer(&mut buf, cb)
                        };
                        if done { break 'outer; }
                    }
                }
            }
        }
    }

    Ok(ChatOutcome {
        text: full,
        stopped,
    })
}

/// `POST /v1/images/generations`. Dual mode: each `data[i]` may carry a `url`
/// (downloaded immediately) or `b64_json` (decoded). Every image is written to
/// the local media directory; returns their local paths (+ optional source url).
pub async fn generate_image(
    creds: &RelayCreds,
    model: &str,
    prompt: &str,
    size: &str,
    n: u32,
) -> Result<Vec<GeneratedImage>, String> {
    let url = api_url(&creds.base_url, "images/generations");
    let body = json!({
        "model": model,
        "prompt": prompt,
        "size": size,
        "n": n,
    });
    let client = json_client(300)?;
    let resp = client
        .post(&url)
        .bearer_auth(&creds.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("图像生成请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "图像生成 HTTP {}: {}",
            status.as_u16(),
            truncate(&text, 500)
        ));
    }
    save_images_from_response(&client, &text).await
}

/// `POST /v1/images/edits` (multipart). Sends the source image bytes + a text
/// prompt (and an optional black/white brush `mask`) and downloads the returned
/// image(s) exactly like [`generate_image`] (dual url / b64_json handling).
///
/// The relay accepts the same `{ data: [{ url | b64_json }] }` shape as the
/// generations endpoint, so the download path is shared via
/// [`save_images_from_response`].
pub async fn edit_image(
    creds: &RelayCreds,
    model: &str,
    prompt: &str,
    size: &str,
    image_bytes: Vec<u8>,
    mask_bytes: Option<Vec<u8>>,
) -> Result<Vec<GeneratedImage>, String> {
    let url = api_url(&creds.base_url, "images/edits");

    let image_part = reqwest::multipart::Part::bytes(image_bytes)
        .file_name("source.png")
        .mime_str("image/png")
        .map_err(|e| format!("构建图像分片失败: {e}"))?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", model.to_string())
        .text("prompt", prompt.to_string())
        .part("image", image_part);
    // `auto` size is a UI convenience; the edits endpoint expects a concrete size.
    if !size.is_empty() && size != "auto" {
        form = form.text("size", size.to_string());
    }
    if let Some(mask) = mask_bytes {
        let mask_part = reqwest::multipart::Part::bytes(mask)
            .file_name("mask.png")
            .mime_str("image/png")
            .map_err(|e| format!("构建蒙版分片失败: {e}"))?;
        form = form.part("mask", mask_part);
    }

    let client = json_client(300)?;
    let resp = client
        .post(&url)
        .bearer_auth(&creds.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("图像编辑请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "图像编辑 HTTP {}: {}",
            status.as_u16(),
            truncate(&text, 500)
        ));
    }
    save_images_from_response(&client, &text).await
}

/// Parse an OpenAI images response body and persist every returned image to the
/// local media directory. Each `data[i]` may carry a `url` (downloaded with
/// `client`) or a `b64_json` blob (decoded inline). Shared by the generations
/// and edits endpoints.
async fn save_images_from_response(
    client: &reqwest::Client,
    body: &str,
) -> Result<Vec<GeneratedImage>, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("图像响应解析失败: {e}"))?;
    let data = v
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| "图像响应缺少 data 字段".to_string())?;
    if data.is_empty() {
        return Err("图像响应 data 为空".to_string());
    }

    let dir = media_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建媒体目录失败: {e}"))?;

    let mut out = Vec::new();
    for item in data {
        let dest = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
        if let Some(b64) = item.get("b64_json").and_then(|b| b.as_str()) {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|e| format!("b64 解码失败: {e}"))?;
            std::fs::write(&dest, &bytes).map_err(|e| format!("写入图像失败: {e}"))?;
            out.push(GeneratedImage {
                local_path: dest.to_string_lossy().to_string(),
                source_url: None,
            });
        } else if let Some(src) = item.get("url").and_then(|u| u.as_str()) {
            let img = client
                .get(src)
                .send()
                .await
                .map_err(|e| format!("下载图像失败: {e}"))?;
            if !img.status().is_success() {
                return Err(format!("下载图像 HTTP {}", img.status().as_u16()));
            }
            let bytes = img
                .bytes()
                .await
                .map_err(|e| format!("读取图像字节失败: {e}"))?;
            std::fs::write(&dest, &bytes).map_err(|e| format!("写入图像失败: {e}"))?;
            out.push(GeneratedImage {
                local_path: dest.to_string_lossy().to_string(),
                source_url: Some(src.to_string()),
            });
        } else {
            return Err("图像响应条目缺少 url 与 b64_json".to_string());
        }
    }
    Ok(out)
}

/// `POST /v1/videos` with an empty body. Returns `false` on HTTP 404 (endpoint
/// absent), `true` for any other status (endpoint exists in some form).
pub async fn probe_video(creds: &RelayCreds) -> Result<bool, String> {
    let url = api_url(&creds.base_url, "videos");
    let resp = json_client(30)?
        .post(&url)
        .bearer_auth(&creds.api_key)
        .json(&json!({}))
        .send()
        .await
        .map_err(|e| format!("视频探测请求失败: {e}"))?;
    Ok(resp.status().as_u16() != 404)
}

// -- Media directory ---------------------------------------------------------

/// `%APPDATA%/agentboard/media` (Windows) or `~/.local/share/agentboard/media`.
pub fn media_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:/Users/Default/AppData/Roaming"));

    #[cfg(not(windows))]
    let base = std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".local/share"))
        .unwrap_or_else(|_| PathBuf::from("/tmp"));

    base.join("agentboard").join("media")
}

// -- Internal helpers --------------------------------------------------------

/// Build a `/v1/<path>` URL, tolerating a base_url that already ends in `/v1`.
fn api_url(base_url: &str, path: &str) -> String {
    let b = base_url.trim().trim_end_matches('/');
    let root = b.strip_suffix("/v1").unwrap_or(b);
    format!("{}/v1/{}", root, path.trim_start_matches('/'))
}

/// Client for one-shot JSON requests (bounded total timeout).
fn json_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("HTTP client 构建失败: {e}"))
}

/// Client for streaming (no total timeout only a connect timeout).
fn stream_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client 构建失败: {e}"))
}

/// Drain complete lines from an SSE byte buffer. Incomplete trailing bytes stay
/// in `buf` for the next chunk. Calls `on_delta` for each content delta.
/// Returns `true` once a `data: [DONE]` sentinel is seen.
fn process_sse_buffer<F: FnMut(&str)>(buf: &mut Vec<u8>, on_delta: &mut F) -> bool {
    loop {
        let Some(nl) = buf.iter().position(|&b| b == b'\n') else {
            return false;
        };
        let line_bytes: Vec<u8> = buf.drain(..=nl).collect();
        let line_cow = String::from_utf8_lossy(&line_bytes);
        let line = line_cow.trim();
        if line.is_empty() {
            continue;
        }
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            return true;
        }
        if let Ok(v) = serde_json::from_str::<Value>(data) {
            if let Some(d) = v
                .pointer("/choices/0/delta/content")
                .and_then(|c| c.as_str())
            {
                if !d.is_empty() {
                    on_delta(d);
                }
            }
        }
    }
}

/// Drain complete lines from an SSE byte buffer for the OpenAI **Responses**
/// streaming format. Extracts text from `response.output_text.delta` events and
/// returns `true` on `[DONE]` or a `response.completed`/`response.done` event.
fn process_sse_buffer_responses<F: FnMut(&str)>(buf: &mut Vec<u8>, on_delta: &mut F) -> bool {
    loop {
        let Some(nl) = buf.iter().position(|&b| b == b'\n') else {
            return false;
        };
        let line_bytes: Vec<u8> = buf.drain(..=nl).collect();
        let line_cow = String::from_utf8_lossy(&line_bytes);
        let line = line_cow.trim();
        if line.is_empty() {
            continue;
        }
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            return true;
        }
        if let Ok(v) = serde_json::from_str::<Value>(data) {
            match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "response.output_text.delta" => {
                    if let Some(d) = v.get("delta").and_then(|c| c.as_str()) {
                        if !d.is_empty() {
                            on_delta(d);
                        }
                    }
                }
                "response.completed" | "response.done" => return true,
                _ => {}
            }
        }
    }
}

/// Truncate to at most `max` characters, appending an ellipsis when clipped.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('.');
        out.push('.');
        out.push('.');
        out
    }
}

// -- Unit tests --------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(buf: &mut Vec<u8>) -> (String, bool) {
        let mut acc = String::new();
        let done = process_sse_buffer(buf, &mut |d| acc.push_str(d));
        (acc, done)
    }

    #[test]
    fn api_url_appends_v1() {
        assert_eq!(
            api_url("https://x.com", "models"),
            "https://x.com/v1/models"
        );
        assert_eq!(
            api_url("https://x.com/", "models"),
            "https://x.com/v1/models"
        );
    }

    #[test]
    fn api_url_tolerates_existing_v1() {
        assert_eq!(
            api_url("https://x.com/v1", "chat/completions"),
            "https://x.com/v1/chat/completions"
        );
        assert_eq!(
            api_url("https://x.com/v1/", "/images/generations"),
            "https://x.com/v1/images/generations"
        );
    }

    #[test]
    fn sse_single_chunk_two_deltas() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n");
        buf.extend_from_slice(b"data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n");
        let (acc, done) = collect(&mut buf);
        assert_eq!(acc, "Hello");
        assert!(!done);
        assert!(buf.is_empty());
    }

    #[test]
    fn sse_line_split_across_chunks() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"data: {\"choices\":[{\"delta\":{\"content\":\"Wor");
        let (acc, done) = collect(&mut buf);
        assert_eq!(acc, "", "no complete line yet");
        assert!(!done);
        assert!(!buf.is_empty(), "partial line retained in buffer");
        buf.extend_from_slice(b"ld\"}}]}\n");
        let (acc, done) = collect(&mut buf);
        assert_eq!(acc, "World");
        assert!(!done);
    }

    #[test]
    fn sse_multibyte_split_across_chunks() {
        let full = "data: {\"choices\":[{\"delta\":{\"content\":\"中\"}}]}\n";
        let bytes = full.as_bytes();
        let mid = bytes.len() - 6;
        let mut buf = Vec::new();
        buf.extend_from_slice(&bytes[..mid]);
        let (acc1, _) = collect(&mut buf);
        assert_eq!(acc1, "");
        buf.extend_from_slice(&bytes[mid..]);
        let (acc2, done) = collect(&mut buf);
        assert_eq!(acc2, "中");
        assert!(!done);
    }

    #[test]
    fn sse_done_sentinel_and_crlf() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\r\n");
        buf.extend_from_slice(b"data: [DONE]\r\n");
        let (acc, done) = collect(&mut buf);
        assert_eq!(acc, "x");
        assert!(done, "[DONE] must stop the stream");
    }

    #[test]
    fn sse_ignores_non_data_and_empty_lines() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b": keep-alive comment\n\ndata: {\"choices\":[{\"delta\":{}}]}\n");
        let (acc, done) = collect(&mut buf);
        assert_eq!(acc, "", "delta without content contributes nothing");
        assert!(!done);
    }

    #[test]
    fn truncate_short_unchanged() {
        assert_eq!(truncate("hi", 10), "hi");
    }

    #[test]
    fn truncate_long_clipped() {
        let out = truncate("abcdef", 3);
        assert_eq!(out, "abc...");
    }

    #[test]
    fn creds_debug_redacts_key() {
        let creds = RelayCreds {
            base_url: "https://x.com".to_string(),
            api_key: "sk-supersecret-1234".to_string(),
            wire_api: "chat".to_string(),
        };
        let dbg = format!("{creds:?}");
        assert!(dbg.contains("https://x.com"));
        assert!(dbg.contains("<redacted>"));
        assert!(
            !dbg.contains("supersecret"),
            "key must never appear in Debug"
        );
    }

    #[test]
    fn new_normalizes_wire_api() {
        let c = RelayCreds::new("https://x.com/".into(), "k".into(), "responses".into());
        assert_eq!(c.wire_api, "responses");
        assert_eq!(c.base_url, "https://x.com/", "base_url trimmed only");
        let c2 = RelayCreds::new("u".into(), "k".into(), "garbage".into());
        assert_eq!(c2.wire_api, "chat", "unknown wire_api falls back to chat");
    }

    #[test]
    fn responses_sse_extracts_output_text_delta() {
        let mut buf = Vec::new();
        buf.extend_from_slice(
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\n",
        );
        buf.extend_from_slice(
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\n",
        );
        let mut acc = String::new();
        let done = process_sse_buffer_responses(&mut buf, &mut |d| acc.push_str(d));
        assert_eq!(acc, "Hello");
        assert!(!done);
        buf.extend_from_slice(b"data: {\"type\":\"response.completed\"}\n");
        let done2 = process_sse_buffer_responses(&mut buf, &mut |d| acc.push_str(d));
        assert!(done2, "response.completed ends the stream");
    }

    #[test]
    fn media_dir_ends_with_agentboard_media() {
        let d = media_dir();
        assert!(d.ends_with("media"));
        assert!(d.to_string_lossy().contains("agentboard"));
    }

    // -- Live tests (network + API cost; run with --ignored --nocapture) -----

    #[tokio::test]
    #[ignore]
    async fn live_chat_stream_gpt55() {
        let creds = RelayCreds::load().expect("load real creds");
        let messages = vec![json!({"role": "user", "content": "Reply with exactly: OK"})];
        let cancel = CancellationToken::new();
        let mut acc = String::new();
        let outcome = chat_stream(&creds, "gpt-5.5", messages, cancel, |d| {
            print!("{d}");
            acc.push_str(d);
        })
        .await
        .expect("chat_stream should succeed");
        println!("\n[live chat] full reply: {:?}", outcome.text);
        assert!(
            !outcome.text.trim().is_empty(),
            "expected a non-empty reply"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn live_generate_image_gpt_image_2() {
        let creds = RelayCreds::load().expect("load real creds");
        let imgs = generate_image(
            &creds,
            "gpt-image-2",
            "a small red circle centered on a white background",
            "1024x1024",
            1,
        )
        .await
        .expect("generate_image should succeed");
        assert_eq!(imgs.len(), 1, "expected exactly one image");
        println!(
            "[live image] saved: {} source_url={:?}",
            imgs[0].local_path, imgs[0].source_url
        );
        let meta = std::fs::metadata(&imgs[0].local_path).expect("image file should exist");
        assert!(meta.len() > 0, "image file must be non-empty");
    }
}
