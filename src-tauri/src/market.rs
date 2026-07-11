//! Agent/Skills 市场 (v0.8): 拉取 VPS 上的静态市场清单并一键安装到本地。
//!
//! 后端是纯静态 nginx 目录 `http://107.174.70.15/market/`：
//!   - `index.json`  — 市场清单（agents + skills 元数据）
//!   - `agents/*.md` / `skills/*.md` — 条目正文
//!
//! 安装位置（与现有扫描路径对齐，装完立刻可见）：
//!   - Skill  → `<research_skills_root>/skills/market/<id>.md`
//!     （`research::research_skills` 递归扫描 `<root>/skills/**`，
//!       子目录名 `market` 自动成为分类，科研页技能库直接可见）
//!   - Agent  → `%APPDATA%/agentboard/market/agents/<id>.md`（本地注册），
//!     并通过 `Db::insert_task_todo` 在看板新建「来自市场：<名>」卡片。
//!
//! 凭据无关：仅访问公开 HTTP 端点，不读写任何密钥。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::State;

use crate::AppState;

/// 市场根地址（静态 nginx 目录，只读）。
const MARKET_BASE: &str = "http://107.174.70.15/market";
/// 出站 HTTP 超时（秒）。
const HTTP_TIMEOUT_SECS: u64 = 15;
/// 单个条目正文大小上限（防御性；正常 .md 远小于此值）。
const MAX_ENTRY_BYTES: usize = 2 * 1024 * 1024;

// ── 清单结构 ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketAgent {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 相对市场根的正文路径，如 `agents/abstract_writer.md`。
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketSkill {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    /// 相对市场根的正文路径，如 `skills/format_checker.md`。
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketIndex {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub updated: String,
    #[serde(default)]
    pub agents: Vec<MarketAgent>,
    #[serde(default)]
    pub skills: Vec<MarketSkill>,
}

/// 本地已安装条目 id 列表（用于前端「已安装」标记）。
#[derive(Debug, Clone, Serialize)]
pub struct InstalledIds {
    pub agents: Vec<String>,
    pub skills: Vec<String>,
}

/// 安装 agent 的结果：本地注册路径 + 新建的看板卡 id。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallResult {
    pub path: String,
    pub task_id: String,
}

// ── 纯函数（可单测） ──────────────────────────────────────────────────────────

/// 条目 id 白名单校验：字母/数字/下划线/连字符，1..=64 字符。
fn sanitize_id(id: &str) -> Result<String, String> {
    let t = id.trim();
    if t.is_empty() || t.len() > 64 {
        return Err("非法条目 id".to_string());
    }
    if !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("非法条目 id".to_string());
    }
    Ok(t.to_string())
}

/// 校验清单里的相对路径：只允许 `agents/<name>.md` 或 `skills/<name>.md`。
fn validate_market_file(file: &str) -> Result<(), String> {
    let ok_prefix = file.starts_with("agents/") || file.starts_with("skills/");
    let name_ok = file
        .splitn(2, '/')
        .nth(1)
        .map(|n| {
            n.ends_with(".md")
                && n.len() > 3
                && n.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
                && !n.contains("..")
        })
        .unwrap_or(false);
    if ok_prefix && name_ok {
        Ok(())
    } else {
        Err(format!("非法市场条目路径: {file}"))
    }
}

/// Skill 安装路径：`<skills_root>/skills/market/<id>.md`。
fn skill_install_path(skills_root: &Path, id: &str) -> PathBuf {
    skills_root.join("skills").join("market").join(format!("{id}.md"))
}

/// Agent 本地注册目录：`<APPDATA>/agentboard/market/agents`（与 data.db 同基目录）。
fn agent_install_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:/Users/Default/AppData/Roaming"));

    #[cfg(not(windows))]
    let base = std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".local/share"))
        .unwrap_or_else(|_| PathBuf::from("/tmp"));

    base.join("agentboard").join("market").join("agents")
}

/// 列出目录下 .md 文件的文件名（不含扩展名）；目录缺失容忍为空。
fn list_md_stems(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("md") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    out.push(stem.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

fn market_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
}

async fn http_get_text(url: &str) -> Result<String, String> {
    let resp = market_client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("市场请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("市场返回 HTTP {}", resp.status().as_u16()));
    }
    let body = resp.text().await.map_err(|e| format!("读取市场响应失败: {e}"))?;
    if body.len() > MAX_ENTRY_BYTES {
        return Err("市场条目过大".to_string());
    }
    Ok(body)
}

// ── Tauri 命令 ────────────────────────────────────────────────────────────────

/// 拉取市场清单 `index.json`。
#[tauri::command]
pub(crate) async fn market_index() -> Result<MarketIndex, String> {
    let body = http_get_text(&format!("{MARKET_BASE}/index.json")).await?;
    serde_json::from_str(&body).map_err(|e| format!("市场清单解析失败: {e}"))
}

/// 拉取某条目的 markdown 正文（预览用）。
#[tauri::command]
pub(crate) async fn market_fetch(file: String) -> Result<String, String> {
    validate_market_file(&file)?;
    http_get_text(&format!("{MARKET_BASE}/{file}")).await
}

/// 一键安装 skill：下载 .md 存入 `<skills_root>/skills/market/<id>.md`，
/// 科研页技能库（`research_skills` 扫描）立即可见。返回安装后的绝对路径。
#[tauri::command]
pub(crate) async fn market_install_skill(
    id: String,
    file: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let id = sanitize_id(&id)?;
    validate_market_file(&file)?;
    if !file.starts_with("skills/") {
        return Err("该条目不是 skill".to_string());
    }
    let body = http_get_text(&format!("{MARKET_BASE}/{file}")).await?;

    let dest = skill_install_path(&crate::research::skills_root(&state.db), &id);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建技能目录失败: {e}"))?;
    }
    fs::write(&dest, body.as_bytes()).map_err(|e| format!("写入技能文件失败: {e}"))?;
    Ok(dest.to_string_lossy().replace('\\', "/"))
}

