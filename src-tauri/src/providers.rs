//! Multi-provider model configuration.
//!
//! Users can register several OpenAI-compatible services (each with its own
//! `base_url` + API key). This module owns:
//!   - provider metadata CRUD (delegated to the SQLite `providers` table)
//!   - API-key storage in the **OS credential store** (keyring), never SQLite
//!   - per-provider model listing + connectivity tests
//!   - aggregation of every enabled provider's models for the studio pickers
//!
//! The providers table is the **single source of truth** for credentials.
//! There is deliberately no fallback to the legacy `~/.codex` config: that
//! hidden second credential source used to shadow the user's real settings
//! (a dead relay seeded at install time masked every fix the user made).
//!
//! Security model
//! --------------
//! The API key is written to the Windows Credential Manager (keyring service
//! `agentboard`, account = provider id). It is **never** stored in SQLite, never
//! logged, and never returned to the frontend — the UI only ever receives a
//! `has_key` boolean and a tail-4 mask (e.g. `****e1c2`).

use crate::db::{Db, ProviderRow};
use crate::engine_config;
use crate::relay::{self, RelayCreds};
use serde::Serialize;
use std::time::Instant;
use tauri::State;

/// Credential-store service name (the "vault" all provider keys live under).
const KEYRING_SERVICE: &str = "agentboard";

/// Setting key holding the id of the fallback/default provider.
const DEFAULT_PROVIDER_KEY: &str = "default_provider_id";

/// Aggregated-models cache TTL.
const MODELS_TTL: std::time::Duration = std::time::Duration::from_secs(300);

/// User-facing hint when no usable provider is configured at all.
const NO_PROVIDER_HINT: &str =
    "未配置可用的服务商：请在 设置 → 服务商 中添加服务并填写 API Key";

// -- Frontend-facing types ---------------------------------------------------

/// A provider as shown in Settings — metadata + key *status* only (no plaintext).
#[derive(Debug, Clone, Serialize)]
pub struct ProviderInfo {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub wire_api: String,
    pub enabled: bool,
    /// Whether an API key is stored for this provider.
    pub has_key: bool,
    /// Tail-4 mask of the stored key (e.g. `****e1c2`), empty when none.
    pub key_mask: String,
    /// Whether this is the default (fallback) provider.
    pub is_default: bool,
}

/// One (provider, model) pair for the aggregated studio pickers.
#[derive(Debug, Clone, Serialize)]
pub struct AggModel {
    pub provider_id: String,
    pub provider_label: String,
    pub model_id: String,
    /// Usage class: `"chat"` | `"image"` | `"video"`. Non-usable ids
    /// (embeddings / audio / review bots) never appear here.
    pub kind: String,
}

/// One model id with its usage classification.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderModelEntry {
    pub id: String,
    /// `"chat"` | `"image"` | `"video"` | `"other"` (non-conversational).
    pub kind: String,
}

/// Per-provider model listing **with status**. A failing provider is reported
/// (HTTP code + response snippet) instead of being silently skipped, so the
/// frontend can show exactly which provider is broken and why.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderModels {
    pub provider_id: String,
    pub provider_label: String,
    /// True when the model list was fetched successfully.
    pub ok: bool,
    pub models: Vec<ProviderModelEntry>,
    /// Error description when `ok == false` (never contains the API key).
    pub error: Option<String>,
}

// -- Keyring (OS credential store) -------------------------------------------

fn entry(provider_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, provider_id).map_err(|e| format!("凭据管理器打开失败: {e}"))
}

/// Store (or overwrite) the API key for a provider in the OS credential store.
pub fn key_set(provider_id: &str, key: &str) -> Result<(), String> {
    entry(provider_id)?
        .set_password(key)
        .map_err(|e| format!("凭据写入失败: {e}"))
}

/// Read the API key for a provider from the OS credential store.
/// Returns `Ok(None)` when no key is stored (rather than an error).
pub fn key_get(provider_id: &str) -> Result<Option<String>, String> {
    match entry(provider_id)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("凭据读取失败: {e}")),
    }
}

/// Delete a provider's API key from the OS credential store (no-op if absent).
pub fn key_delete(provider_id: &str) -> Result<(), String> {
    match entry(provider_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("凭据删除失败: {e}")),
    }
}

// -- Credential resolution ---------------------------------------------------

