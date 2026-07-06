//! 飞书推送通知模块
//!
//! - tenant_access_token 获取与缓存（提前 5 分钟过期重取，Mutex 保护）
//! - send_card: POST /open-apis/im/v1/messages，msg_type=interactive
//! - 卡片模板：完成（绿）、失败（红）、测试（蓝）
//! - 失败只写环形日志，不 panic，不阻塞事件管线
//! - spawn_send: fire-and-forget tokio 任务

use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// ── Ring log ──────────────────────────────────────────────────────────────────

const LOG_CAP: usize = 50;

static PUSH_LOG: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();

fn push_log() -> &'static Mutex<VecDeque<String>> {
    PUSH_LOG.get_or_init(|| Mutex::new(VecDeque::with_capacity(LOG_CAP + 1)))
}

fn append_log(entry: String) {
    let mut log = push_log().lock().unwrap();
    log.push_front(entry);
    if log.len() > LOG_CAP {
        log.truncate(LOG_CAP);
    }
}

/// Return recent push log entries (newest first, max 50).
pub fn recent_logs() -> Vec<String> {
    push_log().lock().unwrap().iter().cloned().collect()
}

// ── Token cache ───────────────────────────────────────────────────────────────

struct CachedToken {
    token: String,
    expires_at: Instant,
}

/// Thread-safe token store with 5-minute early-refresh buffer.
///
/// Exposed as `pub(crate)` so unit tests can construct an independent instance
/// without touching the process-wide global.
pub(crate) struct TokenStore {
    inner: Mutex<Option<CachedToken>>,
}

impl TokenStore {
    pub(crate) fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }

    /// Return the cached token if it is still valid; `None` if empty or expired.
    pub(crate) fn get_cached(&self) -> Option<String> {
        let guard = self.inner.lock().unwrap();
        guard.as_ref().and_then(|ct| {
            if ct.expires_at > Instant::now() {
                Some(ct.token.clone())
            } else {
                None
            }
        })
    }

    /// Store a freshly fetched token.  `expire_secs` is the server-reported TTL;
    /// we cache with a 5-minute (300 s) early-refresh buffer.
    pub(crate) fn store(&self, token: String, expire_secs: u64) {
        let mut guard = self.inner.lock().unwrap();
        *guard = Some(CachedToken {
            token,
            expires_at: Instant::now()
                + Duration::from_secs(expire_secs.saturating_sub(300)),
        });
    }
}

static TOKEN_STORE: OnceLock<TokenStore> = OnceLock::new();

fn global_token_store() -> &'static TokenStore {
    TOKEN_STORE.get_or_init(TokenStore::new)
}

// ── HTTP client factory ───────────────────────────────────────────────────────

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client build error: {e}"))
}

// ── Token acquisition ─────────────────────────────────────────────────────────

/// Obtain a valid tenant_access_token, re-fetching only when the cache is stale.
async fn get_token(app_id: &str, app_secret: &str) -> Result<String, String> {
    let store = global_token_store();
    if let Some(cached) = store.get_cached() {
        return Ok(cached);
    }

    let client = build_client()?;
    let body = json!({ "app_id": app_id, "app_secret": app_secret });

    let resp = client
        .post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("token fetch failed: {e}"))?;

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("token response parse error: {e}"))?;

    let code = data["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        return Err(format!(
            "飞书 token 获取失败 (code={}): {}",
            code,
            data["msg"].as_str().unwrap_or("unknown")
        ));
    }

    let token = data["tenant_access_token"]
        .as_str()
        .ok_or_else(|| "响应缺少 tenant_access_token 字段".to_string())?
        .to_string();
    let expire_secs = data["expire"].as_u64().unwrap_or(7200);

    store.store(token.clone(), expire_secs);
    Ok(token)
}

// ── Config ────────────────────────────────────────────────────────────────────

/// Feishu notification config extracted from the settings table.
#[derive(Debug, Clone)]
pub struct FeishuConfig {
    pub app_id: String,
    pub app_secret: String,
    /// `"open_id"` or `"chat_id"`
    pub receive_id_type: String,
    pub receive_id: String,
}

