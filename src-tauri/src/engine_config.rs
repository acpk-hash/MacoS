/// Engine API configuration management.
///
/// Reads and writes:
///   - `%USERPROFILE%\.codex\config.toml` (model provider, model, reasoning effort)
///   - `%USERPROFILE%\.codex\auth.json`   (API key — written without UTF-8 BOM)
///
/// Style mirrors mcp.rs: toml_edit preserves formatting; backup before every write.
/// The API key is NEVER returned to the frontend as plaintext; only a tail-4
/// mask (e.g. `****e1c2`) and a boolean `has_api_key` are exposed.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use toml_edit::{DocumentMut, Item, Table, value as toml_value};

// ── Public types ──────────────────────────────────────────────────────────────

/// Configuration info returned to the frontend (no plaintext key).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfigInfo {
    pub provider_name: String,
    pub base_url: String,
    pub wire_api: String,
    pub model: String,
    pub model_reasoning_effort: String,
    /// True when auth.json exists and OPENAI_API_KEY is non-empty.
    pub has_api_key: bool,
    /// Last-4-chars mask, e.g. `"****e1c2"`, or empty when no key.
    pub key_mask: String,
}

/// Input from the frontend for updating the engine configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfigInput {
    pub provider_name: String,
    pub base_url: String,
    pub wire_api: String,
    pub model: String,
    pub model_reasoning_effort: String,
    /// When `Some("")` or `None` the auth.json is left untouched.
    pub api_key: Option<String>,
}

/// Result of a connectivity test.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub success: bool,
    pub message: String,
    pub elapsed_ms: u64,
}

// ── Config paths ──────────────────────────────────────────────────────────────

/// `%USERPROFILE%\.codex\auth.json` (Windows) or `$HOME/.codex/auth.json`.
pub fn auth_json_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".codex").join("auth.json")
}

// ── Key masking ───────────────────────────────────────────────────────────────

/// Returns `"****<last4>"`, e.g. `"****e1c2"`.
/// Returns `"****"` when the key is shorter than 4 characters.
/// Returns `""` when the key is empty.
pub fn mask_key(key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        return String::new();
    }
    if key.len() <= 4 {
        return "****".to_string();
    }
    format!("****{}", &key[key.len() - 4..])
}

// ── Get ───────────────────────────────────────────────────────────────────────

/// Read the engine configuration from config.toml and auth.json.
///
/// Returns defaults when either file is absent; never errors on missing files.
/// The API key is NOT returned — only `has_api_key` and `key_mask`.
pub fn engine_config_get(
    config_path: &Path,
    auth_path: &Path,
) -> Result<EngineConfigInfo, String> {
    // Sensible defaults (matching the typical aiboys relay setup).
    let mut provider_name = "OpenAI".to_string();
    let mut base_url = String::new();
    let mut wire_api = "responses".to_string();
    let mut model = "gpt-5.5".to_string();
    let mut model_reasoning_effort = "xhigh".to_string();

    if config_path.exists() {
        let content = std::fs::read_to_string(config_path).map_err(|e| e.to_string())?;
        let doc: DocumentMut =
            content.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;

        if let Some(v) = doc.get("model_provider").and_then(|v| v.as_str()) {
            provider_name = v.to_string();
        }
        if let Some(v) = doc.get("model").and_then(|v| v.as_str()) {
            model = v.to_string();
        }
        if let Some(v) = doc.get("model_reasoning_effort").and_then(|v| v.as_str()) {
            model_reasoning_effort = v.to_string();
        }

        // Look under [model_providers.<provider_name>] for relay settings.
        if let Some(providers_tbl) =
            doc.get("model_providers").and_then(|v| v.as_table())
        {
            if let Some(p) =
                providers_tbl.get(&provider_name).and_then(|v| v.as_table())
            {
                if let Some(v) = p.get("base_url").and_then(|v| v.as_str()) {
                    base_url = v.to_string();
                }
                if let Some(v) = p.get("wire_api").and_then(|v| v.as_str()) {
                    wire_api = v.to_string();
                }
            }
        }
    }

    // Check auth.json — key never returned, only mask + boolean.
    let (has_api_key, key_mask) = read_auth_mask(auth_path)?;

    Ok(EngineConfigInfo {
        provider_name,
        base_url,
        wire_api,
        model,
        model_reasoning_effort,
        has_api_key,
        key_mask,
    })
}