/// Build relay credentials for a specific provider (base_url + stored key).
fn creds_for_provider(db: &Db, provider_id: &str) -> Result<RelayCreds, String> {
    let row = db
        .provider_get(provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("服务商不存在: {provider_id}"))?;
    let key = key_get(provider_id)?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| "该服务商未设置 API Key".to_string())?;
    Ok(RelayCreds::new(row.base_url, key, row.wire_api))
}

/// Resolve credentials for a chat/image call. Resolution order:
///   1. an explicit `provider_id` (the picker's selection)
///   2. the configured default provider — only when it is **enabled and has a
///      key**; otherwise a descriptive error is returned.
///
/// There is intentionally NO legacy `~/.codex` fallback: the providers table
/// is the single source of truth, and errors surface instead of being masked
/// by a stale second credential source.
pub fn resolve_creds(db: &Db, provider_id: Option<&str>) -> Result<RelayCreds, String> {
    if let Some(pid) = provider_id.filter(|p| !p.trim().is_empty()) {
        return creds_for_provider(db, pid);
    }
    let def = db
        .settings_get(DEFAULT_PROVIDER_KEY)
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| NO_PROVIDER_HINT.to_string())?;
    let row = db
        .provider_get(&def)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| NO_PROVIDER_HINT.to_string())?;
    if !row.enabled {
        return Err(format!(
            "默认服务商「{}」已被禁用，请在设置中启用它或更换默认服务商",
            row.label
        ));
    }
    let key = key_get(&row.id)?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| format!("默认服务商「{}」未设置 API Key，请在设置中填写", row.label))?;
    Ok(RelayCreds::new(row.base_url, key, row.wire_api))
}

/// Invalidate the aggregated-models cache (after any provider mutation).
fn invalidate_models_cache(state: &crate::AppState) {
    *state.studio.providers_models_cache.lock().unwrap() = None;
}

/// Ensure a default provider id is recorded when the table becomes non-empty.
fn ensure_default(db: &Db, candidate: &str) {
    let cur = db.settings_get(DEFAULT_PROVIDER_KEY).ok().flatten();
    if cur.as_deref().map(str::trim).unwrap_or("").is_empty() {
        let _ = db.settings_set(DEFAULT_PROVIDER_KEY, candidate);
    }
}

// -- Model classification ------------------------------------------------------

/// Classify a model id by usage. Conservative denylist: only ids that are
/// clearly non-conversational (embeddings, audio, review bots, ...) are marked
/// `"other"`; image/video generators get their own class so the media pages
/// can still offer them; everything else is `"chat"`.
pub(crate) fn classify_model(id: &str) -> &'static str {
    let l = id.to_ascii_lowercase();
    const NON_CHAT: [&str; 8] = [
        "auto-review",
        "embedding",
        "embed-",
        "whisper",
        "tts",
        "rerank",
        "moderation",
        "transcribe",
    ];
    if NON_CHAT.iter().any(|m| l.contains(m)) {
        return "other";
    }
    if l.contains("sora") || l.contains("video") || l.contains("veo-") {
        return "video";
    }
    if l.contains("image")
        || l.contains("dall-e")
        || l.contains("dalle")
        || l.contains("flux")
        || l.contains("midjourney")
    {
        return "image";
    }
    "chat"
}

// -- Helpers ------------------------------------------------------------------

fn to_info(row: ProviderRow, default_id: &Option<String>) -> ProviderInfo {
    let mask = match key_get(&row.id) {
        Ok(Some(k)) => engine_config::mask_key(&k),
        _ => String::new(),
    };
    ProviderInfo {
        is_default: default_id.as_deref() == Some(row.id.as_str()),
        id: row.id,
        label: row.label,
        base_url: row.base_url,
        wire_api: row.wire_api,
        enabled: row.enabled,
        has_key: row.has_key,
        key_mask: mask,
    }
}