/// Extract feishu config from a settings map.
/// Returns `None` if `feishu_enabled != "true"` or any required field is blank.
pub fn load_config(settings: &HashMap<String, String>) -> Option<FeishuConfig> {
    if settings.get("feishu_enabled").map(|s| s.as_str()) != Some("true") {
        return None;
    }
    let app_id = settings.get("feishu_app_id")?.trim().to_string();
    let app_secret = settings.get("feishu_app_secret")?.trim().to_string();
    let receive_id = settings.get("feishu_receive_id")?.trim().to_string();

    if app_id.is_empty() || app_secret.is_empty() || receive_id.is_empty() {
        return None;
    }

    let receive_id_type = settings
        .get("feishu_receive_id_type")
        .cloned()
        .unwrap_or_else(|| "open_id".to_string());

    Some(FeishuConfig { app_id, app_secret, receive_id_type, receive_id })
}

// ── Card builders ─────────────────────────────────────────────────────────────

/// 任务完成卡片（绿色 header）。
///
/// Fields: 任务标题、工作目录、耗时、文件改动数、token 用量，
/// note 提示"回到电脑查看 diff 并验收"。
pub fn card_completed(
    title: &str,
    workdir: &str,
    elapsed_secs: u64,
    file_count: i64,
    input_tokens: u64,
    output_tokens: u64,
) -> serde_json::Value {
    let elapsed_str = fmt_elapsed(elapsed_secs);
    json!({
        "header": {
            "title": { "tag": "plain_text", "content": format!("✅ 任务完成：{}", title) },
            "template": "green"
        },
        "elements": [
            {
                "tag": "div",
                "fields": [
                    {
                        "is_short": true,
                        "text": {
                            "tag": "lark_md",
                            "content": format!("**工作目录**\n{}", workdir)
                        }
                    },
                    {
                        "is_short": true,
                        "text": {
                            "tag": "lark_md",
                            "content": format!("**耗时**\n{}", elapsed_str)
                        }
                    }
                ]
            },
            {
                "tag": "div",
                "fields": [
                    {
                        "is_short": true,
                        "text": {
                            "tag": "lark_md",
                            "content": format!("**文件改动**\n{} 个", file_count)
                        }
                    },
                    {
                        "is_short": true,
                        "text": {
                            "tag": "lark_md",
                            "content": format!("**Token 用量**\n输入 {} / 输出 {}", input_tokens, output_tokens)
                        }
                    }
                ]
            },
            {
                "tag": "note",
                "elements": [
                    { "tag": "plain_text", "content": "回到电脑查看 diff 并验收" }
                ]
            }
        ]
    })
}

/// 任务失败卡片（红色 header）。错误摘要截取前 200 字。
pub fn card_failed(title: &str, error_summary: &str) -> serde_json::Value {
    let summary: String = error_summary.chars().take(200).collect();
    json!({
        "header": {
            "title": { "tag": "plain_text", "content": format!("❌ 任务失败：{}", title) },
            "template": "red"
        },
        "elements": [
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": format!("**错误摘要**\n```\n{}\n```", summary)
                }
            }
        ]
    })
}

/// 测试卡片（蓝色 header）。
pub fn card_test() -> serde_json::Value {
    json!({
        "header": {
            "title": { "tag": "plain_text", "content": "AgentBoard 通知测试成功" },
            "template": "blue"
        },
        "elements": [
            {
                "tag": "note",
                "elements": [
                    {
                        "tag": "plain_text",
                        "content": "飞书推送配置正常，任务完成/失败时将自动通知。"
                    }
                ]
            }
        ]
    })
}

fn fmt_elapsed(secs: u64) -> String {
    let m = secs / 60;
    let s = secs % 60;
    if m > 0 {
        format!("{} 分 {} 秒", m, s)
    } else {
        format!("{} 秒", s)
    }
}

