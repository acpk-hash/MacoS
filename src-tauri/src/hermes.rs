//! 远端 Hermes Agent 接入（app 侧）。
//!
//! Hermes（github.com/NousResearch/hermes-agent，MIT）是一个开源远端 agent，
//! 部署在用户自己的服务器上并暴露 OpenAI 兼容 API（默认端口 8642，
//! `/v1/chat/completions` 等）。本模块只负责 app 侧接入：
//!   - 端点配置：复用多服务商体系，Hermes 作为固定 id 的特殊 provider
//!     （[`HERMES_PROVIDER_ID`]）写入 providers 表，因此它自动进入模型聚合
//!     与聊天/工作台的模型下拉；模型名单独存 settings（`hermes_model`）。
//!   - API Key 走 OS 凭据管理器（与其它 provider 相同的 keyring 方案），
//!     但 Hermes 的 API_SERVER 可以不开鉴权，所以 Key 是**可选**的
//!     （providers 层对该 id 放行无 Key 解析，见 providers::resolve_key）。
//!   - 委派处理：`hermes_send` 把任务描述 + 附件（文本内联 / 图片 data URL）
//!     发到配置的 Hermes 端点（流式 chat），deltas 通过 `hermes-event` 推给
//!     前端的「远端 Hermes」面板。请求在远端 Hermes 上执行（带它自己的
//!     记忆 / skills），这就是"远端处理"。
//!
//! 事件通道 `hermes-event` 的载荷：
//!   - { type: "delta", run_id, text }
//!   - { type: "done",  run_id, status, text }   status: complete | stopped
//!   - { type: "error", run_id, message }
//!
//! 安全：Key 永不入库、永不入日志、永不返回前端（只回 has_key + 尾 4 位掩码）。

use crate::engine_config;
use crate::relay::{self, RelayCreds};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

/// Hermes 在 providers 表 / 凭据管理器中的固定 id。
pub(crate) const HERMES_PROVIDER_ID: &str = "hermes-remote";

/// providers 表中的显示名。
const HERMES_LABEL: &str = "远端 Hermes";

/// settings 表里存 Hermes 模型名的 key（留空 = 自动取端点的第一个模型）。
const HERMES_MODEL_KEY: &str = "hermes_model";

/// 未配置端点时的统一提示。
const NOT_CONFIGURED_HINT: &str =
    "尚未配置远端 Hermes：请在 设置 → 远端处理 (Hermes) 中填写端点 URL";

// -- Frontend-facing types -----------------------------------------------------

/// 远端 Hermes 配置状态（不含明文 Key）。
#[derive(Debug, Clone, Serialize)]
pub struct HermesConfig {
    /// 是否已配置端点（providers 表里存在 hermes-remote 行）。
    pub configured: bool,
    pub base_url: String,
    /// Hermes 使用的模型名；空 = 发送时自动取端点 /models 的第一个。
    pub model: String,
    pub enabled: bool,
    pub has_key: bool,
    /// Key 尾 4 位掩码（如 `****e1c2`），未设置时为空。
    pub key_mask: String,
}

// -- Pure helpers（可单测，不碰 keyring / 网络） --------------------------------

/// 选择实际发送的模型：配置了模型名就用它，否则取端点返回的第一个模型。
fn pick_model(configured: &str, listed: &[String]) -> Result<String, String> {
    let m = configured.trim();
    if !m.is_empty() {
        return Ok(m.to_string());
    }
    listed
        .first()
        .cloned()
        .ok_or_else(|| "Hermes 端点未返回模型，请在设置中填写模型名".to_string())
}

/// 把任务描述 + 附件构造成 OpenAI messages 数组（单条 user 消息；文本附件
/// 内联进正文、图片作为 image_url data URL——与工作台聊天完全一致）。
fn build_messages(prompt: &str, attachments: &[crate::studio::Attachment]) -> Vec<Value> {
    vec![json!({
        "role": "user",
        "content": crate::studio::build_user_content(prompt, attachments),
    })]
}

// -- Credential / config resolution ---------------------------------------------

/// 读出 Hermes 的 RelayCreds + 配置的模型名。Key 缺省时用空串（Hermes 可不鉴权）。
/// `require_enabled` 为 false 时允许在禁用状态下测试连接。
fn hermes_creds(db: &crate::db::Db, require_enabled: bool) -> Result<(RelayCreds, String), String> {
    let row = db
        .provider_get(HERMES_PROVIDER_ID)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| NOT_CONFIGURED_HINT.to_string())?;
    if require_enabled && !row.enabled {
        return Err("远端 Hermes 已被禁用，请在 设置 → 远端处理 (Hermes) 中启用".to_string());
    }
    let key = crate::providers::key_get(HERMES_PROVIDER_ID)?
        .filter(|k| !k.trim().is_empty())
        .unwrap_or_default();
    let model = db
        .settings_get(HERMES_MODEL_KEY)
        .ok()
        .flatten()
        .unwrap_or_default();
    Ok((RelayCreds::new(row.base_url, key, "chat".to_string()), model))
}

