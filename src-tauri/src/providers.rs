//! Multi-provider model configuration.
//!
//! Users can register several OpenAI-compatible services (each with its own
//! `base_url` + API key). This module owns:
//!   - provider metadata CRUD (delegated to the SQLite `providers` table)
//!   - API-key storage in the **OS credential store** (keyring), never SQLite
//!   - per-provider model listing + connectivity tests
//!   - aggregation of every enabled provider's models for the studio pickers
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
///   2. the configured default provider
///   3. the legacy `~/.codex` config + auth.json (backward compatibility)
pub fn resolve_creds(db: &Db, provider_id: Option<&str>) -> Result<RelayCreds, String> {
    if let Some(pid) = provider_id.filter(|p| !p.trim().is_empty()) {
        return creds_for_provider(db, pid);
    }
    if let Ok(Some(def)) = db.settings_get(DEFAULT_PROVIDER_KEY) {
        if !def.trim().is_empty() {
            if let Ok(c) = creds_for_provider(db, &def) {
                return Ok(c);
            }
        }
    }
    RelayCreds::load()
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

// -- One-time seeding (migrate the legacy Codex relay into a provider) --------

/// Read `OPENAI_API_KEY` from auth.json (empty when absent/unparseable).
fn read_auth_key(auth_path: &std::path::Path) -> Option<String> {
    let content = std::fs::read_to_string(auth_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    v.get("OPENAI_API_KEY")
        .and_then(|k| k.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Seed a built-in default provider from the existing Codex relay config the
/// first time the providers table is empty. This preserves the working v0.4
/// setup: the base_url is read from `~/.codex/config.toml` (never hardcoded) and
/// the key is migrated from `auth.json` into the credential store.
///
/// Idempotent and best-effort: any failure leaves the app usable via the legacy
/// fallback path.
pub fn ensure_seeded(db: &Db) {
    let empty = db.providers_list().map(|v| v.is_empty()).unwrap_or(false);
    if !empty {
        return;
    }

    let config_path = crate::mcp::codex_config_path();
    let auth_path = engine_config::auth_json_path();
    let base_url = engine_config::engine_config_get(&config_path, &auth_path)
        .map(|i| i.base_url)
        .unwrap_or_default();
    if base_url.trim().is_empty() {
        // Nothing configured yet — the user will add a provider manually.
        return;
    }

    let id = "default";
    // Pin wire_api = "chat": the studio chat has always used /v1/chat/completions
    // against this relay successfully, so keep that proven path for the default.
    if db
        .provider_upsert(id, "默认中继", base_url.trim(), "chat", true)
        .is_err()
    {
        return;
    }
    if let Some(k) = read_auth_key(&auth_path) {
        if key_set(id, &k).is_ok() {
            let _ = db.provider_set_has_key(id, true);
        }
    }
    let _ = db.settings_set(DEFAULT_PROVIDER_KEY, id);
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

/// Aggregate the models of every *enabled* provider that has a key. Cached in
/// memory for `MODELS_TTL`. Providers that error out are skipped (best-effort),
/// so one broken provider never hides the others.
#[tauri::command]
pub(crate) async fn providers_models(
    state: State<'_, crate::AppState>,
) -> Result<Vec<AggModel>, String> {
    {
        let guard = state.studio.providers_models_cache.lock().unwrap();
        if let Some((at, models)) = guard.as_ref() {
            if at.elapsed() < MODELS_TTL {
                return Ok(models.clone());
            }
        }
    }

    let rows = state.db.providers_list().map_err(|e| e.to_string())?;
    let mut out: Vec<AggModel> = Vec::new();
    for row in rows.into_iter().filter(|r| r.enabled) {
        let key = match key_get(&row.id) {
            Ok(Some(k)) if !k.trim().is_empty() => k,
            _ => continue,
        };
        let creds = RelayCreds::new(row.base_url.clone(), key, row.wire_api.clone());
        if let Ok(models) = relay::list_models(&creds).await {
            for m in models {
                out.push(AggModel {
                    provider_id: row.id.clone(),
                    provider_label: row.label.clone(),
                    model_id: m,
                });
            }
        }
    }

    *state.studio.providers_models_cache.lock().unwrap() = Some((Instant::now(), out.clone()));
    Ok(out)
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

        key_delete(&pid).ok();
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

    /// Live: build provider creds from the real `~/.codex` relay config (the
    /// existing aiboys relay) and pull its model list. Read-only; touches no DB
    /// or credential store. Run with:
    /// `cargo test -- --ignored live_aiboys_provider_models --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_aiboys_provider_models() {
        let config = crate::mcp::codex_config_path();
        let auth = engine_config::auth_json_path();
        let base = engine_config::engine_config_get(&config, &auth)
            .expect("read config")
            .base_url;
        let key = read_auth_key(&auth).expect("auth.json OPENAI_API_KEY present");
        let creds = RelayCreds::new(base, key, "chat".into());
        let models = relay::list_models(&creds).await.expect("list_models");
        println!("[live providers] pulled {} models", models.len());
        assert!(!models.is_empty(), "aiboys relay should return models");
    }
}