// ── Send ──────────────────────────────────────────────────────────────────────

/// Send an interactive card message via Feishu IM API v1.
pub async fn send_card(config: &FeishuConfig, card: serde_json::Value) -> Result<(), String> {
    let token = get_token(&config.app_id, &config.app_secret).await?;

    let card_str =
        serde_json::to_string(&card).map_err(|e| format!("card serialize error: {e}"))?;

    let body = json!({
        "receive_id": config.receive_id,
        "msg_type": "interactive",
        "content": card_str
    });

    let url = format!(
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={}",
        config.receive_id_type
    );

    let client = build_client()?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("send_message request failed: {e}"))?;

    let resp_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("send_message response parse error: {e}"))?;

    let code = resp_json["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        return Err(format!(
            "飞书消息发送失败 (code={}): {}",
            code,
            resp_json["msg"].as_str().unwrap_or("unknown")
        ));
    }

    Ok(())
}

/// Fire-and-forget: spawn a tokio task to send `card`, log the result.
/// Errors are written to the ring log; they never panic or block the caller.
pub fn spawn_send(config: FeishuConfig, card: serde_json::Value, label: String) {
    tokio::spawn(async move {
        let result = send_card(&config, card).await;
        let ts = utc_hms();
        let entry = match result {
            Ok(()) => format!("[{}] OK  {}", ts, label),
            Err(e) => format!("[{}] ERR {} — {}", ts, label, e),
        };
        append_log(entry);
    });
}