/// Fetch the model list of every *enabled* provider, reporting per-provider
/// success/failure instead of silently dropping the failures.
async fn collect_providers_models(db: &Db) -> Result<Vec<ProviderModels>, String> {
    let rows = db.providers_list().map_err(|e| e.to_string())?;
    let mut out: Vec<ProviderModels> = Vec::new();
    for row in rows.into_iter().filter(|r| r.enabled) {
        let mut status = ProviderModels {
            provider_id: row.id.clone(),
            provider_label: row.label.clone(),
            ok: false,
            models: Vec::new(),
            error: None,
        };
        let key = match key_get(&row.id) {
            Ok(Some(k)) if !k.trim().is_empty() => k,
            Ok(_) => {
                status.error = Some("未设置 API Key".to_string());
                out.push(status);
                continue;
            }
            Err(e) => {
                status.error = Some(e);
                out.push(status);
                continue;
            }
        };
        let creds = RelayCreds::new(row.base_url.clone(), key, row.wire_api.clone());
        match relay::list_models(&creds).await {
            Ok(models) => {
                status.ok = true;
                status.models = models
                    .into_iter()
                    .map(|id| ProviderModelEntry {
                        kind: classify_model(&id).to_string(),
                        id,
                    })
                    .collect();
            }
            Err(e) => status.error = Some(e),
        }
        out.push(status);
    }
    Ok(out)
}

/// Flatten per-provider statuses into the aggregated picker list, dropping
/// providers that failed and model ids classified as non-usable (`"other"`).
fn agg_from_status(status: &[ProviderModels]) -> Vec<AggModel> {
    let mut out = Vec::new();
    for p in status.iter().filter(|p| p.ok) {
        for m in p.models.iter().filter(|m| m.kind != "other") {
            out.push(AggModel {
                provider_id: p.provider_id.clone(),
                provider_label: p.provider_label.clone(),
                model_id: m.id.clone(),
                kind: m.kind.clone(),
            });
        }
    }
    out
}

/// Cached wrapper around [`collect_providers_models`] (TTL `MODELS_TTL`;
/// invalidated on every provider mutation).
async fn providers_models_cached(
    state: &crate::AppState,
) -> Result<Vec<ProviderModels>, String> {
    {
        let guard = state.studio.providers_models_cache.lock().unwrap();
        if let Some((at, status)) = guard.as_ref() {
            if at.elapsed() < MODELS_TTL {
                return Ok(status.clone());
            }
        }
    }
    let out = collect_providers_models(&state.db).await?;
    *state.studio.providers_models_cache.lock().unwrap() = Some((Instant::now(), out.clone()));
    Ok(out)
}

// -- Tauri commands -----------------------------------------------------------

/// List all providers with key status + mask (never plaintext).
#[tauri::command]
pub(crate) async fn providers_list(
    state: State<'_, crate::AppState>,
) -> Result<Vec<ProviderInfo>, String> {
    let rows = state.db.providers_list().map_err(|e| e.to_string())?;
    let default_id = state.db.settings_get(DEFAULT_PROVIDER_KEY).ok().flatten();
    Ok(rows
        .into_iter()
        .map(|r| to_info(r, &default_id))
        .collect())
}

/// Create (when `id` is `None`) or update a provider's metadata. Returns its id.
#[tauri::command]
pub(crate) async fn provider_upsert(
    id: Option<String>,
    label: String,
    base_url: String,
    wire_api: String,
    enabled: bool,
    state: State<'_, crate::AppState>,
) -> Result<String, String> {
    let id = id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let wire = if wire_api == "responses" { "responses" } else { "chat" };
    state
        .db
        .provider_upsert(&id, label.trim(), base_url.trim(), wire, enabled)
        .map_err(|e| e.to_string())?;
    ensure_default(&state.db, &id);
    invalidate_models_cache(&state);
    Ok(id)
}

/// Set (or clear, when empty) a provider's API key in the credential store.
/// The plaintext key is used only within this call — never persisted to SQLite.
#[tauri::command]
pub(crate) async fn provider_set_key(
    id: String,
    key: String,
    state: State<'_, crate::AppState>,
) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        key_delete(&id)?;
        state
            .db
            .provider_set_has_key(&id, false)
            .map_err(|e| e.to_string())?;
    } else {
        key_set(&id, trimmed)?;
        state
            .db
            .provider_set_has_key(&id, true)
            .map_err(|e| e.to_string())?;
    }
    invalidate_models_cache(&state);
    Ok(())
}

