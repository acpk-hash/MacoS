//! Skills 中心：市场下载 → 共享 pi skill 目录 → 编码会话挂载。
//!
//! ## 目录布局
//! 共享目录 `app_data_dir/skills/<name>/SKILL.md`（每 skill 一个子目录，
//! pi 的 skill 约定：目录含 SKILL.md，frontmatter `name`/`description`）。
//!
//! ## 生效链路（已对本机 pi 0.80.3 dist 实证）
//! `pi_open` 准备会话目录时调用 [`mirror_skills_into`] 把共享目录整个复制到
//! `<sessionAgentDir>/skills/`，并在 spawn 参数追加 `--skill <该目录>`：
//! - `dist/cli/args.js:127` `--skill <path>` 可多次、可传目录；
//! - `dist/core/resource-loader.js:284` 即使保留 `--no-skills`，CLI `--skill`
//!   传入的路径仍会被加载（noSkills 只关掉自动发现，屏蔽 ~/.agents 等污染）；
//! - `dist/core/skills.js:117-119` 目录会递归找 SKILL.md，含 SKILL.md 的目录
//!   即 skill 根。
//! 因此保留原 `--no-skills` 不动，会话里生效的 skill 恰好=共享目录镜像，
//! prompt 中可用 `/skill:<name>` 强制唤起。
//!
//! ## 市场
//! VPS 静态目录 `http://107.174.70.15/market/`（index.json + 条目 .md 正文）。
//! 条目是提示词型 skill：安装时转成 pi SKILL.md（frontmatter name=id 规范化
//! 小写连字符、description=条目描述，正文=原 md）。全程 UTF-8 无 BOM。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// 市场根地址（与 market.rs 同源；此处独立持有避免耦合）。
const MARKET_BASE: &str = "http://107.174.70.15/market";
/// 出站 HTTP 超时（秒）。
const HTTP_TIMEOUT_SECS: u64 = 15;
/// 单个条目正文大小上限。
const MAX_ENTRY_BYTES: usize = 2 * 1024 * 1024;
/// pi skill name 上限（小写连字符）。
const MAX_NAME_LEN: usize = 64;
/// pi skill description 上限。
const MAX_DESC_LEN: usize = 1024;

// ── 数据结构 ─────────────────────────────────────────────────────────────────

/// 市场条目（agents + skills 两个清单合并；都是提示词型，装完都是 pi skill）。
#[derive(Debug, Clone, Serialize)]
pub struct MarketEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub tags: Vec<String>,
    pub file: String,
    /// 来源清单：`"agent"` / `"skill"`。
    pub kind: String,
}

/// 本地已安装 skill（扫共享目录 + 读 SKILL.md frontmatter）。
#[derive(Debug, Clone, Serialize)]
pub struct LocalSkill {
    pub name: String,
    pub description: String,
    pub dir: String,
    /// 目前只有市场安装一种来源。
    pub source: String,
}

/// 公开搜索结果（GitHub 仓库）。
#[derive(Debug, Clone, Serialize)]
pub struct PublicSkill {
    /// GitHub full_name（`owner/repo`）。
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub source_url: String,
    /// raw.githubusercontent.com 上的 SKILL.md（可能不存在）。
    pub install_url: Option<String>,
    pub stars: u64,
    pub topics: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawEntry {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    tags: Vec<String>,
    file: String,
}

#[derive(Debug, Deserialize)]
struct RawIndex {
    #[serde(default)]
    agents: Vec<RawEntry>,
    #[serde(default)]
    skills: Vec<RawEntry>,
}

// ── 纯函数（可单测） ──────────────────────────────────────────────────────────

/// 条目 id 白名单校验：字母/数字/下划线/连字符，1..=64。
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

/// 清单相对路径校验：只允许 `agents/<name>.md` 或 `skills/<name>.md`。
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

/// id → pi skill name：小写、非 [a-z0-9] 折叠为单个 `-`、去首尾 `-`、≤64。
fn normalize_skill_name(id: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = true; // 抑制开头的 '-'
    for c in id.trim().to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.truncate(MAX_NAME_LEN);
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "skill".to_string()
    } else {
        out
    }
}