/// Internal: read auth.json and return (has_key, mask).
fn read_auth_mask(auth_path: &Path) -> Result<(bool, String), String> {
    if !auth_path.exists() {
        return Ok((false, String::new()));
    }
    let content = std::fs::read_to_string(auth_path).map_err(|e| e.to_string())?;
    match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(v) => {
            let key = v
                .get("OPENAI_API_KEY")
                .and_then(|k| k.as_str())
                .unwrap_or("");
            if key.is_empty() {
                Ok((false, String::new()))
            } else {
                Ok((true, mask_key(key)))
            }
        }
        // Malformed auth.json → treat as no key (don't surface parse error to UI).
        Err(_) => Ok((false, String::new())),
    }
}

// ── Set ───────────────────────────────────────────────────────────────────────

/// Update engine configuration in config.toml (and optionally auth.json).
///
/// Backs up config.toml to config.toml.bak before any write.
/// auth.json is written only when `cfg.api_key` is `Some(non_empty)`.
/// auth.json is always written without a UTF-8 BOM.
pub fn engine_config_set(
    config_path: &Path,
    auth_path: &Path,
    cfg: EngineConfigInput,
) -> Result<(), String> {
    // ── 1. Backup config.toml ────────────────────────────────────────────────
    if config_path.exists() {
        let bak = bak_path(config_path);
        std::fs::copy(config_path, &bak).map_err(|e| e.to_string())?;
    }

    // ── 2. Parse (or start fresh) ────────────────────────────────────────────
    let content = if config_path.exists() {
        std::fs::read_to_string(config_path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut doc: DocumentMut =
        content.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;

    // ── 3. Update top-level scalar fields ────────────────────────────────────
    // Use get_mut + assign (not doc.insert) so the KEY's prefix decor
    // (e.g., leading comments) is preserved when the key already exists.
    upsert_doc_key(&mut doc, "model_provider", toml_value(cfg.provider_name.clone()));
    upsert_doc_key(&mut doc, "model", toml_value(cfg.model.clone()));
    upsert_doc_key(&mut doc, "review_model", toml_value(cfg.model.clone()));
    upsert_doc_key(
        &mut doc,
        "model_reasoning_effort",
        toml_value(cfg.model_reasoning_effort.clone()),
    );

    // ── 4. Ensure [model_providers] implicit table exists ─────────────────────
    if doc.get("model_providers").is_none() {
        let mut tbl = Table::new();
        tbl.set_implicit(true);
        doc.insert("model_providers", Item::Table(tbl));
    }

    // ── 5. Update [model_providers.<name>] ────────────────────────────────────
    if let Some(providers) = doc
        .get_mut("model_providers")
        .and_then(|v| v.as_table_mut())
    {
        // Insert the sub-table if it doesn't exist.
        if providers.get(cfg.provider_name.as_str()).is_none() {
            providers.insert(
                cfg.provider_name.as_str(),
                Item::Table(Table::new()),
            );
        }
        if let Some(p) = providers
            .get_mut(cfg.provider_name.as_str())
            .and_then(|v| v.as_table_mut())
        {
            p.insert("name", toml_value(cfg.provider_name.clone()));
            p.insert("base_url", toml_value(cfg.base_url.clone()));
            p.insert("wire_api", toml_value(cfg.wire_api.clone()));
            p.insert("requires_openai_auth", toml_value(true));
        }
    }

    // ── 6. Write config.toml ─────────────────────────────────────────────────
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(config_path, doc.to_string()).map_err(|e| e.to_string())?;

    // ── 7. Write auth.json (only when a non-empty key is supplied) ────────────
    if let Some(key) = &cfg.api_key {
        let key = key.trim();
        if !key.is_empty() {
            write_auth_json(auth_path, key)?;
        }
    }

    Ok(())
}

/// Write auth.json with **no** UTF-8 BOM.
///
/// Uses `serde_json::to_string` (pure UTF-8 bytes, no BOM) and
/// `std::fs::write` (raw byte write, no OS-level encoding layer).
fn write_auth_json(auth_path: &Path, api_key: &str) -> Result<(), String> {
    // Security: api_key is only in this local scope — not logged, not stored in SQLite.
    let json_value = serde_json::json!({
        "auth_mode": "apikey",
        "OPENAI_API_KEY": api_key,
        "tokens": null
    });
    let json_str =
        serde_json::to_string_pretty(&json_value).map_err(|e| e.to_string())?;
    let bytes = json_str.as_bytes(); // UTF-8, guaranteed no BOM

    // Defensive check: first byte must be `{` (0x7B), not a BOM byte (0xEF).
    debug_assert_eq!(
        bytes.first(),
        Some(&0x7Bu8),
        "auth.json must not start with a BOM byte"
    );

    if let Some(parent) = auth_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(auth_path, bytes).map_err(|e| e.to_string())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Update a top-level key in the document, preserving any existing prefix
/// decorations (e.g., leading comments) by using `get_mut` + assign rather
/// than `insert`, which discards the key's decor when replacing.
fn upsert_doc_key(doc: &mut DocumentMut, key: &str, new_item: Item) {
    match doc.get_mut(key) {
        Some(existing) => *existing = new_item,
        None => {
            doc.insert(key, new_item);
        }
    }
}

fn bak_path(config_path: &Path) -> PathBuf {
    config_path.with_extension("toml.bak")
}

// ── Connectivity test ─────────────────────────────────────────────────────────

/// Run `codex exec --json … "reply with exactly OK"` in a temp directory.
///
/// Uses `danger-full-access` sandbox so no approval dialog is shown.
/// Times out after 30 seconds.
///
/// Returns a `TestResult` describing success (with elapsed ms) or failure
/// (with raw stderr/stdout).
pub async fn engine_config_test() -> Result<TestResult, String> {
    // Create a throwaway working directory for the test session.
    let tmp_path = std::env::temp_dir().join(format!(
        "agentboard_ectest_{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&tmp_path).map_err(|e| e.to_string())?;

    let start = std::time::Instant::now();

    // Build the codex command — same Windows shim pattern as agent/codex.rs.
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/c", "codex"]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = tokio::process::Command::new("codex");

    cmd.args([
        "exec",
        "--json",
        "-s",
        "danger-full-access",
        "-C",
        tmp_path.to_str().unwrap_or("."),
        "--skip-git-repo-check",
        "-c",
        "model_reasoning_effort=low",
        "reply with exactly OK",
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());

    let timeout_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        cmd.output(),
    )
    .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    // Clean up temp dir (best-effort).
    let _ = std::fs::remove_dir_all(&tmp_path);

    match timeout_result {
        Err(_) => Ok(TestResult {
            success: false,
            message: format!("超时（30 秒），已耗时 {}ms", elapsed_ms),
            elapsed_ms,
        }),
        Ok(Err(e)) => Ok(TestResult {
            success: false,
            message: format!("启动 codex 失败: {}", e),
            elapsed_ms,
        }),
        Ok(Ok(output)) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let (model_name, reply_text) = extract_info_from_ndjson(&stdout);

                let mut msg = format!("连通成功（耗时 {}ms）", elapsed_ms);
                if let Some(m) = &model_name {
                    msg = format!("连通成功（模型: {}，耗时 {}ms）", m, elapsed_ms);
                }
                if let Some(t) = &reply_text {
                    let trimmed = t.trim();
                    if !trimmed.is_empty() {
                        msg = format!("{}\n响应: {}", msg, trimmed);
                    }
                }

                Ok(TestResult {
                    success: true,
                    message: msg,
                    elapsed_ms,
                })
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
                let stdout_str = String::from_utf8_lossy(&output.stdout).into_owned();
                // Prefer stderr for error messages; fall back to stdout.
                let raw = if stderr.trim().is_empty() {
                    stdout_str
                } else {
                    stderr
                };
                Ok(TestResult {
                    success: false,
                    message: format!(
                        "连通失败（耗时 {}ms）:\n{}",
                        elapsed_ms,
                        raw.trim()
                    ),
                    elapsed_ms,
                })
            }
        }
    }
}

/// Parse NDJSON output from `codex exec --json` and extract:
/// - model name (from any JSON line with a `"model"` field)
/// - assistant reply text (from `item.completed` + `item.type == "agent_message"`)
fn extract_info_from_ndjson(stdout: &str) -> (Option<String>, Option<String>) {
    let mut model_name: Option<String> = None;
    let mut reply_text: Option<String> = None;

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        // Top-level "model" field (some codex versions include it).
        if model_name.is_none() {
            if let Some(m) = v.get("model").and_then(|m| m.as_str()) {
                model_name = Some(m.to_string());
            }
        }

        // item.completed events carry the assistant message text.
        if v.get("type").and_then(|t| t.as_str()) == Some("item.completed") {
            if let Some(item) = v.get("item") {
                if item.get("type").and_then(|t| t.as_str()) == Some("agent_message") {
                    if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                        reply_text = Some(t.to_string());
                    }
                }
            }
        }

        // usage events sometimes carry model info.
        if v.get("type").and_then(|t| t.as_str()) == Some("turn.completed") {
            if let Some(usage) = v.get("usage") {
                if let Some(m) = usage.get("model").and_then(|m| m.as_str()) {
                    if model_name.is_none() {
                        model_name = Some(m.to_string());
                    }
                }
            }
        }
    }

    (model_name, reply_text)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::TempDir;

    fn write_file(dir: &Path, name: &str, content: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, content).unwrap();
        p
    }

    // ── mask_key ─────────────────────────────────────────────────────────────

    #[test]
    fn mask_key_empty_returns_empty() {
        assert_eq!(mask_key(""), "");
    }

    #[test]
    fn mask_key_short_returns_stars() {
        assert_eq!(mask_key("ab"), "****");
    }

    #[test]
    fn mask_key_normal_shows_last_four() {
        let key = "sk-d0312350946e751222c34ba101a2adfcf78e627bfb6751794e2086129276e1c2";
        let m = mask_key(key);
        assert!(m.starts_with("****"), "mask should start with ****");
        assert!(m.ends_with("e1c2"), "mask should end with last 4 chars");
        assert_eq!(m, "****e1c2");
        // Original key must not appear in the mask.
        assert!(!m.contains("sk-d031"), "key prefix must not be in mask");
    }

    // ── engine_config_get: missing files ─────────────────────────────────────

    #[test]
    fn get_missing_files_returns_defaults() {
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("nonexistent_config.toml");
        let auth = tmp.path().join("nonexistent_auth.json");
        let info = engine_config_get(&config, &auth).unwrap();
        // Defaults must be populated; no panic on missing files.
        assert_eq!(info.provider_name, "OpenAI");
        assert_eq!(info.model, "gpt-5.5");
        assert_eq!(info.wire_api, "responses");
        assert!(!info.has_api_key);
        assert_eq!(info.key_mask, "");
    }

    // ── auth.json no-BOM ─────────────────────────────────────────────────────

    #[test]
    fn auth_json_written_without_bom() {
        let tmp = TempDir::new().unwrap();
        let auth_path = tmp.path().join("auth.json");
        write_auth_json(&auth_path, "sk-testkey1234abcd").unwrap();

        // Read raw bytes and assert the first byte is `{` (0x7B), not a BOM.
        let bytes = std::fs::read(&auth_path).unwrap();
        assert_eq!(
            bytes.first(),
            Some(&0x7Bu8),
            "auth.json must start with '{{', not a UTF-8 BOM (0xEF)"
        );
        assert_ne!(bytes.first(), Some(&0xEFu8), "no BOM byte allowed");

        // Also verify it round-trips as valid JSON with the right key.
        let v: serde_json::Value =
            serde_json::from_slice(&bytes).expect("auth.json must be valid JSON");
        assert_eq!(
            v.get("OPENAI_API_KEY").and_then(|k| k.as_str()),
            Some("sk-testkey1234abcd")
        );
        assert_eq!(
            v.get("auth_mode").and_then(|k| k.as_str()),
            Some("apikey")
        );
    }

    // ── engine_config_set: preserves format & creates backup ─────────────────

    #[test]
    fn set_preserves_existing_sections_and_creates_backup() {
        let tmp = TempDir::new().unwrap();
        // Config with comments, an existing provider, and an mcp_servers section.
        let original = r#"# This comment must survive
model_provider = "OpenAI"
model = "gpt-5.5"
review_model = "gpt-5.5"
model_reasoning_effort = "xhigh"
disable_response_storage = true

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://old.example.com"
wire_api = "responses"
requires_openai_auth = true

[mcp_servers.myserver]
command = "npx"
args = ["-y", "some-mcp"]
"#;
        let config_path = write_file(tmp.path(), "config.toml", original);
        let auth_path = tmp.path().join("auth.json");

        let cfg = EngineConfigInput {
            provider_name: "OpenAI".to_string(),
            base_url: "https://new.example.com".to_string(),
            wire_api: "responses".to_string(),
            model: "gpt-5.5".to_string(),
            model_reasoning_effort: "high".to_string(),
            api_key: Some("sk-newtestkey5678wxyz".to_string()),
        };

        engine_config_set(&config_path, &auth_path, cfg).unwrap();

        let after = std::fs::read_to_string(&config_path).unwrap();

        // Comment must be preserved.
        assert!(
            after.contains("# This comment must survive"),
            "comment not preserved: {after}"
        );
        // MCP section must survive.
        assert!(
            after.contains("[mcp_servers.myserver]"),
            "mcp_servers section lost: {after}"
        );
        // New base_url must be written.
        assert!(
            after.contains("https://new.example.com"),
            "base_url not updated: {after}"
        );
        // Reasoning effort updated.
        assert!(
            after.contains(r#"model_reasoning_effort = "high""#),
            "reasoning_effort not updated: {after}"
        );
        // disable_response_storage (untouched key) must survive.
        assert!(
            after.contains("disable_response_storage"),
            "unexpected key lost: {after}"
        );

        // Backup must exist and contain the original.
        let bak = bak_path(&config_path);
        assert!(bak.exists(), "backup file not created");
        let bak_content = std::fs::read_to_string(&bak).unwrap();
        assert!(
            bak_content.contains("https://old.example.com"),
            "backup does not contain original base_url"
        );

        // auth.json must be written without BOM.
        let auth_bytes = std::fs::read(&auth_path).unwrap();
        assert_eq!(
            auth_bytes.first(),
            Some(&0x7Bu8),
            "auth.json starts with BOM"
        );
    }

    // ── engine_config_set: empty api_key leaves auth.json untouched ──────────

    #[test]
    fn set_empty_api_key_does_not_write_auth() {
        let tmp = TempDir::new().unwrap();
        let config_path = write_file(tmp.path(), "config.toml", r#"model = "gpt-5.5""#);
        let auth_path = tmp.path().join("auth.json");
        assert!(!auth_path.exists());

        let cfg = EngineConfigInput {
            provider_name: "OpenAI".to_string(),
            base_url: "https://example.com".to_string(),
            wire_api: "responses".to_string(),
            model: "gpt-5.5".to_string(),
            model_reasoning_effort: "low".to_string(),
            api_key: Some(String::new()), // empty → no write
        };
        engine_config_set(&config_path, &auth_path, cfg).unwrap();
        assert!(
            !auth_path.exists(),
            "auth.json should NOT be created for empty api_key"
        );
    }

    // ── engine_config_get round-trips set values ──────────────────────────────

    #[test]
    fn get_reads_back_values_written_by_set() {
        let tmp = TempDir::new().unwrap();
        let config_path = tmp.path().join("config.toml");
        let auth_path = tmp.path().join("auth.json");

        let cfg = EngineConfigInput {
            provider_name: "MyRelay".to_string(),
            base_url: "https://relay.example.com".to_string(),
            wire_api: "chat".to_string(),
            model: "my-model".to_string(),
            model_reasoning_effort: "medium".to_string(),
            api_key: Some("sk-roundtrip1234abcd".to_string()),
        };
        engine_config_set(&config_path, &auth_path, cfg).unwrap();

        let info = engine_config_get(&config_path, &auth_path).unwrap();
        assert_eq!(info.provider_name, "MyRelay");
        assert_eq!(info.base_url, "https://relay.example.com");
        assert_eq!(info.wire_api, "chat");
        assert_eq!(info.model, "my-model");
        assert_eq!(info.model_reasoning_effort, "medium");
        assert!(info.has_api_key);
        assert_eq!(info.key_mask, "****abcd");
    }

    // ── Live test: read real config (read-only, no writes) ────────────────────

    /// Run with: `cargo test -- --ignored live_engine_config_get`
    #[test]
    #[ignore]
    fn live_engine_config_get() {
        let config = crate::mcp::codex_config_path();
        let auth = auth_json_path();
        println!("config_path: {}", config.display());
        println!("auth_path:   {}", auth.display());
        let info = engine_config_get(&config, &auth)
            .expect("engine_config_get should not fail on real config");
        println!("provider_name:          {}", info.provider_name);
        println!("base_url:               {}", info.base_url);
        println!("wire_api:               {}", info.wire_api);
        println!("model:                  {}", info.model);
        println!("model_reasoning_effort: {}", info.model_reasoning_effort);
        println!("has_api_key:            {}", info.has_api_key);
        println!("key_mask:               {}", info.key_mask);
    }

    // ── Live test: real connectivity test (requires codex + network) ──────────

    /// Run with: `cargo test -- --ignored live_engine_config_test`
    #[tokio::test]
    #[ignore]
    async fn live_engine_config_test() {
        let result = engine_config_test()
            .await
            .expect("engine_config_test should return a TestResult, not Err");
        println!("success:    {}", result.success);
        println!("elapsed_ms: {}", result.elapsed_ms);
        println!("message:    {}", result.message);
    }
}