fn utc_hms() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let day_secs = secs % 86400;
    format!("{:02}:{:02}:{:02}", day_secs / 3600, (day_secs % 3600) / 60, day_secs % 60)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Card JSON structure ───────────────────────────────────────────────────

    #[test]
    fn card_completed_green_header_and_structure() {
        let card = card_completed("测试任务", "/tmp/work", 125, 3, 1000, 500);
        assert_eq!(card["header"]["template"].as_str(), Some("green"));
        let title = card["header"]["title"]["content"].as_str().unwrap();
        assert!(title.contains("测试任务"), "title should include task name");
        let elements = card["elements"].as_array().unwrap();
        assert_eq!(elements.len(), 3, "completed card has 2 divs + 1 note");
        assert_eq!(elements[2]["tag"].as_str(), Some("note"), "last element is note");
        let note_text = elements[2]["elements"][0]["content"].as_str().unwrap();
        assert!(note_text.contains("diff"), "note should reference diff");
    }

    #[test]
    fn card_completed_elapsed_formats_minutes() {
        let card = card_completed("T", "/", 90, 0, 0, 0);
        let fields = card["elements"][0]["fields"].as_array().unwrap();
        let elapsed_content = fields[1]["text"]["content"].as_str().unwrap();
        assert!(elapsed_content.contains("分"), "90s should show minutes");
    }

    #[test]
    fn card_failed_red_header_truncates_error() {
        let long_err = "e".repeat(300);
        let card = card_failed("失败任务", &long_err);
        assert_eq!(card["header"]["template"].as_str(), Some("red"));
        let content = card["elements"][0]["text"]["content"].as_str().unwrap();
        // The 'e' portion should be at most 200 chars (plus surrounding markdown)
        let e_count = content.chars().filter(|&c| c == 'e').count();
        assert!(e_count <= 200, "error summary should be truncated to 200 chars: got {}", e_count);
    }

    #[test]
    fn card_test_blue_header() {
        let card = card_test();
        assert_eq!(card["header"]["template"].as_str(), Some("blue"));
        assert_eq!(
            card["header"]["title"]["content"].as_str(),
            Some("AgentBoard 通知测试成功")
        );
    }

    // ── Config loading ────────────────────────────────────────────────────────

    #[test]
    fn load_config_disabled_returns_none() {
        let mut s = HashMap::new();
        s.insert("feishu_enabled".to_string(), "false".to_string());
        s.insert("feishu_app_id".to_string(), "id".to_string());
        s.insert("feishu_app_secret".to_string(), "sec".to_string());
        s.insert("feishu_receive_id".to_string(), "ou_x".to_string());
        assert!(load_config(&s).is_none(), "disabled → None");
    }

    #[test]
    fn load_config_missing_fields_returns_none() {
        let mut s = HashMap::new();
        s.insert("feishu_enabled".to_string(), "true".to_string());
        // no app_id, app_secret, receive_id
        assert!(load_config(&s).is_none(), "missing required fields → None");
    }

    #[test]
    fn load_config_blank_fields_returns_none() {
        let mut s = HashMap::new();
        s.insert("feishu_enabled".to_string(), "true".to_string());
        s.insert("feishu_app_id".to_string(), "   ".to_string());
        s.insert("feishu_app_secret".to_string(), "sec".to_string());
        s.insert("feishu_receive_id".to_string(), "ou_x".to_string());
        assert!(load_config(&s).is_none(), "blank app_id → None");
    }

    #[test]
    fn load_config_complete_returns_some() {
        let mut s = HashMap::new();
        s.insert("feishu_enabled".to_string(), "true".to_string());
        s.insert("feishu_app_id".to_string(), "cli_abc".to_string());
        s.insert("feishu_app_secret".to_string(), "secret_xyz".to_string());
        s.insert("feishu_receive_id".to_string(), "ou_zzz".to_string());
        s.insert("feishu_receive_id_type".to_string(), "open_id".to_string());
        let cfg = load_config(&s).expect("complete config → Some");
        assert_eq!(cfg.app_id, "cli_abc");
        assert_eq!(cfg.receive_id_type, "open_id");
    }

    #[test]
    fn load_config_defaults_to_open_id_type() {
        let mut s = HashMap::new();
        s.insert("feishu_enabled".to_string(), "true".to_string());
        s.insert("feishu_app_id".to_string(), "id".to_string());
        s.insert("feishu_app_secret".to_string(), "sec".to_string());
        s.insert("feishu_receive_id".to_string(), "ou_x".to_string());
        // no receive_id_type
        let cfg = load_config(&s).expect("should be Some");
        assert_eq!(cfg.receive_id_type, "open_id", "should default to open_id");
    }

    // ── Token cache ───────────────────────────────────────────────────────────

    #[test]
    fn token_store_empty_initially() {
        let store = TokenStore::new();
        assert!(store.get_cached().is_none(), "fresh store should be empty");
    }

    #[test]
    fn token_store_returns_token_within_ttl() {
        let store = TokenStore::new();
        // TTL 7200s → buffer 7200-300=6900s still in the future
        store.store("tok_valid".to_string(), 7200);
        assert_eq!(store.get_cached().as_deref(), Some("tok_valid"));
    }

    #[test]
    fn token_store_expired_when_ttl_le_buffer() {
        let store = TokenStore::new();
        // TTL 200s → saturating_sub(300) = 0 → expires_at = now + 0 → already past
        store.store("tok_dead".to_string(), 200);
        // A few CPU cycles have passed since store(), so now > expires_at.
        assert!(
            store.get_cached().is_none(),
            "token with TTL ≤ 300 s (buffer) should be treated as expired"
        );
    }

    #[test]
    fn token_store_second_store_replaces_first() {
        let store = TokenStore::new();
        store.store("tok_first".to_string(), 7200);
        store.store("tok_second".to_string(), 7200);
        assert_eq!(store.get_cached().as_deref(), Some("tok_second"));
    }

    // ── Notification gate (feishu disabled → load_config returns None) ────────

    #[test]
    fn feishu_disabled_load_config_returns_none_so_no_spawn() {
        // When feishu_enabled is "false", load_config returns None.
        // The caller in make_emit_fn_with_db only calls spawn_send when
        // load_config returns Some — so zero HTTP calls are made.
        let settings = HashMap::new(); // empty → feishu_enabled not "true"
        assert!(
            load_config(&settings).is_none(),
            "no feishu_enabled=true → zero notifications spawned"
        );
    }
}
