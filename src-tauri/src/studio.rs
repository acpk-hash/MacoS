//! Tauri command layer for the multimodal studio (chat + image generation).
//!
//! All API traffic goes through `crate::relay` (reqwest, credentials from the
//! Codex config/auth files). Streaming chat deltas and media completion are
//! pushed to the frontend on the `studio-event` channel; the shapes are:
//!   - { type: "delta",         session_id, message_id, text }
//!   - { type: "done",          session_id, message_id, status, text }
//!   - { type: "error",         session_id, message_id, message }
//!   - { type: "media_running", id }
//!   - { type: "media_done",    id, kind, local_path, source_url }
//!   - { type: "media_failed",  id, error }

use crate::db::{ChatMessageRow, ChatSessionRow, GenMediaRow};
use crate::relay;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

/// Models cache time-to-live.
const MODELS_TTL: Duration = Duration::from_secs(300);

// -- Shared studio state -----------------------------------------------------

/// Per-app studio state: caches + in-flight chat cancellation tokens.
pub struct StudioState {
    models_cache: Mutex<Option<(Instant, Vec<String>)>>,
    video_cache: Mutex<Option<bool>>,
    cancels: Mutex<HashMap<String, CancellationToken>>,
    /// Per-provider model/status cache (see `providers::providers_models_status`;
    /// the aggregated `providers_models` list is derived from it).
    pub(crate) providers_models_cache:
        Mutex<Option<(Instant, Vec<crate::providers::ProviderModels>)>>,
}

impl StudioState {
    pub fn new() -> Self {
        Self {
            models_cache: Mutex::new(None),
            video_cache: Mutex::new(None),
            cancels: Mutex::new(HashMap::new()),
            providers_models_cache: Mutex::new(None),
        }
    }
}

impl Default for StudioState {
    fn default() -> Self {
        Self::new()
    }
}

// -- Input / output payloads -------------------------------------------------

/// A composer attachment: an image (as a data URL) or an inlined text file.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Attachment {
    /// "image" | "text"
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
    /// For images: a `data:image/...;base64,...` URL.
    #[serde(default)]
    pub data_url: Option<String>,
    /// For text files: the inlined content.
    #[serde(default)]
    pub text: Option<String>,
}

/// Runtime capability probe result.
#[derive(Debug, Clone, Serialize)]
pub struct Capabilities {
    pub video: bool,
}

// -- Models & capabilities ---------------------------------------------------

/// Return the relay model id list, cached in memory for `MODELS_TTL`.
#[tauri::command]
pub(crate) async fn studio_models(
    state: State<'_, crate::AppState>,
) -> Result<Vec<String>, String> {
    {
        let guard = state.studio.models_cache.lock().unwrap();
        if let Some((at, models)) = guard.as_ref() {
            if at.elapsed() < MODELS_TTL {
                return Ok(models.clone());
            }
        }
    }
    let creds = crate::providers::resolve_creds(&state.db, None)?;
    let models = relay::list_models(&creds).await?;
    *state.studio.models_cache.lock().unwrap() = Some((Instant::now(), models.clone()));
    Ok(models)
}

/// Probe runtime capabilities (currently: video endpoint presence). Cached.
#[tauri::command]
pub(crate) async fn studio_capabilities(
    state: State<'_, crate::AppState>,
) -> Result<Capabilities, String> {
    {
        let guard = state.studio.video_cache.lock().unwrap();
        if let Some(v) = *guard {
            return Ok(Capabilities { video: v });
        }
    }
    let creds = crate::providers::resolve_creds(&state.db, None)?;
    let video = relay::probe_video(&creds).await.unwrap_or(false);
    *state.studio.video_cache.lock().unwrap() = Some(video);
    Ok(Capabilities { video })
}

// -- Chat sessions -----------------------------------------------------------

#[tauri::command]
pub(crate) async fn chat_sessions_list(
    state: State<'_, crate::AppState>,
) -> Result<Vec<ChatSessionRow>, String> {
    state.db.chat_sessions_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn chat_sessions_create(
    title: Option<String>,
    model: String,
    state: State<'_, crate::AppState>,
) -> Result<ChatSessionRow, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let title = title.unwrap_or_default();
    state
        .db
        .chat_session_create(&id, &title, &model)
        .map_err(|e| e.to_string())?;
    state.sync.notify_snapshot();
    state
        .db
        .chat_session_get(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "创建会话后未能读回".to_string())
}

