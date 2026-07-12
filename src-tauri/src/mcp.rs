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

// ── Catalog ──────────────────────────────────────────────────────────────────

/// A curated MCP server entry for the built-in catalog (discovery / one-click install).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpCatalogEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub npm_package: String,
    pub default_command: String,
    pub default_args: Vec<String>,
    /// Environment variables the server typically needs (key = var name, value = placeholder hint).
    pub env_hints: Vec<(String, String)>,
}

/// Return a curated catalog of well-known MCP servers (hard-coded).
pub fn mcp_catalog() -> Vec<McpCatalogEntry> {
    vec![
        McpCatalogEntry {
            id: "filesystem".into(),
            name: "Filesystem".into(),
            description: "读写本地文件系统，支持目录浏览、文件搜索、创建/编辑文件".into(),
            category: "文件系统".into(),
            npm_package: "@modelcontextprotocol/server-filesystem".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-filesystem".into(), "/path/to/allowed/dir".into()],
            env_hints: vec![],
        },
        McpCatalogEntry {
            id: "fetch".into(),
            name: "Fetch".into(),
            description: "通过 HTTP 抓取网页内容，将 HTML 转为 Markdown 供模型阅读".into(),
            category: "网络".into(),
            npm_package: "@modelcontextprotocol/server-fetch".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-fetch".into()],
            env_hints: vec![],
        },
        McpCatalogEntry {
            id: "brave-search".into(),
            name: "Brave Search".into(),
            description: "通过 Brave Search API 进行网页搜索和本地搜索".into(),
            category: "网络".into(),
            npm_package: "@modelcontextprotocol/server-brave-search".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-brave-search".into()],
            env_hints: vec![("BRAVE_API_KEY".into(), "Brave Search API Key".into())],
        },
        McpCatalogEntry {
            id: "github".into(),
            name: "GitHub".into(),
            description: "GitHub API 集成：仓库管理、Issue、PR、代码搜索、文件操作".into(),
            category: "代码".into(),
            npm_package: "@modelcontextprotocol/server-github".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-github".into()],
            env_hints: vec![("GITHUB_PERSONAL_ACCESS_TOKEN".into(), "GitHub Personal Access Token".into())],
        },
        McpCatalogEntry {
            id: "git".into(),
            name: "Git".into(),
            description: "本地 Git 仓库操作：状态、日志、diff、分支管理、提交".into(),
            category: "代码".into(),
            npm_package: "@modelcontextprotocol/server-git".into(),
            default_command: "uvx".into(),
            default_args: vec!["mcp-server-git".into()],
            env_hints: vec![],
        },
        McpCatalogEntry {
            id: "postgres".into(),
            name: "PostgreSQL".into(),
            description: "连接 PostgreSQL 数据库，执行只读查询，浏览表结构".into(),
            category: "数据库".into(),
            npm_package: "@modelcontextprotocol/server-postgres".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-postgres".into(), "postgresql://localhost/mydb".into()],
            env_hints: vec![],
        },
        McpCatalogEntry {
            id: "sqlite".into(),
            name: "SQLite".into(),
            description: "连接 SQLite 数据库，执行查询，浏览表结构和数据".into(),
            category: "数据库".into(),
            npm_package: "@modelcontextprotocol/server-sqlite".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-sqlite".into(), "/path/to/database.db".into()],
            env_hints: vec![],
        },
        McpCatalogEntry {
            id: "puppeteer".into(),
            name: "Puppeteer".into(),
            description: "浏览器自动化：导航、截图、点击、表单填写、JavaScript 执行".into(),
            category: "浏览器".into(),
            npm_package: "@modelcontextprotocol/server-puppeteer".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-puppeteer".into()],
            env_hints: vec![],
        },
        McpCatalogEntry {
            id: "playwright".into(),
            name: "Playwright".into(),
            description: "基于 Playwright 的浏览器自动化，支持截图、导航、交互操作".into(),
            category: "浏览器".into(),
            npm_package: "@anthropic-ai/mcp-server-playwright".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@anthropic-ai/mcp-server-playwright".into()],
            env_hints: vec![],
        },
        McpCatalogEntry {
            id: "memory".into(),
            name: "Memory".into(),
            description: "知识图谱式持久记忆：创建实体、建立关系、跨会话记忆".into(),
            category: "思维".into(),
            npm_package: "@modelcontextprotocol/server-memory".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-memory".into()],
            env_hints: vec![],
        },
        McpCatalogEntry {
            id: "sequential-thinking".into(),
            name: "Sequential Thinking".into(),
            description: "结构化思维工具：分步推理、修正、分支探索复杂问题".into(),
            category: "思维".into(),
            npm_package: "@modelcontextprotocol/server-sequential-thinking".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-sequential-thinking".into()],
            env_hints: vec![],
        },
        McpCatalogEntry {
            id: "everything".into(),
            name: "Everything".into(),
            description: "MCP 协议参考实现与测试工具，包含所有能力的示例".into(),
            category: "效率".into(),
            npm_package: "@modelcontextprotocol/server-everything".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-everything".into()],
            env_hints: vec![],
        },
        McpCatalogEntry {
            id: "slack".into(),
            name: "Slack".into(),
            description: "Slack 工作区集成：发送消息、管理频道、搜索消息历史".into(),
            category: "效率".into(),
            npm_package: "@modelcontextprotocol/server-slack".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-slack".into()],
            env_hints: vec![("SLACK_BOT_TOKEN".into(), "Slack Bot Token (xoxb-...)".into())],
        },
        McpCatalogEntry {
            id: "google-maps".into(),
            name: "Google Maps".into(),
            description: "Google Maps API：地理编码、路线规划、地点搜索、海拔查询".into(),
            category: "网络".into(),
            npm_package: "@modelcontextprotocol/server-google-maps".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-google-maps".into()],
            env_hints: vec![("GOOGLE_MAPS_API_KEY".into(), "Google Maps API Key".into())],
        },
        McpCatalogEntry {
            id: "docker".into(),
            name: "Docker".into(),
            description: "Docker 容器管理：列出容器、镜像、日志查看、容器操作".into(),
            category: "云".into(),
            npm_package: "@modelcontextprotocol/server-docker".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-docker".into()],
            env_hints: vec![],
        },
        McpCatalogEntry {
            id: "aws-kb-retrieval".into(),
            name: "AWS KB Retrieval".into(),
            description: "从 AWS Bedrock Knowledge Base 检索文档和信息".into(),
            category: "云".into(),
            npm_package: "@modelcontextprotocol/server-aws-kb-retrieval".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-aws-kb-retrieval".into()],
            env_hints: vec![
                ("AWS_ACCESS_KEY_ID".into(), "AWS Access Key ID".into()),
                ("AWS_SECRET_ACCESS_KEY".into(), "AWS Secret Access Key".into()),
                ("AWS_REGION".into(), "AWS Region (e.g. us-east-1)".into()),
            ],
        },
        McpCatalogEntry {
            id: "sentry".into(),
            name: "Sentry".into(),
            description: "Sentry 错误追踪集成：查看 Issue、错误事件、项目统计".into(),
            category: "效率".into(),
            npm_package: "@modelcontextprotocol/server-sentry".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-sentry".into()],
            env_hints: vec![("SENTRY_AUTH_TOKEN".into(), "Sentry Auth Token".into())],
        },
        McpCatalogEntry {
            id: "linear".into(),
            name: "Linear".into(),
            description: "Linear 项目管理：创建/搜索 Issue、管理项目和团队工作流".into(),
            category: "效率".into(),
            npm_package: "@modelcontextprotocol/server-linear".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-linear".into()],
            env_hints: vec![("LINEAR_API_KEY".into(), "Linear API Key".into())],
        },
        McpCatalogEntry {
            id: "notion".into(),
            name: "Notion".into(),
            description: "Notion API 集成：搜索页面、读取内容、创建和更新页面".into(),
            category: "效率".into(),
            npm_package: "@notionhq/mcp-server-notion".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@notionhq/mcp-server-notion".into()],
            env_hints: vec![("NOTION_API_KEY".into(), "Notion Integration Token".into())],
        },
        McpCatalogEntry {
            id: "redis".into(),
            name: "Redis".into(),
            description: "Redis 数据库操作：键值读写、数据结构操作、键空间浏览".into(),
            category: "数据库".into(),
            npm_package: "@modelcontextprotocol/server-redis".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-redis".into(), "redis://localhost:6379".into()],
            env_hints: vec![],
        },
        McpCatalogEntry {
            id: "cloudflare".into(),
            name: "Cloudflare".into(),
            description: "Cloudflare 账户管理：Workers、KV、R2、D1 数据库操作".into(),
            category: "云".into(),
            npm_package: "@cloudflare/mcp-server-cloudflare".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@cloudflare/mcp-server-cloudflare".into()],
            env_hints: vec![("CLOUDFLARE_API_TOKEN".into(), "Cloudflare API Token".into())],
        },
        McpCatalogEntry {
            id: "exa".into(),
            name: "Exa Search".into(),
            description: "Exa AI 搜索引擎：语义搜索、相似内容发现、网页内容提取".into(),
            category: "网络".into(),
            npm_package: "@exa-labs/mcp-server-exa".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@exa-labs/mcp-server-exa".into()],
            env_hints: vec![("EXA_API_KEY".into(), "Exa API Key".into())],
        },
        McpCatalogEntry {
            id: "tavily".into(),
            name: "Tavily Search".into(),
            description: "Tavily AI 搜索 API：针对 AI 优化的搜索结果和内容提取".into(),
            category: "网络".into(),
            npm_package: "tavily-mcp".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "tavily-mcp".into()],
            env_hints: vec![("TAVILY_API_KEY".into(), "Tavily API Key".into())],
        },
        McpCatalogEntry {
            id: "time".into(),
            name: "Time".into(),
            description: "获取当前时间和时区转换，支持 IANA 时区标识符".into(),
            category: "效率".into(),
            npm_package: "@modelcontextprotocol/server-time".into(),
            default_command: "npx".into(),
            default_args: vec!["-y".into(), "@modelcontextprotocol/server-time".into()],
            env_hints: vec![],
        },
    ]
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