/// 一键安装 agent：下载 .md 注册到本地
/// `%APPDATA%/agentboard/market/agents/<id>.md`，并在看板创建
/// 「来自市场：<名>」的待办卡片（复用 `insert_task_todo`，状态 todo）。
#[tauri::command]
pub(crate) async fn market_install_agent(
    id: String,
    name: String,
    file: String,
    state: State<'_, AppState>,
) -> Result<AgentInstallResult, String> {
    let id = sanitize_id(&id)?;
    validate_market_file(&file)?;
    if !file.starts_with("agents/") {
        return Err("该条目不是 agent".to_string());
    }
    let body = http_get_text(&format!("{MARKET_BASE}/{file}")).await?;

    let dir = agent_install_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建市场 agent 目录失败: {e}"))?;
    let dest = dir.join(format!("{id}.md"));
    fs::write(&dest, body.as_bytes()).map_err(|e| format!("写入 agent 文件失败: {e}"))?;

    // 看板卡片：workdir 指向本地注册目录，启动会话时即以该目录为工作区。
    let title_name = if name.trim().is_empty() { id.clone() } else { name.trim().to_string() };
    let task_id = uuid::Uuid::new_v4().to_string();
    state
        .db
        .insert_task_todo(&task_id, &format!("来自市场：{title_name}"), &dir.to_string_lossy())
        .map_err(|e| format!("创建看板卡片失败: {e}"))?;
    state.sync.notify_snapshot();

    Ok(AgentInstallResult {
        path: dest.to_string_lossy().replace('\\', "/"),
        task_id,
    })
}

/// 已安装条目 id 列表（扫描本地安装目录，供前端标记「已安装」）。
#[tauri::command]
pub(crate) async fn market_installed(state: State<'_, AppState>) -> Result<InstalledIds, String> {
    let skills_dir = crate::research::skills_root(&state.db).join("skills").join("market");
    Ok(InstalledIds {
        agents: list_md_stems(&agent_install_dir()),
        skills: list_md_stems(&skills_dir),
    })
}

// ── 单元测试 ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_id_accepts_normal_ids() {
        assert_eq!(sanitize_id("abstract_writer").unwrap(), "abstract_writer");
        assert_eq!(sanitize_id(" bench-01 ").unwrap(), "bench-01");
    }

    #[test]
    fn sanitize_id_rejects_bad_ids() {
        assert!(sanitize_id("").is_err());
        assert!(sanitize_id("../evil").is_err());
        assert!(sanitize_id("a/b").is_err());
        assert!(sanitize_id("空格 id").is_err());
        assert!(sanitize_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn validate_market_file_accepts_manifest_paths() {
        assert!(validate_market_file("agents/abstract_writer.md").is_ok());
        assert!(validate_market_file("skills/full_paper_pipeline.md").is_ok());
    }

    #[test]
    fn validate_market_file_rejects_traversal_and_junk() {
        assert!(validate_market_file("agents/../secret.md").is_err());
        assert!(validate_market_file("/etc/passwd").is_err());
        assert!(validate_market_file("agents/x.txt").is_err());
        assert!(validate_market_file("other/x.md").is_err());
        assert!(validate_market_file("agents/").is_err());
        assert!(validate_market_file("agents/a\\b.md").is_err());
    }

    #[test]
    fn skill_install_path_is_under_market_subdir() {
        let p = skill_install_path(Path::new("D:/root"), "fmt");
        let s = p.to_string_lossy().replace('\\', "/");
        assert_eq!(s, "D:/root/skills/market/fmt.md");
    }

    #[test]
    fn agent_install_dir_ends_with_market_agents() {
        let s = agent_install_dir().to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("agentboard/market/agents"), "{s}");
    }

    #[test]
    fn list_md_stems_scans_and_tolerates_missing() {
        assert!(list_md_stems(Path::new("/no/such/dir/xyz")).is_empty());
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("b.md"), "x").unwrap();
        std::fs::write(tmp.path().join("a.md"), "x").unwrap();
        std::fs::write(tmp.path().join("c.txt"), "x").unwrap();
        assert_eq!(list_md_stems(tmp.path()), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn market_index_parses_manifest_shape() {
        let j = r#"{
            "version": 1, "updated": "2026-07-11",
            "agents": [{"id":"a","name":"A","description":"d","category":"Writing",
                        "tags":["Writing","kr"],"file":"agents/a.md"}],
            "skills": [{"id":"s","name":"S","category":"writing","file":"skills/s.md"}]
        }"#;
        let idx: MarketIndex = serde_json::from_str(j).unwrap();
        assert_eq!(idx.agents.len(), 1);
        assert_eq!(idx.skills.len(), 1);
        assert_eq!(idx.agents[0].tags.len(), 2);
        assert_eq!(idx.skills[0].description, ""); // 缺省字段容忍
    }
}