/// Delete a provider (metadata row + credential-store key).
#[tauri::command]
pub(crate) async fn provider_delete(
    id: String,
    state: State<'_, crate::AppState>,
) -> Result<(), String> {
    let _ = key_delete(&id);
    state.db.provider_delete(&id).map_err(|e| e.to_string())?;
    // If this was the default, fall back to the first remaining provider (if any).
    if state.db.settings_get(DEFAULT_PROVIDER_KEY).ok().flatten().as_deref() == Some(id.as_str()) {
        let next = state
            .db
            .providers_list()
            .ok()
            .and_then(|v| v.into_iter().next())
            .map(|r| r.id)
            .unwrap_or_default();
        let _ = state.db.settings_set(DEFAULT_PROVIDER_KEY, &next);
    }
    invalidate_models_cache(&state);
    Ok(())
}

/// Connectivity test: resolve the provider's creds and hit `/v1/models`.
#[tauri::command]
pub(crate) async fn provider_test(
    id: String,
    state: State<'_, crate::AppState>,
) -> Result<engine_config::TestResult, String> {
    let start = Instant::now();
    let creds = match creds_for_provider(&state.db, &id) {
        Ok(c) => c,
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
            message: format!("连通成功，返回 {} 个模型（耗时 {}ms）", models.len(), elapsed_ms),
            elapsed_ms,
        },
        Err(e) => engine_config::TestResult {
            success: false,
            message: format!("连通失败（耗时 {}ms）: {}", elapsed_ms, e),
            elapsed_ms,
        },
    })
}

/// Aggregate the usable models of every *enabled* provider that has a key
/// (cached for `MODELS_TTL`). Failed providers contribute no models here —
/// use [`providers_models_status`] to see which providers failed and why.
#[tauri::command]
pub(crate) async fn providers_models(
    state: State<'_, crate::AppState>,
) -> Result<Vec<AggModel>, String> {
    let status = providers_models_cached(&state).await?;
    Ok(agg_from_status(&status))
}

/// Per-provider model listing **with status** — success means a classified
/// model list, failure carries the actual error (HTTP code + response
/// snippet). Shares the cache with [`providers_models`].
#[tauri::command]
pub(crate) async fn providers_models_status(
    state: State<'_, crate::AppState>,
) -> Result<Vec<ProviderModels>, String> {
    providers_models_cached(&state).await
}