#[tauri::command]
pub(crate) async fn chat_sessions_rename(
    session_id: String,
    title: String,
    state: State<'_, crate::AppState>,
) -> Result<(), String> {
    state
        .db
        .chat_session_rename(&session_id, &title)
        .map_err(|e| e.to_string())?;
    state.sync.notify_snapshot();
    Ok(())
}

#[tauri::command]
pub(crate) async fn chat_sessions_delete(
    session_id: String,
    state: State<'_, crate::AppState>,
) -> Result<(), String> {
    state
        .db
        .chat_session_delete(&session_id)
        .map_err(|e| e.to_string())?;
    state.sync.notify_snapshot();
    Ok(())
}

/// Delete a single chat message from its session.
#[tauri::command]
pub(crate) async fn chat_message_delete(
    message_id: String,
    state: State<'_, crate::AppState>,
) -> Result<(), String> {
    state
        .db
        .chat_message_delete(&message_id)
        .map_err(|e| e.to_string())?;
    state.sync.notify_snapshot();
    Ok(())
}

#[tauri::command]
pub(crate) async fn chat_messages_list(
    session_id: String,
    state: State<'_, crate::AppState>,
) -> Result<Vec<ChatMessageRow>, String> {
    state
        .db
        .chat_messages_list(&session_id)
        .map_err(|e| e.to_string())
}

// -- Chat send / stop --------------------------------------------------------

/// Persist the user message, stream the assistant reply (emitting `studio-event`
/// deltas), and persist the finalized assistant message. Returns the assistant
/// message id. If the session has no title yet, the first user message sets it.
#[tauri::command]
pub(crate) async fn chat_send(
    session_id: String,
    user_content: String,
    attachments: Vec<Attachment>,
    model: String,
    provider_id: Option<String>,
    state: State<'_, crate::AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let db = state.db.clone();

    // Ensure the session exists (create lazily so the frontend can send without
    // an explicit create step).
    if db
        .chat_session_get(&session_id)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        db.chat_session_create(&session_id, "", &model)
            .map_err(|e| e.to_string())?;
    }

    // Persist the user message.
    let user_msg_id = uuid::Uuid::new_v4().to_string();
    let atts_json = if attachments.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&attachments).map_err(|e| e.to_string())?)
    };
    db.chat_message_insert(
        &user_msg_id,
        &session_id,
        "user",
        &user_content,
        atts_json.as_deref(),
        Some(&model),
        "complete",
    )
    .map_err(|e| e.to_string())?;

    // Auto-title from the first user message (only when title is still empty).
    let _ = db.chat_session_set_title_if_empty(&session_id, &title_from(&user_content));
    let _ = db.chat_session_touch(&session_id);
    // Push the new user message (+ streaming placeholder) to the phone.
    state.sync.notify_snapshot();

    // Build the OpenAI messages array from full history.
    let history = db
        .chat_messages_list(&session_id)
        .map_err(|e| e.to_string())?;
    let messages = build_messages(&history);

    // Insert the streaming assistant placeholder.
    let assistant_id = uuid::Uuid::new_v4().to_string();
    db.chat_message_insert(
        &assistant_id,
        &session_id,
        "assistant",
        "",
        None,
        Some(&model),
        "streaming",
    )
    .map_err(|e| e.to_string())?;

    // Register a cancellation token for this session.
    let cancel = CancellationToken::new();
    state
        .studio
        .cancels
        .lock()
        .unwrap()
        .insert(session_id.clone(), cancel.clone());

    // Load credentials for the selected provider (falling back to the default
    // provider, then the legacy ~/.codex config). Failure still clears the placeholder.
    let creds = match crate::providers::resolve_creds(db.as_ref(), provider_id.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            state.studio.cancels.lock().unwrap().remove(&session_id);
            let _ = db.chat_message_update(&assistant_id, "", "error");
            emit(
                &app,
                json!({
                    "type": "error", "session_id": session_id,
                    "message_id": assistant_id, "message": e,
                }),
            );
            return Err(e);
        }
    };

    // Stream.
    let app_cb = app.clone();
    let sid_cb = session_id.clone();
    let mid_cb = assistant_id.clone();
    let outcome = relay::chat_stream(&creds, &model, messages, cancel.clone(), move |delta| {
        emit(
            &app_cb,
            json!({
                "type": "delta", "session_id": sid_cb,
                "message_id": mid_cb, "text": delta,
            }),
        );
    })
    .await;

    // Always clear the cancellation token.
    state.studio.cancels.lock().unwrap().remove(&session_id);

    match outcome {
        Ok(o) => {
            let status = if o.stopped { "stopped" } else { "complete" };
            let _ = db.chat_message_update(&assistant_id, &o.text, status);
            let _ = db.chat_session_touch(&session_id);
            state.sync.notify_snapshot();
            emit(
                &app,
                json!({
                    "type": "done", "session_id": session_id,
                    "message_id": assistant_id, "status": status, "text": o.text,
                }),
            );
            Ok(assistant_id)
        }
        Err(e) => {
            let _ = db.chat_message_update(&assistant_id, "", "error");
            emit(
                &app,
                json!({
                    "type": "error", "session_id": session_id,
                    "message_id": assistant_id, "message": e,
                }),
            );
            Err(e)
        }
    }
}

