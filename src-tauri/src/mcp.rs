/// MCP server configuration management for the Codex CLI.
///
/// Reads and writes `%USERPROFILE%\.codex\config.toml` using `toml_edit`
/// to preserve existing formatting and other config sections.
///
/// Before any write, a backup is saved to `config.toml.bak` in the same dir.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use toml_edit::{DocumentMut, Item, Table, Array, value as toml_value};

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

// ── Config path ───────────────────────────────────────────────────────────────

/// Returns `%USERPROFILE%\.codex\config.toml` (Windows) or
/// `$HOME/.codex/config.toml` (other platforms).
pub fn codex_config_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".codex").join("config.toml")
}

// ── List ──────────────────────────────────────────────────────────────────────

/// Parse MCP servers from the Codex config.toml.
/// Returns an empty list if the file does not exist or has no `[mcp_servers.*]` sections.
pub fn list_mcp_servers(config_path: &Path) -> Result<Vec<McpServer>, String> {
    if !config_path.exists() {
        return Ok(vec![]);
    }

    let content = std::fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let doc: DocumentMut = content.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;

    let mut servers = Vec::new();

    if let Some(mcp_table) = doc.get("mcp_servers").and_then(|v| v.as_table()) {
        for (name, value) in mcp_table {
            if let Some(server_table) = value.as_table() {
                let command = server_table
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let args: Vec<String> = server_table
                    .get("args")
                    .and_then(|v| v.as_value())
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();

                let env: HashMap<String, String> = server_table
                    .get("env")
                    .and_then(|v| v.as_table())
                    .map(|t| {
                        t.iter()
                            .filter_map(|(k, v)| {
                                v.as_str().map(|s| (k.to_string(), s.to_string()))
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                servers.push(McpServer {
                    name: name.to_string(),
                    command,
                    args,
                    env,
                });
            }
        }
    }

    Ok(servers)
}

// ── Add ───────────────────────────────────────────────────────────────────────

/// Add (or replace) an MCP server in the config. Backs up to `config.toml.bak` first.
pub fn add_mcp_server(config_path: &Path, server: &McpServer) -> Result<(), String> {
    // Backup existing config before mutating.
    if config_path.exists() {
        let bak = bak_path(config_path);
        std::fs::copy(config_path, &bak).map_err(|e| e.to_string())?;
    }

    let content = if config_path.exists() {
        std::fs::read_to_string(config_path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };

    let mut doc: DocumentMut = content.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;

    // Ensure [mcp_servers] exists as an implicit table (no header line of its own).
    if doc.get("mcp_servers").is_none() {
        let mut tbl = Table::new();
        tbl.set_implicit(true);
        doc.insert("mcp_servers", Item::Table(tbl));
    }

    // Build the per-server table.
    let mut server_tbl = Table::new();
    server_tbl.insert("command", toml_value(server.command.clone()));

    if !server.args.is_empty() {
        let mut arr = Array::new();
        for arg in &server.args {
            arr.push(arg.as_str());
        }
        server_tbl.insert("args", Item::Value(toml_edit::Value::Array(arr)));
    }

    if !server.env.is_empty() {
        let mut env_tbl = Table::new();
        for (k, v) in &server.env {
            env_tbl.insert(k, toml_value(v.clone()));
        }
        server_tbl.insert("env", Item::Table(env_tbl));
    }

    // Insert as a sub-table under [mcp_servers].
    if let Some(mcp) = doc["mcp_servers"].as_table_mut() {
        mcp.insert(&server.name, Item::Table(server_tbl));
    }

    // Ensure the config directory exists.
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    std::fs::write(config_path, doc.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Remove ────────────────────────────────────────────────────────────────────

/// Remove an MCP server by name. Backs up to `config.toml.bak` first.
pub fn remove_mcp_server(config_path: &Path, name: &str) -> Result<(), String> {
    if !config_path.exists() {
        return Ok(());
    }

    // Backup.
    let bak = bak_path(config_path);
    std::fs::copy(config_path, &bak).map_err(|e| e.to_string())?;

    let content = std::fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let mut doc: DocumentMut = content.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;

    if let Some(mcp) = doc.get_mut("mcp_servers").and_then(|v| v.as_table_mut()) {
        mcp.remove(name);
    }

    std::fs::write(config_path, doc.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn bak_path(config_path: &Path) -> PathBuf {
    // config.toml → config.toml.bak
    config_path.with_extension("toml.bak")
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_config(dir: &Path, content: &str) -> PathBuf {
        let p = dir.join("config.toml");
        std::fs::write(&p, content).unwrap();
        p
    }

    // ── list ─────────────────────────────────────────────────────────────────

    #[test]
    fn list_returns_empty_for_nonexistent_file() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.toml");
        let servers = list_mcp_servers(&p).unwrap();
        assert!(servers.is_empty());
    }

    #[test]
    fn list_parses_mcp_servers() {
        let tmp = TempDir::new().unwrap();
        let content = r#"
model = "gpt-5.5"

[mcp_servers.fetch]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-fetch"]

[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
"#;
        let p = write_config(tmp.path(), content);
        let servers = list_mcp_servers(&p).unwrap();
        assert_eq!(servers.len(), 2);
        let fetch = servers.iter().find(|s| s.name == "fetch").expect("fetch");
        assert_eq!(fetch.command, "npx");
        assert_eq!(fetch.args, vec!["-y", "@modelcontextprotocol/server-fetch"]);
    }

    // ── add ──────────────────────────────────────────────────────────────────

    #[test]
    fn add_preserves_existing_config_sections() {
        let tmp = TempDir::new().unwrap();
        let content = r#"model = "gpt-5.5"
model_reasoning_effort = "xhigh"

[model_providers.OpenAI]
base_url = "https://example.com"
"#;
        let p = write_config(tmp.path(), content);

        let server = McpServer {
            name: "mymcp".to_string(),
            command: "node".to_string(),
            args: vec!["server.js".to_string()],
            env: HashMap::new(),
        };
        add_mcp_server(&p, &server).unwrap();

        let after = std::fs::read_to_string(&p).unwrap();
        // Existing keys must be preserved.
        assert!(after.contains("model = \"gpt-5.5\""), "model key missing");
        assert!(after.contains("model_reasoning_effort"), "effort key missing");
        assert!(after.contains("[model_providers.OpenAI]"), "provider section missing");
        // New server must be present.
        assert!(after.contains("mymcp"), "mymcp section missing");
        assert!(after.contains("node"), "command missing");
    }

    #[test]
    fn add_creates_backup() {
        let tmp = TempDir::new().unwrap();
        let p = write_config(tmp.path(), "model = \"gpt-5.5\"\n");
        let bak = bak_path(&p);

        let server = McpServer {
            name: "s".to_string(),
            command: "echo".to_string(),
            args: vec![],
            env: HashMap::new(),
        };
        add_mcp_server(&p, &server).unwrap();

        assert!(bak.exists(), "backup file should be created");
        let bak_content = std::fs::read_to_string(&bak).unwrap();
        assert!(bak_content.contains("model = \"gpt-5.5\""), "backup should contain original");
    }

    #[test]
    fn add_then_list_round_trips() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.toml");

        let server = McpServer {
            name: "myserver".to_string(),
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "some-mcp".to_string()],
            env: HashMap::new(),
        };
        add_mcp_server(&p, &server).unwrap();

        let list = list_mcp_servers(&p).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "myserver");
        assert_eq!(list[0].command, "npx");
        assert_eq!(list[0].args, vec!["-y", "some-mcp"]);
    }

    // ── remove ────────────────────────────────────────────────────────────────

    #[test]
    fn remove_deletes_server_preserves_others() {
        let tmp = TempDir::new().unwrap();
        let content = r#"model = "gpt-5.5"

[mcp_servers.keep_me]
command = "keep"
args = []

[mcp_servers.remove_me]
command = "gone"
args = []
"#;
        let p = write_config(tmp.path(), content);
        remove_mcp_server(&p, "remove_me").unwrap();

        let after = std::fs::read_to_string(&p).unwrap();
        assert!(after.contains("keep_me"), "keep_me should still exist");
        assert!(!after.contains("remove_me"), "remove_me should be gone");
        assert!(after.contains("model = \"gpt-5.5\""), "model key should survive");
    }

    #[test]
    fn remove_creates_backup() {
        let tmp = TempDir::new().unwrap();
        let content = "[mcp_servers.x]\ncommand = \"cmd\"\n";
        let p = write_config(tmp.path(), content);
        let bak = bak_path(&p);

        remove_mcp_server(&p, "x").unwrap();
        assert!(bak.exists(), "backup should be created on remove");
    }

    /// Live test against the real codex config — run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn live_list_real_codex_config() {
        let path = super::codex_config_path();
        println!("Config path: {}", path.display());
        let servers = list_mcp_servers(&path).unwrap();
        println!("Found {} MCP server(s):", servers.len());
        for s in &servers {
            println!("  - {} (command: {})", s.name, s.command);
        }
    }

    #[test]
    fn remove_nonexistent_server_is_noop() {
        let tmp = TempDir::new().unwrap();
        let p = write_config(tmp.path(), "model = \"gpt-5.5\"\n");
        let original = std::fs::read_to_string(&p).unwrap();

        remove_mcp_server(&p, "nonexistent").unwrap();

        let after = std::fs::read_to_string(&p).unwrap();
        assert_eq!(
            original, after,
            "file should be semantically unchanged after removing nonexistent server"
        );
    }
}