/// skill name 校验（本地卸载/读取入参，防目录穿越）。
fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > MAX_NAME_LEN
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!("非法 skill 名称: {name}"));
    }
    Ok(())
}

/// description → YAML 双引号字符串内容：换行折成空格、转义 `\` 与 `"`、≤1024。
fn yaml_escape_description(desc: &str) -> String {
    let flat: String = desc
        .chars()
        .map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c })
        .collect();
    let mut out = String::new();
    for c in flat.trim().chars().take(MAX_DESC_LEN) {
        match c {
            '\u{5c}' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out
}

/// 组装 SKILL.md：YAML frontmatter（name/description）+ 原 md 正文。无 BOM。
fn build_skill_md(name: &str, description: &str, body: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: \"{}\"\n---\n\n{}",
        yaml_escape_description(description),
        body.trim_start_matches('\u{feff}'),
    )
}

/// 从 SKILL.md 内容解析 frontmatter 的 name/description（宽容解析：
/// 首行 `---` 到下一个 `---` 之间的 `key: value` 行；双引号值做最小反转义）。
fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let content = content.trim_start_matches('\u{feff}');
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut desc = None;
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim();
        let v = if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
            v[1..v.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\")
        } else {
            v.to_string()
        };
        match k.trim() {
            "name" => name = Some(v),
            "description" => desc = Some(v),
            _ => {}
        }
    }
    (name, desc)
}

/// 递归复制目录（覆盖同名文件）。
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// 目录（递归）下是否存在任何 SKILL.md。
fn contains_skill_md(dir: &Path) -> bool {
    let Ok(rd) = fs::read_dir(dir) else {
        return false;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if contains_skill_md(&p) {
                return true;
            }
        } else if p.file_name().and_then(|n| n.to_str()) == Some("SKILL.md") {
            return true;
        }
    }
    false
}

/// pi_open 接线入口：把共享 skills 目录整个镜像到 `<sessionAgentDir>/skills/`。
/// 共享目录不存在或没有任何 SKILL.md → 返回 `None`（调用方不加 `--skill`）；
/// 复制成功 → 返回镜像目录路径（作为 `--skill` 参数值）。
pub(crate) fn mirror_skills_into(shared: &Path, session_agent_dir: &Path) -> Option<PathBuf> {
    if !shared.is_dir() || !contains_skill_md(shared) {
        return None;
    }
    let dest = session_agent_dir.join("skills");
    match copy_dir_recursive(shared, &dest) {
        Ok(()) => Some(dest),
        Err(e) => {
            eprintln!("[skills_hub] 镜像共享 skills 失败（跳过挂载）: {e}");
            None
        }
    }
}

// ── 路径解析 ─────────────────────────────────────────────────────────────────

/// 共享 skills 根目录：`app_data_dir/skills`。
fn shared_skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法取得应用数据目录: {e}"))?
        .join("skills"))
}

/// 粘贴文件落盘目录：`app_data_dir/pasted`。
fn pasted_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法取得应用数据目录: {e}"))?
        .join("pasted"))
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async fn http_get_text(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("技能市场连接失败（离线或市场不可达）: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("技能市场返回 HTTP {}", resp.status().as_u16()));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取市场响应失败: {e}"))?;
    if body.len() > MAX_ENTRY_BYTES {
        return Err("市场条目过大".to_string());
    }
    Ok(body)
}

async fn fetch_market_index() -> Result<RawIndex, String> {
    let body = http_get_text(&format!("{MARKET_BASE}/index.json")).await?;
    serde_json::from_str(&body).map_err(|e| format!("市场清单解析失败: {e}"))
}