// -- Unit tests --------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Serializes tests that touch the real OS credential store. The Windows
    /// Credential Manager is racy under heavy concurrent access, which can make
    /// a just-written key transiently unreadable; running these tests one at a
    /// time keeps them deterministic. `into_inner` ignores poisoning from a
    /// panicking sibling test.
    static KEYRING_TEST_LOCK: StdMutex<()> = StdMutex::new(());

    // Keyring round-trip against the real OS credential store. Uses a random
    // account so it never collides with a real provider id, and cleans up.
    #[test]
    fn keyring_set_get_delete_roundtrip() {
        let _guard = KEYRING_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let id = format!("agentboard-test-{}", uuid::Uuid::new_v4());
        let secret = "sk-roundtrip-abcd1234";

        // Absent initially.
        assert_eq!(key_get(&id).unwrap(), None, "no key before set");

        // Set + read back the exact secret.
        key_set(&id, secret).expect("set_password");
        assert_eq!(key_get(&id).unwrap().as_deref(), Some(secret));

        // Mask never contains the full secret.
        let mask = engine_config::mask_key(secret);
        assert!(mask.ends_with("1234"));
        assert!(!mask.contains("roundtrip"));

        // Delete → absent again; deleting twice is a no-op (Ok).
        key_delete(&id).expect("delete");
        assert_eq!(key_get(&id).unwrap(), None, "key gone after delete");
        key_delete(&id).expect("delete is idempotent");
    }

    #[test]
    fn resolve_creds_prefers_explicit_then_default() {
        let _guard = KEYRING_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let db = Db::open_in_memory().unwrap();
        let pid = format!("p-{}", uuid::Uuid::new_v4());
        db.provider_upsert(&pid, "L", "https://explicit.example.com", "chat", true)
            .unwrap();
        key_set(&pid, "sk-explicit").unwrap();

        let creds = resolve_creds(&db, Some(&pid)).expect("explicit provider resolves");
        assert_eq!(creds.base_url, "https://explicit.example.com");
        assert_eq!(creds.wire_api, "chat");

        // Same provider as the configured default also resolves.
        db.settings_set(DEFAULT_PROVIDER_KEY, &pid).unwrap();
        let creds = resolve_creds(&db, None).expect("default provider resolves");
        assert_eq!(creds.base_url, "https://explicit.example.com");

        key_delete(&pid).ok();
    }

    /// No explicit provider + no default configured means a descriptive error,
    /// NOT a silent fallback to `~/.codex` (the legacy fallback is gone).
    #[test]
    fn resolve_creds_without_default_errors_no_legacy_fallback() {
        let db = Db::open_in_memory().unwrap();
        let err = resolve_creds(&db, None).unwrap_err();
        assert!(
            err.contains("服务商"),
            "should ask the user to configure a provider: {err}"
        );
    }

    /// A disabled default provider is rejected with a descriptive error rather
    /// than silently shadowed by another credential source.
    #[test]
    fn resolve_creds_disabled_default_errors() {
        let db = Db::open_in_memory().unwrap();
        db.provider_upsert("dis", "已停用中继", "https://x.com", "chat", false)
            .unwrap();
        db.settings_set(DEFAULT_PROVIDER_KEY, "dis").unwrap();
        let err = resolve_creds(&db, None).unwrap_err();
        assert!(err.contains("禁用"), "should mention it is disabled: {err}");
    }

    /// An enabled default provider without a key errors descriptively.
    #[test]
    fn resolve_creds_default_without_key_errors() {
        let _guard = KEYRING_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let db = Db::open_in_memory().unwrap();
        let pid = format!("nk-{}", uuid::Uuid::new_v4());
        db.provider_upsert(&pid, "NoKey", "https://x.com", "chat", true)
            .unwrap();
        db.settings_set(DEFAULT_PROVIDER_KEY, &pid).unwrap();
        let err = resolve_creds(&db, None).unwrap_err();
        assert!(err.contains("API Key"), "should mention the missing key: {err}");
    }

    #[test]
    fn creds_for_provider_errors_without_key() {
        let _guard = KEYRING_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let db = Db::open_in_memory().unwrap();
        db.provider_upsert("nokey", "L", "https://x.com", "responses", true)
            .unwrap();
        let err = creds_for_provider(&db, "nokey").unwrap_err();
        assert!(err.contains("API Key"), "should complain about missing key: {err}");
    }

    #[test]
    fn classify_model_denylist_and_kinds() {
        // Chat models must never be misclassified.
        assert_eq!(classify_model("gpt-5.5"), "chat");
        assert_eq!(classify_model("claude-sonnet-4-5"), "chat");
        assert_eq!(classify_model("deepseek-v3"), "chat");
        assert_eq!(classify_model("o3-mini"), "chat");
        // Junk observed in the wild.
        assert_eq!(classify_model("codex-auto-review"), "other");
        assert_eq!(classify_model("text-embedding-3-large"), "other");
        assert_eq!(classify_model("whisper-1"), "other");
        assert_eq!(classify_model("gpt-4o-mini-tts"), "other");
        assert_eq!(classify_model("omni-moderation-latest"), "other");
        // Media generators keep their own class (still usable on media pages).
        assert_eq!(classify_model("gpt-image-2"), "image");
        assert_eq!(classify_model("dall-e-3"), "image");
        assert_eq!(classify_model("flux-1.1-pro"), "image");
        assert_eq!(classify_model("sora-2"), "video");
    }

    #[test]
    fn agg_from_status_drops_failures_and_junk() {
        let status = vec![
            ProviderModels {
                provider_id: "ok".into(),
                provider_label: "OK 中继".into(),
                ok: true,
                models: vec![
                    ProviderModelEntry { id: "gpt-5.5".into(), kind: "chat".into() },
                    ProviderModelEntry { id: "gpt-image-2".into(), kind: "image".into() },
                    ProviderModelEntry { id: "codex-auto-review".into(), kind: "other".into() },
                ],
                error: None,
            },
            ProviderModels {
                provider_id: "dead".into(),
                provider_label: "死中继".into(),
                ok: false,
                models: vec![],
                error: Some("模型列表 HTTP 401: unauthorized".into()),
            },
        ];
        let agg = agg_from_status(&status);
        assert_eq!(agg.len(), 2, "junk id and dead provider dropped");
        assert!(agg.iter().all(|m| m.provider_id == "ok"));
        assert!(agg.iter().any(|m| m.model_id == "gpt-5.5" && m.kind == "chat"));
        assert!(agg.iter().any(|m| m.model_id == "gpt-image-2" && m.kind == "image"));
    }

    /// A provider whose key is missing shows up as an explicit failure in the
    /// status list instead of vanishing (the old "silent skip → empty list").
    #[tokio::test]
    async fn collect_reports_missing_key_as_error() {
        let db = Db::open_in_memory().unwrap();
        db.provider_upsert("nk", "无Key服务", "https://x.example.com", "chat", true)
            .unwrap();
        let status = collect_providers_models(&db).await.unwrap();
        assert_eq!(status.len(), 1);
        assert!(!status[0].ok);
        assert!(status[0].error.as_deref().unwrap().contains("API Key"));
        assert!(status[0].models.is_empty());
    }

    // -- Live tests (network; run with -- --ignored --nocapture) --------------
    //
    // Credentials come from env vars so no secret ever lands in the repo:
    //   AB_LIVE_BASE_URL  e.g. https://relay.example.com/v1
    //   AB_LIVE_KEY       the real API key

    fn live_env() -> Option<(String, String)> {
        let base = std::env::var("AB_LIVE_BASE_URL").ok()?;
        let key = std::env::var("AB_LIVE_KEY").ok()?;
        Some((base, key))
    }

    /// Live: register a real provider, fetch its models through the status
    /// path, then run a short chat round-trip on the first chat model.
    #[tokio::test]
    #[ignore]
    async fn live_provider_models_and_chat() {
        let _guard = KEYRING_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (base, key) = live_env().expect("set AB_LIVE_BASE_URL / AB_LIVE_KEY");
        let db = Db::open_in_memory().unwrap();
        let pid = format!("live-{}", uuid::Uuid::new_v4());
        db.provider_upsert(&pid, "Live中继", &base, "chat", true).unwrap();
        key_set(&pid, &key).unwrap();

        let status = collect_providers_models(&db).await.unwrap();
        key_delete(&pid).ok();
        assert_eq!(status.len(), 1);
        let s = &status[0];
        println!(
            "[live] ok={} err={:?} models={:?}",
            s.ok,
            s.error,
            s.models
                .iter()
                .map(|m| format!("{}({})", m.id, m.kind))
                .collect::<Vec<_>>()
        );
        assert!(s.ok, "provider should list models: {:?}", s.error);
        assert!(!s.models.is_empty(), "expected at least one model");

        let chat_model = s
            .models
            .iter()
            .find(|m| m.kind == "chat")
            .expect("at least one chat model")
            .id
            .clone();
        let creds = RelayCreds::new(base, key, "chat".into());
        let cancel = tokio_util::sync::CancellationToken::new();
        let outcome = relay::chat_stream(
            &creds,
            &chat_model,
            vec![serde_json::json!({ "role": "user", "content": "Reply with exactly: OK" })],
            cancel,
            |_| {},
        )
        .await
        .expect("chat_stream should succeed");
        println!("[live] chat model={chat_model} reply={:?}", outcome.text);
        assert!(!outcome.text.trim().is_empty(), "expected a non-empty reply");
    }

    /// Live: a bad key must produce an explicit per-provider error (HTTP code
    /// visible), never a silent empty list.
    #[tokio::test]
    #[ignore]
    async fn live_bad_key_yields_explicit_error() {
        let _guard = KEYRING_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (base, _) = live_env().expect("set AB_LIVE_BASE_URL / AB_LIVE_KEY");
        let db = Db::open_in_memory().unwrap();
        let pid = format!("bad-{}", uuid::Uuid::new_v4());
        db.provider_upsert(&pid, "坏Key中继", &base, "chat", true).unwrap();
        key_set(&pid, "sk-definitely-invalid-key-0000").unwrap();

        let status = collect_providers_models(&db).await.unwrap();
        key_delete(&pid).ok();
        assert_eq!(status.len(), 1);
        let s = &status[0];
        println!("[live-bad] ok={} err={:?}", s.ok, s.error);
        assert!(!s.ok, "bad key must fail");
        let err = s.error.as_deref().unwrap_or_default();
        assert!(err.contains("HTTP"), "error should carry the HTTP status: {err}");
        assert!(!err.contains("sk-definitely"), "key must never leak into errors");
    }
}