/// Cancel the in-flight stream for a session (partial reply is saved as
/// `status = stopped` by `chat_send`).
#[tauri::command]
pub(crate) async fn chat_stop(
    session_id: String,
    state: State<'_, crate::AppState>,
) -> Result<(), String> {
    if let Some(tok) = state.studio.cancels.lock().unwrap().get(&session_id) {
        tok.cancel();
    }
    Ok(())
}

// -- Image generation --------------------------------------------------------

/// Generate `n` images. Inserts one `gen_media` row per requested image
/// (status = running), calls the relay, then marks each row done/failed and
/// emits a `studio-event`. Returns the created media row ids.
#[tauri::command]
pub(crate) async fn image_generate(
    prompt: String,
    model: String,
    size: String,
    n: u32,
    provider_id: Option<String>,
    state: State<'_, crate::AppState>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    let db = state.db.clone();
    let n = n.clamp(1, 10);
    let params = json!({ "size": size, "n": n }).to_string();

    // Pre-create running rows so the UI can show placeholders immediately.
    let mut ids: Vec<String> = Vec::new();
    for _ in 0..n {
        let id = uuid::Uuid::new_v4().to_string();
        db.gen_media_insert(&id, "image", &prompt, &model, Some(&params), "running")
            .map_err(|e| e.to_string())?;
        emit(&app, json!({ "type": "media_running", "id": id }));
        ids.push(id);
    }

    let creds = match crate::providers::resolve_creds(db.as_ref(), provider_id.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            fail_all(&db, &app, &ids, &e);
            return Err(e);
        }
    };

    match relay::generate_image(&creds, &model, &prompt, &size, n).await {
        Ok(images) => {
            for (i, id) in ids.iter().enumerate() {
                if let Some(img) = images.get(i) {
                    let _ = db.gen_media_mark_done(id, &img.local_path, img.source_url.as_deref());
                    emit(
                        &app,
                        json!({
                            "type": "media_done", "id": id, "kind": "image",
                            "local_path": img.local_path, "source_url": img.source_url,
                        }),
                    );
                } else {
                    let msg = "未返回该张图像";
                    let _ = db.gen_media_mark_failed(id, msg);
                    emit(
                        &app,
                        json!({ "type": "media_failed", "id": id, "error": msg }),
                    );
                }
            }
            Ok(ids)
        }
        Err(e) => {
            fail_all(&db, &app, &ids, &e);
            Err(e)
        }
    }
}