fn merge_index(idx: RawIndex) -> Vec<MarketEntry> {
    let conv = |e: RawEntry, kind: &str| MarketEntry {
        id: e.id,
        name: e.name,
        description: e.description,
        category: e.category,
        tags: e.tags,
        file: e.file,
        kind: kind.to_string(),
    };
    let mut out: Vec<MarketEntry> = Vec::new();
    for e in idx.skills {
        out.push(conv(e, "skill"));
    }
    for e in idx.agents {
        out.push(conv(e, "agent"));
    }
    out
}

// ── Tauri 命令 ────────────────────────────────────────────────────────────────

/// 拉取市场清单（agents + skills 合并为一张提示词型 skill 清单）。
#[tauri::command]
pub(crate) async fn skills_market_list() -> Result<Vec<MarketEntry>, String> {
    Ok(merge_index(fetch_market_index().await?))
}

/// 按 id 安装一个市场条目：重新拉清单定位条目（拒绝伪造路径）→ 拉正文 →
/// 转 pi SKILL.md → 写入 `app_data_dir/skills/<name>/SKILL.md`。返回安装路径。
#[tauri::command]
pub(crate) async fn skills_market_install(app: AppHandle, id: String) -> Result<String, String> {
    let id = sanitize_id(&id)?;
    let idx = fetch_market_index().await?;
    let entry = merge_index(idx)
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("市场中不存在条目: {id}"))?;
    validate_market_file(&entry.file)?;
    let body = http_get_text(&format!("{MARKET_BASE}/{}", entry.file)).await?;

    let name = normalize_skill_name(&id);
    let dir = shared_skills_dir(&app)?.join(&name);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 skill 目录失败: {e}"))?;
    let dest = dir.join("SKILL.md");
    let content = build_skill_md(&name, &entry.description, &body);
    fs::write(&dest, content.as_bytes()).map_err(|e| format!("写入 SKILL.md 失败: {e}"))?;
    Ok(dest.to_string_lossy().replace('\u{5c}', "/"))
}