/// 失效聚合模型缓存（Hermes 配置变更后，模型下拉需要重新聚合）。
fn invalidate_models_cache(state: &crate::AppState) {
    *state.studio.providers_models_cache.lock().unwrap() = None;
}

/// Emit a `hermes-event`（错误静默）。
fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit("hermes-event", payload);
}

// -- Tauri commands --------------------------------------------------------------

/// 读取远端 Hermes 配置（不含明文 Key）。
#[tauri::command]
pub(crate) async fn hermes_config_get(
    state: State<'_, crate::AppState>,
) -> Result<HermesConfig, String> {
    let row = state
        .db
        .provider_get(HERMES_PROVIDER_ID)
        .map_err(|e| e.to_string())?;
    let model = state
        .db
        .settings_get(HERMES_MODEL_KEY)
        .ok()
        .flatten()
        .unwrap_or_default();
    Ok(match row {
        Some(r) => {
            let mask = match crate::providers::key_get(HERMES_PROVIDER_ID) {
                Ok(Some(k)) if !k.trim().is_empty() => engine_config::mask_key(&k),
                _ => String::new(),
            };
            HermesConfig {
                configured: true,
                base_url: r.base_url,
                model,
                enabled: r.enabled,
                has_key: !mask.is_empty(),
                key_mask: mask,
            }
        }
        None => HermesConfig {
            configured: false,
            base_url: String::new(),
            model,
            enabled: false,
            has_key: false,
            key_mask: String::new(),
        },
    })
}

/// 保存远端 Hermes 配置。`key` 语义：None = 不修改；空串 = 清除；其余 = 覆盖。
#[tauri::command]
pub(crate) async fn hermes_config_set(
    base_url: String,
    model: String,
    key: Option<String>,
    enabled: bool,
    state: State<'_, crate::AppState>,
) -> Result<(), String> {
    let url = base_url.trim().to_string();
    if url.is_empty() {
        return Err("请填写 Hermes 端点 URL（如 http://your-host:8642/v1）".to_string());
    }
    state
        .db
        .provider_upsert(HERMES_PROVIDER_ID, HERMES_LABEL, &url, "chat", enabled)
        .map_err(|e| e.to_string())?;
    state
        .db
        .settings_set(HERMES_MODEL_KEY, model.trim())
        .map_err(|e| e.to_string())?;
    if let Some(k) = key {
        let k = k.trim();
        if k.is_empty() {
            crate::providers::key_delete(HERMES_PROVIDER_ID)?;
            state
                .db
                .provider_set_has_key(HERMES_PROVIDER_ID, false)
                .map_err(|e| e.to_string())?;
        } else {
            crate::providers::key_set(HERMES_PROVIDER_ID, k)?;
            state
                .db
                .provider_set_has_key(HERMES_PROVIDER_ID, true)
                .map_err(|e| e.to_string())?;
        }
    }
    invalidate_models_cache(&state);
    Ok(())
}

/// 测试连接：请求端点 `/v1/models`，返回成功/失败与耗时（禁用状态也可测）。
#[tauri::command]
pub(crate) async fn hermes_test(
    state: State<'_, crate::AppState>,
) -> Result<engine_config::TestResult, String> {
    let start = Instant::now();
    let (creds, _model) = match hermes_creds(&state.db, false) {
        Ok(v) => v,
        Err(e) => {
            return Ok(engine_config::TestResult {
                success: false,
                message: e,
                elapsed_ms: start.elapsed().as_millis() as u64,
            })
        }
    };
    let result = relay::list_models(&creds).await;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(match result {
        Ok(models) => engine_config::TestResult {
            success: true,
            message: format!(
                "Hermes 端点连通成功，返回 {} 个模型（耗时 {}ms）",
                models.len(),
                elapsed_ms
            ),
            elapsed_ms,
        },
        Err(e) => engine_config::TestResult {
            success: false,
            message: format!(
                "Hermes 端点连通失败（耗时 {}ms）: {}。请确认服务器上 Hermes 的 API 服务已启动（默认端口 8642）",
                elapsed_ms, e
            ),
            elapsed_ms,
        },
    })
}