/// Second-pass edit of an existing generated image. Reads the source image off
/// disk, sends it (plus an optional brush `mask`) to the relay's edits endpoint
/// together with the user's edit `prompt`, and stores the result as a NEW
/// `gen_media` row whose `params_json` records `source_media_id` for provenance.
///
/// If the edits endpoint turns out to be unavailable (HTTP 404/405/501), it
/// falls back to a plain `images/generations` call with the edit instruction
/// folded into the prompt. The annotated composite cannot be attached in that
/// mode — it is the documented downgrade path. `annotated_data_url` is accepted
/// for forward-compatibility and recorded in `params_json`.
#[tauri::command]
pub(crate) async fn image_edit(
    source_media_id: String,
    model: String,
    prompt: String,
    mask_data_url: Option<String>,
    annotated_data_url: Option<String>,
    provider_id: Option<String>,
    state: State<'_, crate::AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let db = state.db.clone();

    let source = db
        .gen_media_get(&source_media_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "找不到原图记录".to_string())?;
    let src_path = source
        .local_path
        .clone()
        .ok_or_else(|| "原图文件缺失".to_string())?;
    let image_bytes = std::fs::read(&src_path).map_err(|e| format!("读取原图失败: {e}"))?;

    // Size follows the source image (fallback to a square default).
    let size = source
        .params_json
        .as_deref()
        .and_then(|p| serde_json::from_str::<Value>(p).ok())
        .and_then(|v| v.get("size").and_then(|s| s.as_str()).map(String::from))
        .unwrap_or_else(|| "1024x1024".to_string());

    let has_mask = mask_data_url.is_some();
    let has_annotation = annotated_data_url.is_some();
    let mask_bytes = match mask_data_url.as_deref() {
        Some(u) => Some(decode_data_url(u)?),
        None => None,
    };

    let params = json!({
        "size": size,
        "source_media_id": source_media_id,
        "edit": true,
        "mask": has_mask,
        "annotated": has_annotation,
    })
    .to_string();

    let id = uuid::Uuid::new_v4().to_string();
    db.gen_media_insert(&id, "image", &prompt, &model, Some(&params), "running")
        .map_err(|e| e.to_string())?;
    emit(&app, json!({ "type": "media_running", "id": id }));

    let creds = match crate::providers::resolve_creds(db.as_ref(), provider_id.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            let _ = db.gen_media_mark_failed(&id, &e);
            emit(&app, json!({ "type": "media_failed", "id": id, "error": e }));
            return Err(e);
        }
    };

    // Primary path: multipart edits endpoint.
    let mut result = relay::edit_image(&creds, &model, &prompt, &size, image_bytes, mask_bytes).await;

    // Downgrade path: if edits is not available, regenerate from a fused prompt.
    if let Err(e) = &result {
        if edits_unavailable(e) {
            let fused = format!(
                "{prompt}\n\n（请参考原图进行上述修改；原图描述：{}）",
                source.prompt
            );
            result = relay::generate_image(&creds, &model, &fused, &size, 1).await;
        }
    }

    match result {
        Ok(images) => {
            if let Some(img) = images.into_iter().next() {
                let _ = db.gen_media_mark_done(&id, &img.local_path, img.source_url.as_deref());
                emit(
                    &app,
                    json!({
                        "type": "media_done", "id": id, "kind": "image",
                        "local_path": img.local_path, "source_url": img.source_url,
                    }),
                );
                Ok(id)
            } else {
                let msg = "编辑未返回图像";
                let _ = db.gen_media_mark_failed(&id, msg);
                emit(&app, json!({ "type": "media_failed", "id": id, "error": msg }));
                Err(msg.to_string())
            }
        }
        Err(e) => {
            let _ = db.gen_media_mark_failed(&id, &e);
            emit(&app, json!({ "type": "media_failed", "id": id, "error": e }));
            Err(e)
        }
    }
}

/// Decode a `data:<mime>;base64,<payload>` URL into raw bytes.
fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let comma = data_url.find(',').ok_or_else(|| "非法 data URL".to_string())?;
    let payload = &data_url[comma + 1..];
    base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("标注数据解码失败: {e}"))
}

/// Heuristic: does this relay error string indicate the edits endpoint is absent
/// (as opposed to a transient/content error)? Used to decide whether to fall
/// back to the generations endpoint.
fn edits_unavailable(err: &str) -> bool {
    err.contains("HTTP 404") || err.contains("HTTP 405") || err.contains("HTTP 501")
}