/// 扫共享目录列出已安装 skills（读每个子目录的 SKILL.md frontmatter）。
#[tauri::command]
pub(crate) async fn skills_local_list(app: AppHandle) -> Result<Vec<LocalSkill>, String> {
    let root = shared_skills_dir(&app)?;
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(&root) else {
        return Ok(out); // 目录尚未创建 = 没装过
    };
    for entry in rd.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let md = dir.join("SKILL.md");
        let Ok(content) = fs::read_to_string(&md) else {
            continue;
        };
        let (name, desc) = parse_frontmatter(&content);
        let fallback = entry.file_name().to_string_lossy().to_string();
        out.push(LocalSkill {
            name: name.filter(|n| !n.is_empty()).unwrap_or(fallback),
            description: desc.unwrap_or_default(),
            dir: dir.to_string_lossy().replace('\u{5c}', "/"),
            source: "market".to_string(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 读取某个已安装 skill 的 SKILL.md 全文（页面预览用）。
#[tauri::command]
pub(crate) async fn skills_read(app: AppHandle, name: String) -> Result<String, String> {
    validate_skill_name(&name)?;
    let md = shared_skills_dir(&app)?.join(&name).join("SKILL.md");
    fs::read_to_string(&md).map_err(|e| format!("读取 SKILL.md 失败: {e}"))
}

/// 卸载：删除共享目录下的整个 skill 子目录。
#[tauri::command]
pub(crate) async fn skills_uninstall(app: AppHandle, name: String) -> Result<(), String> {
    validate_skill_name(&name)?;
    let dir = shared_skills_dir(&app)?.join(&name);
    if !dir.is_dir() {
        return Err(format!("skill 不存在: {name}"));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("卸载失败: {e}"))
}

/// 剪贴板粘贴内容落盘：base64 → `app_data_dir/pasted/<uuid>.<ext>`，
/// 返回绝对路径（编码 Composer 拿它走 pi 的 @path 附件协议）。
#[tauri::command]
pub(crate) async fn save_clipboard_file(
    app: AppHandle,
    base64: String,
    ext: String,
) -> Result<String, String> {
    let ext = ext.trim().trim_start_matches('.').to_lowercase();
    if ext.is_empty() || ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("非法扩展名: {ext}"));
    }
    // 容忍 data URL 前缀（`data:image/png;base64,....`）。
    let raw = base64
        .rsplit_once(',')
        .map(|(_, b)| b)
        .unwrap_or(base64.as_str());
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    if bytes.is_empty() {
        return Err("粘贴内容为空".to_string());
    }
    let dir = pasted_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建粘贴目录失败: {e}"))?;
    let dest = dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
    fs::write(&dest, &bytes).map_err(|e| format!("写入粘贴文件失败: {e}"))?;
    Ok(dest.to_string_lossy().replace('\u{5c}', "/"))
}

// ── 公开搜索（GitHub API） ──────────────────────────────────────────────────

/// GitHub search response shape (only the fields we need).
#[derive(Debug, Deserialize)]
struct GhSearchResponse {
    #[serde(default)]
    items: Vec<GhRepo>,
}

#[derive(Debug, Deserialize)]
struct GhRepo {
    full_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    stargazers_count: u64,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    owner: Option<GhOwner>,
    #[serde(default)]
    default_branch: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhOwner {
    #[serde(default)]
    login: String,
}

/// Minimal percent-encoding for URL query strings (avoids adding a dependency).
fn percent_encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

/// Build a raw.githubusercontent.com SKILL.md URL guess for a repo.
fn guess_skill_md_url(full_name: &str, default_branch: Option<&str>) -> String {
    let branch = default_branch.unwrap_or("main");
    format!(
        "https://raw.githubusercontent.com/{full_name}/{branch}/SKILL.md"
    )
}

/// Search GitHub repositories by query + skill-related topics.
/// Combines results from multiple topic searches to maximize coverage.
async fn github_search_skills(query: &str, limit: usize) -> Result<Vec<PublicSkill>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

    // Build query: user keywords + topic filters for skill repos
    let q = if query.trim().is_empty() {
        "topic:claude-skill topic:ai-skill topic:agent-skill".to_string()
    } else {
        format!(
            "{} topic:claude-skill OR {} topic:ai-skill OR {} topic:agent-skill",
            query.trim(),
            query.trim(),
            query.trim()
        )
    };

    let url = format!(
        "https://api.github.com/search/repositories?q={}&per_page={}&sort=stars&order=desc",
        percent_encode_query(&q),
        limit.min(50)
    );

    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Iris-AgentBoard/1.0")
        .send()
        .await
        .map_err(|e| format!("GitHub 搜索连接失败（离线或不可达）: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        return Err(format!("GitHub API 返回 HTTP {status}（可能达到速率限制）"));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取 GitHub 响应失败: {e}"))?;

    let parsed: GhSearchResponse =
        serde_json::from_str(&body).map_err(|e| format!("GitHub 响应解析失败: {e}"))?;

    // Dedup by full_name (OR queries may return duplicates).
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for repo in parsed.items {
        if !seen.insert(repo.full_name.clone()) {
            continue;
        }
        let author = repo
            .owner
            .as_ref()
            .map(|o| o.login.clone())
            .unwrap_or_default();
        let install_url = Some(guess_skill_md_url(
            &repo.full_name,
            repo.default_branch.as_deref(),
        ));
        out.push(PublicSkill {
            id: repo.full_name.clone(),
            name: repo.name,
            description: repo.description.unwrap_or_default(),
            author,
            source_url: repo.html_url,
            install_url,
            stars: repo.stargazers_count,
            topics: repo.topics,
        });
    }
    Ok(out)
}

/// 搜索公开 Skills（GitHub 仓库，按 skill 相关 topic 过滤）。
/// `query` 为用户搜索词；`source` 保留扩展（目前仅 github）。
#[tauri::command]
pub(crate) async fn skills_search_public(
    query: String,
    source: Option<String>,
) -> Result<Vec<PublicSkill>, String> {
    let _ = source; // reserved for future sources
    github_search_skills(&query, 30).await
}

/// 从公开 skill 的 SKILL.md URL 下载并安装（与市场安装同流程：
/// 拉正文 → build_skill_md → 写入共享目录）。
/// `skill_id` 格式 `owner/repo`，`skill_md_url` 为 raw.githubusercontent URL。
#[tauri::command]
pub(crate) async fn skills_public_install(
    app: AppHandle,
    skill_id: String,
    skill_md_url: String,
) -> Result<String, String> {
    // Validate URL: only allow raw.githubusercontent.com
    if !skill_md_url.starts_with("https://raw.githubusercontent.com/") {
        return Err("仅允许从 raw.githubusercontent.com 安装".to_string());
    }

    let body = http_get_text(&skill_md_url).await.map_err(|_| {
        format!(
            "该仓库不包含 SKILL.md（{}），请手动克隆安装",
            skill_md_url
        )
    })?;

    // Derive name from the repo name part of skill_id (owner/repo → repo).
    let repo_name = skill_id
        .split('/')
        .nth(1)
        .unwrap_or(&skill_id);
    let name = normalize_skill_name(repo_name);

    // If the body already has frontmatter, use it as-is; otherwise wrap it.
    let content = if body.trim_start().starts_with("---") {
        // Already has frontmatter — strip BOM and use directly.
        body.trim_start_matches('\u{feff}').to_string()
    } else {
        // No frontmatter — wrap with generated name/description.
        let desc = format!("Public skill from {}", skill_id);
        build_skill_md(&name, &desc, &body)
    };

    let dir = shared_skills_dir(&app)?.join(&name);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 skill 目录失败: {e}"))?;
    let dest = dir.join("SKILL.md");
    fs::write(&dest, content.as_bytes()).map_err(|e| format!("写入 SKILL.md 失败: {e}"))?;
    Ok(dest.to_string_lossy().replace('\u{5c}', "/"))
}

// ── skills.sh 热门静态镜像 ──────────────────────────────────────────────────
// skills.sh API (api/v1) 需要 Vercel OIDC 认证（无 key 返回 401），
// 因此在后端维护一份从 skills.sh 网页手动抓取的热门 skills 静态列表。
// 前端「公开搜索」tab 在「skills.sh 热门」分区展示这些条目。

/// skills.sh 热门 skill 条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillsShEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub installs: String,
    pub url: String,
}

/// 返回 skills.sh 热门 skills 静态镜像（数据来源：skills.sh/trending，2026-07 抓取）。
pub fn skills_sh_catalog() -> Vec<SkillsShEntry> {
    vec![
        SkillsShEntry {
            id: "vercel-labs/find-skills".into(),
            name: "find-skills".into(),
            description: "帮助 agent 发现和推荐合适的 skill".into(),
            author: "Vercel Labs".into(),
            installs: "579k+".into(),
            url: "https://skills.sh/vercel-labs/find-skills".into(),
        },
        SkillsShEntry {
            id: "vercel-labs/vercel-react-best-practices".into(),
            name: "vercel-react-best-practices".into(),
            description: "40+ React/Next.js 性能规则，8 大类最佳实践".into(),
            author: "Vercel Labs".into(),
            installs: "216k+".into(),
            url: "https://skills.sh/vercel-labs/vercel-react-best-practices".into(),
        },
        SkillsShEntry {
            id: "vercel-labs/web-design-guidelines".into(),
            name: "web-design-guidelines".into(),
            description: "100+ 网页设计规则：可访问性、排版、图片、暗色模式、UX".into(),
            author: "Vercel Labs".into(),
            installs: "171k+".into(),
            url: "https://skills.sh/vercel-labs/web-design-guidelines".into(),
        },
        SkillsShEntry {
            id: "anthropic/frontend-design".into(),
            name: "frontend-design".into(),
            description: "Anthropic 官方前端设计 skill：组件架构、样式约定".into(),
            author: "Anthropic".into(),
            installs: "164k+".into(),
            url: "https://skills.sh/anthropic/frontend-design".into(),
        },
        SkillsShEntry {
            id: "vercel-labs/next-app-best-practices".into(),
            name: "next-app-best-practices".into(),
            description: "Next.js App Router 最佳实践：路由、缓存、数据获取".into(),
            author: "Vercel Labs".into(),
            installs: "130k+".into(),
            url: "https://skills.sh/vercel-labs/next-app-best-practices".into(),
        },
        SkillsShEntry {
            id: "expo/skills".into(),
            name: "expo-skills".into(),
            description: "Expo/React Native 开发 skill：导航、原生模块、构建配置".into(),
            author: "Expo".into(),
            installs: "95k+".into(),
            url: "https://skills.sh/expo/skills".into(),
        },
        SkillsShEntry {
            id: "supabase/supabase-skill".into(),
            name: "supabase-skill".into(),
            description: "Supabase 全栈开发：数据库设计、Auth、Edge Functions、实时订阅".into(),
            author: "Supabase".into(),
            installs: "88k+".into(),
            url: "https://skills.sh/supabase/supabase-skill".into(),
        },
        SkillsShEntry {
            id: "tailwindlabs/tailwind-skill".into(),
            name: "tailwind-skill".into(),
            description: "Tailwind CSS 最佳实践：工具类组合、响应式设计、主题定制".into(),
            author: "Tailwind Labs".into(),
            installs: "82k+".into(),
            url: "https://skills.sh/tailwindlabs/tailwind-skill".into(),
        },
        SkillsShEntry {
            id: "prisma/prisma-skill".into(),
            name: "prisma-skill".into(),
            description: "Prisma ORM skill：Schema 设计、查询优化、迁移管理".into(),
            author: "Prisma".into(),
            installs: "67k+".into(),
            url: "https://skills.sh/prisma/prisma-skill".into(),
        },
        SkillsShEntry {
            id: "stripe/stripe-agent-skill".into(),
            name: "stripe-agent-skill".into(),
            description: "Stripe 支付集成：Checkout、Subscriptions、Webhooks 最佳实践".into(),
            author: "Stripe".into(),
            installs: "54k+".into(),
            url: "https://skills.sh/stripe/stripe-agent-skill".into(),
        },
        SkillsShEntry {
            id: "vercel-labs/v0-skill".into(),
            name: "v0-skill".into(),
            description: "v0 AI UI 生成规则：shadcn/ui 组件、设计系统约定".into(),
            author: "Vercel Labs".into(),
            installs: "48k+".into(),
            url: "https://skills.sh/vercel-labs/v0-skill".into(),
        },
        SkillsShEntry {
            id: "firecrawl/firecrawl-skill".into(),
            name: "firecrawl-skill".into(),
            description: "Firecrawl 网页爬取 skill：结构化数据提取、批量抓取".into(),
            author: "Firecrawl".into(),
            installs: "41k+".into(),
            url: "https://skills.sh/firecrawl/firecrawl-skill".into(),
        },
    ]
}

/// 搜索 skills.sh 热门 skills（本地静态匹配）。
#[tauri::command]
pub(crate) async fn skills_sh_search(query: String) -> Result<Vec<SkillsShEntry>, String> {
    let q = query.trim().to_lowercase();
    let all = skills_sh_catalog();
    if q.is_empty() {
        return Ok(all);
    }
    Ok(all
        .into_iter()
        .filter(|e| {
            e.name.to_lowercase().contains(&q)
                || e.description.to_lowercase().contains(&q)
                || e.author.to_lowercase().contains(&q)
        })
        .collect())
}
// ── 单元测试 ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_skill_name_rules() {
        assert_eq!(normalize_skill_name("Abstract_Writer"), "abstract-writer");
        assert_eq!(normalize_skill_name("  Full Paper  Pipeline! "), "full-paper-pipeline");
        assert_eq!(normalize_skill_name("已经中文"), "skill"); // 全非 ascii → 兜底
        assert_eq!(normalize_skill_name("a"), "a");
        let long = normalize_skill_name(&"ab-".repeat(40));
        assert!(long.len() <= MAX_NAME_LEN && !long.ends_with('-'));
    }

    #[test]
    fn validate_skill_name_guards_traversal() {
        assert!(validate_skill_name("abstract-writer").is_ok());
        assert!(validate_skill_name("..").is_err());
        assert!(validate_skill_name("a/b").is_err());
        assert!(validate_skill_name("A").is_err());
        assert!(validate_skill_name("").is_err());
    }

    #[test]
    fn yaml_escape_flattens_and_truncates() {
        assert_eq!(yaml_escape_description("a\nb\t\"c\"\u{5c}d"), "a b \u{5c}\"c\u{5c}\"\u{5c}\u{5c}d");
        let long = yaml_escape_description(&"x".repeat(3000));
        assert!(long.chars().count() <= MAX_DESC_LEN);
    }

    #[test]
    fn build_and_parse_skill_md_roundtrip() {
        let md = build_skill_md("fmt-check", "检查 \"格式\"\n换行", "# 正文\nbody");
        assert!(!md.starts_with('\u{feff}'), "无 BOM");
        assert!(md.starts_with("---\nname: fmt-check\n"));
        assert!(md.ends_with("# 正文\nbody"));
        let (name, desc) = parse_frontmatter(&md);
        assert_eq!(name.as_deref(), Some("fmt-check"));
        assert_eq!(desc.as_deref(), Some("检查 \"格式\" 换行"));
    }

    #[test]
    fn parse_frontmatter_tolerates_junk() {
        assert_eq!(parse_frontmatter("no frontmatter"), (None, None));
        let (n, d) = parse_frontmatter("---\nname: x\nweird line\n---\nbody");
        assert_eq!(n.as_deref(), Some("x"));
        assert_eq!(d, None);
    }

    #[test]
    fn validate_market_file_rules() {
        assert!(validate_market_file("skills/a_b-1.md").is_ok());
        assert!(validate_market_file("agents/x.md").is_ok());
        assert!(validate_market_file("agents/../x.md").is_err());
        assert!(validate_market_file("other/x.md").is_err());
        assert!(validate_market_file("skills/x.txt").is_err());
    }

    #[test]
    fn merge_index_tags_kinds() {
        let idx = RawIndex {
            agents: vec![RawEntry {
                id: "a".into(),
                name: "A".into(),
                description: String::new(),
                category: "写作".into(),
                tags: vec![],
                file: "agents/a.md".into(),
            }],
            skills: vec![RawEntry {
                id: "s".into(),
                name: "S".into(),
                description: "d".into(),
                category: String::new(),
                tags: vec!["t".into()],
                file: "skills/s.md".into(),
            }],
        };
        let merged = merge_index(idx);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].kind, "skill");
        assert_eq!(merged[1].kind, "agent");
    }

    #[test]
    fn mirror_skills_into_skips_empty_and_copies_content() {
        let shared = tempfile::tempdir().unwrap();
        let session = tempfile::tempdir().unwrap();

        // 空共享目录 → None。
        assert!(mirror_skills_into(shared.path(), session.path()).is_none());
        // 没有 SKILL.md 的杂物 → 仍然 None。
        fs::write(shared.path().join("readme.txt"), "x").unwrap();
        assert!(mirror_skills_into(shared.path(), session.path()).is_none());

        // 放入一个规范 skill → Some(<session>/skills) 且文件被复制。
        let sk = shared.path().join("fmt-check");
        fs::create_dir_all(&sk).unwrap();
        fs::write(sk.join("SKILL.md"), build_skill_md("fmt-check", "d", "body")).unwrap();
        let dest = mirror_skills_into(shared.path(), session.path()).expect("should mirror");
        assert_eq!(dest, session.path().join("skills"));
        let copied = fs::read_to_string(dest.join("fmt-check").join("SKILL.md")).unwrap();
        assert!(copied.contains("name: fmt-check"));
    }

    #[test]
    fn contains_skill_md_recurses() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!contains_skill_md(tmp.path()));
        let deep = tmp.path().join("a").join("b");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("SKILL.md"), "x").unwrap();
        assert!(contains_skill_md(tmp.path()));
    }
}