/// 把任务描述 + 附件委派给远端 Hermes（流式）。deltas 走 `hermes-event`；
/// 返回最终完整文本。面板是单并发的：新请求会先取消上一个在途请求。
#[tauri::command]
pub(crate) async fn hermes_send(
    prompt: String,
    attachments: Vec<crate::studio::Attachment>,
    state: State<'_, crate::AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let (creds, configured_model) = hermes_creds(&state.db, true)?;

    // 模型名：优先设置里的；留空则取端点 /models 的第一个。
    let model = if configured_model.trim().is_empty() {
        let listed = relay::list_models(&creds)
            .await
            .map_err(|e| format!("获取 Hermes 模型失败: {e}"))?;
        pick_model("", &listed)?
    } else {
        pick_model(&configured_model, &[])?
    };

    let messages = build_messages(&prompt, &attachments);

    // 单并发：登记新 token 前先取消旧请求。
    let cancel = CancellationToken::new();
    {
        let mut guard = state.studio.hermes_cancel.lock().unwrap();
        if let Some(prev) = guard.take() {
            prev.cancel();
        }
        *guard = Some(cancel.clone());
    }

    let run_id = uuid::Uuid::new_v4().to_string();
    let app_cb = app.clone();
    let rid = run_id.clone();
    let outcome = relay::chat_stream(&creds, &model, messages, cancel, move |delta| {
        emit(
            &app_cb,
            json!({ "type": "delta", "run_id": rid, "text": delta }),
        );
    })
    .await;

    // 清掉自己的 token（若已被新请求替换则保留新 token）。
    {
        let mut guard = state.studio.hermes_cancel.lock().unwrap();
        if guard.is_some() {
            guard.take();
        }
    }

    match outcome {
        Ok(o) => {
            let status = if o.stopped { "stopped" } else { "complete" };
            emit(
                &app,
                json!({ "type": "done", "run_id": run_id, "status": status, "text": o.text }),
            );
            Ok(o.text)
        }
        Err(e) => {
            emit(
                &app,
                json!({ "type": "error", "run_id": run_id, "message": e }),
            );
            Err(e)
        }
    }
}

/// 取消在途的 Hermes 请求（部分回复由前端保留展示）。
#[tauri::command]
pub(crate) async fn hermes_stop(state: State<'_, crate::AppState>) -> Result<(), String> {
    if let Some(tok) = state.studio.hermes_cancel.lock().unwrap().take() {
        tok.cancel();
    }
    Ok(())
}

// -- Unit tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::studio::Attachment;

    #[test]
    fn pick_model_prefers_configured_name() {
        let listed = vec!["Hermes-4-405B".to_string()];
        assert_eq!(pick_model("hermes-custom", &listed).unwrap(), "hermes-custom");
        assert_eq!(pick_model("  padded  ", &[]).unwrap(), "padded");
    }

    #[test]
    fn pick_model_falls_back_to_first_listed() {
        let listed = vec!["Hermes-4-405B".to_string(), "Hermes-4-70B".to_string()];
        assert_eq!(pick_model("", &listed).unwrap(), "Hermes-4-405B");
        assert_eq!(pick_model("   ", &listed).unwrap(), "Hermes-4-405B");
    }

    #[test]
    fn pick_model_errors_when_nothing_available() {
        let err = pick_model("", &[]).unwrap_err();
        assert!(err.contains("模型名"), "should tell the user to fill a model: {err}");
    }

    #[test]
    fn build_messages_single_user_message_plain() {
        let msgs = build_messages("整理这份日志", &[]);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "整理这份日志");
    }

    #[test]
    fn build_messages_inlines_text_and_image_attachments() {
        let atts = vec![
            Attachment {
                kind: "text".to_string(),
                name: Some("app.log".to_string()),
                data_url: None,
                text: Some("ERROR boom".to_string()),
            },
            Attachment {
                kind: "image".to_string(),
                name: Some("shot.png".to_string()),
                data_url: Some("data:image/png;base64,AAAA".to_string()),
                text: None,
            },
        ];
        let msgs = build_messages("分析附件", &atts);
        assert_eq!(msgs.len(), 1);
        let parts = msgs[0]["content"].as_array().expect("content parts");
        assert_eq!(parts.len(), 2);
        let text = parts[0]["text"].as_str().unwrap();
        assert!(text.contains("分析附件"));
        assert!(text.contains("app.log"));
        assert!(text.contains("ERROR boom"));
        assert_eq!(parts[1]["type"], "image_url");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,AAAA");
    }

    #[test]
    fn hermes_creds_missing_row_hints_settings() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let err = hermes_creds(&db, true).unwrap_err();
        assert!(err.contains("远端 Hermes"), "should point at settings: {err}");
    }

    /// 禁用时：require_enabled=true 报错，false（测试连接）放行。
    /// 注：此测试可能读取真实凭据管理器中 hermes-remote 的 Key（只读，不写）。
    #[test]
    fn hermes_creds_respects_enabled_flag() {
        let db = crate::db::Db::open_in_memory().unwrap();
        db.provider_upsert(
            HERMES_PROVIDER_ID,
            HERMES_LABEL,
            "http://h.example.com:8642/v1",
            "chat",
            false,
        )
        .unwrap();
        let err = hermes_creds(&db, true).unwrap_err();
        assert!(err.contains("禁用"), "disabled must be reported: {err}");
        let (creds, model) = hermes_creds(&db, false).expect("test path allows disabled");
        assert_eq!(creds.base_url, "http://h.example.com:8642/v1");
        assert_eq!(creds.wire_api, "chat");
        assert_eq!(model, "");
    }
}