// -- Media library -----------------------------------------------------------

#[tauri::command]
pub(crate) async fn media_list(
    kind: Option<String>,
    state: State<'_, crate::AppState>,
) -> Result<Vec<GenMediaRow>, String> {
    state
        .db
        .gen_media_list(kind.as_deref())
        .map_err(|e| e.to_string())
}

/// Delete a media record and its local file (best-effort on the file).
#[tauri::command]
pub(crate) async fn media_delete(
    id: String,
    state: State<'_, crate::AppState>,
) -> Result<(), String> {
    if let Some(path) = state
        .db
        .gen_media_get_local_path(&id)
        .map_err(|e| e.to_string())?
    {
        let _ = std::fs::remove_file(&path);
    }
    state.db.gen_media_delete(&id).map_err(|e| e.to_string())
}

/// Copy a media file from `src` to `dest`, validating the source exists first.
/// Factored out of `media_export` so the copy logic is unit-testable without a
/// live `AppState`/DB.
fn copy_media_to(src: &str, dest: &str) -> Result<(), String> {
    if !std::path::Path::new(src).exists() {
        return Err(format!("源文件不存在：{src}"));
    }
    std::fs::copy(src, dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Export a generated media file to a user-chosen destination path (a real
/// "save as"). Validates the id exists and still has a local file, then copies
/// the bytes to `dest_path`.
#[tauri::command]
pub(crate) async fn media_export(
    id: String,
    dest_path: String,
    state: State<'_, crate::AppState>,
) -> Result<(), String> {
    let src = state
        .db
        .gen_media_get_local_path(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "找不到该媒体，或文件已被删除".to_string())?;
    copy_media_to(&src, &dest_path)
}

/// Write a UTF-8 text file to a user-chosen path. Used by the chat export
/// feature (.md / .html). The frontend never writes to disk directly; it picks
/// a path via the dialog plugin and hands the fully-rendered content here.
#[tauri::command]
pub(crate) async fn export_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

// -- Helpers -----------------------------------------------------------------

/// Emit a `studio-event` (errors are non-fatal and swallowed).
fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit("studio-event", payload);
}

/// Mark every id as failed and emit the corresponding events.
fn fail_all(db: &crate::db::Db, app: &AppHandle, ids: &[String], err: &str) {
    for id in ids {
        let _ = db.gen_media_mark_failed(id, err);
        emit(
            app,
            json!({ "type": "media_failed", "id": id, "error": err }),
        );
    }
}

/// Derive a short session title from the first user message.
fn title_from(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    let s: String = line.chars().take(40).collect();
    if s.is_empty() {
        "新对话".to_string()
    } else {
        s
    }
}

/// Build the OpenAI `messages` array from stored chat rows. User messages with
/// attachments are expanded into content parts (text + image_url data URLs);
/// empty assistant placeholders are skipped.
fn build_messages(rows: &[ChatMessageRow]) -> Vec<Value> {
    let mut msgs = Vec::new();
    for r in rows {
        match r.role.as_str() {
            "user" => {
                let atts: Vec<Attachment> = r
                    .attachments_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();
                let content = build_user_content(&r.content, &atts);
                msgs.push(json!({ "role": "user", "content": content }));
            }
            "assistant" => {
                if !r.content.is_empty() {
                    msgs.push(json!({ "role": "assistant", "content": r.content }));
                }
            }
            other => {
                msgs.push(json!({ "role": other, "content": r.content }));
            }
        }
    }
    msgs
}

/// Build the `content` field for a user message. Returns a plain string when
/// there are no attachments, otherwise an array of OpenAI content parts.
fn build_user_content(text: &str, attachments: &[Attachment]) -> Value {
    if attachments.is_empty() {
        return Value::String(text.to_string());
    }

    // Inline any text-file attachments into the text part.
    let mut combined = text.to_string();
    for a in attachments {
        if a.kind == "text" {
            if let Some(t) = &a.text {
                let name = a.name.clone().unwrap_or_else(|| "file".to_string());
                combined.push_str(&format!("\n\n[附件 {name}]\n{t}"));
            }
        }
    }

    let mut parts: Vec<Value> = Vec::new();
    if !combined.trim().is_empty() {
        parts.push(json!({ "type": "text", "text": combined }));
    }
    for a in attachments {
        if a.kind == "image" {
            if let Some(url) = &a.data_url {
                parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
            }
        }
    }

    // Fall back to a bare string if nothing usable was produced.
    if parts.is_empty() {
        Value::String(text.to_string())
    } else {
        Value::Array(parts)
    }
}

// -- Unit tests --------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_media_to_copies_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.png");
        std::fs::write(&src, b"pngbytes").unwrap();
        let dest = dir.path().join("out.png");
        copy_media_to(src.to_str().unwrap(), dest.to_str().unwrap()).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"pngbytes");
    }

    #[test]
    fn copy_media_to_errors_on_missing_source() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.png");
        let dest = dir.path().join("out.png");
        let err = copy_media_to(missing.to_str().unwrap(), dest.to_str().unwrap())
            .unwrap_err();
        assert!(err.contains("源文件不存在"));
        assert!(!dest.exists());
    }

    #[test]
    fn title_from_truncates_first_line() {
        assert_eq!(title_from("hello world"), "hello world");
        let long = "x".repeat(80);
        assert_eq!(title_from(&long).chars().count(), 40);
        assert_eq!(title_from("  first\nsecond"), "first");
        assert_eq!(title_from("   "), "新对话");
    }

    #[test]
    fn build_user_content_plain_string_without_attachments() {
        let v = build_user_content("hi", &[]);
        assert_eq!(v, Value::String("hi".to_string()));
    }

    #[test]
    fn build_user_content_image_parts() {
        let atts = vec![Attachment {
            kind: "image".to_string(),
            name: None,
            data_url: Some("data:image/png;base64,AAAA".to_string()),
            text: None,
        }];
        let v = build_user_content("look", &atts);
        let arr = v.as_array().expect("should be array");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(arr[0]["text"], "look");
        assert_eq!(arr[1]["type"], "image_url");
        assert_eq!(arr[1]["image_url"]["url"], "data:image/png;base64,AAAA");
    }

    #[test]
    fn build_user_content_text_file_inlined() {
        let atts = vec![Attachment {
            kind: "text".to_string(),
            name: Some("notes.txt".to_string()),
            data_url: None,
            text: Some("file body".to_string()),
        }];
        let v = build_user_content("summarize", &atts);
        let arr = v.as_array().expect("array");
        assert_eq!(arr.len(), 1);
        let text = arr[0]["text"].as_str().unwrap();
        assert!(text.contains("summarize"));
        assert!(text.contains("notes.txt"));
        assert!(text.contains("file body"));
    }

    #[test]
    fn decode_data_url_roundtrips_base64_payload() {
        // "hi" -> base64 "aGk="
        let bytes = decode_data_url("data:image/png;base64,aGk=").unwrap();
        assert_eq!(bytes, b"hi");
    }

    #[test]
    fn decode_data_url_rejects_missing_comma() {
        assert!(decode_data_url("data:image/png;base64").is_err());
    }

    #[test]
    fn edits_unavailable_matches_only_endpoint_errors() {
        assert!(edits_unavailable("图像编辑 HTTP 404: not found"));
        assert!(edits_unavailable("图像编辑 HTTP 405: method"));
        assert!(!edits_unavailable("图像编辑 HTTP 400: bad prompt"));
        assert!(!edits_unavailable("图像编辑 HTTP 500: server"));
    }

    #[test]
    fn build_messages_skips_empty_assistant_placeholder() {
        let rows = vec![
            ChatMessageRow {
                id: "a".into(),
                session_id: "s".into(),
                role: "user".into(),
                content: "hi".into(),
                attachments_json: None,
                model: None,
                status: "complete".into(),
                created_at: 1,
            },
            ChatMessageRow {
                id: "b".into(),
                session_id: "s".into(),
                role: "assistant".into(),
                content: "".into(),
                attachments_json: None,
                model: None,
                status: "streaming".into(),
                created_at: 2,
            },
        ];
        let msgs = build_messages(&rows);
        assert_eq!(msgs.len(), 1, "empty assistant placeholder is skipped");
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "hi");
    }
}
