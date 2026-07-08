//! Research integration backend (H5).
//!
//! Read-only scanning + controlled markdown editing of two external local
//! research toolkits, plus a run dashboard aggregated from their state files.
//!
//! ## Security model
//! The two roots are settings-backed absolute paths (research_agents_root,
//! research_skills_root). Every read/write command takes an absolute path from
//! the frontend that MUST resolve inside one of the two roots (lexical .. guard
//! + symlink-escape check). Writes are restricted to .md files. The source
//! directories are READ-ONLY except for the explicit markdown-edit commands.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::AppState;
use crate::db::Db;

// -- Default roots + settings keys -------------------------------------------

pub const AGENTS_ROOT_KEY: &str = "research_agents_root";
pub const SKILLS_ROOT_KEY: &str = "research_skills_root";

pub const DEFAULT_AGENTS_ROOT: &str = r"D:\服务器\agent管理";
pub const DEFAULT_SKILLS_ROOT: &str = r"D:\服务器\skills管理";

/// Files larger than this are never read into memory in full.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024; // 2 MB (some run reports are large)

fn agents_root(db: &Db) -> PathBuf {
    let s = db
        .settings_get(AGENTS_ROOT_KEY)
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_AGENTS_ROOT.to_string());
    PathBuf::from(s)
}

fn skills_root(db: &Db) -> PathBuf {
    let s = db
        .settings_get(SKILLS_ROOT_KEY)
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SKILLS_ROOT.to_string());
    PathBuf::from(s)
}

// -- Path safety -------------------------------------------------------------

/// Reject any path containing a ParentDir component (lexical traversal guard).
fn has_parent_component(p: &Path) -> bool {
    p.components().any(|c| matches!(c, Component::ParentDir))
}

/// Return the deepest ancestor of p (including p) that exists on disk.
fn deepest_existing(p: &Path) -> PathBuf {
    let mut cur = p;
    loop {
        if cur.exists() {
            return cur.to_path_buf();
        }
        match cur.parent() {
            Some(par) if par != cur => cur = par,
            _ => return cur.to_path_buf(),
        }
    }
}

/// Verify that target resolves inside root (both may be non-canonical).
/// Rejects traversal and symlink escape. Returns the confined path.
fn confine_to_root(root: &Path, target: &Path) -> Result<PathBuf, String> {
    if has_parent_component(target) {
        return Err("路径包含非法的 .. 穿越".to_string());
    }
    let canon_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let anchor = deepest_existing(target);
    let canon_anchor = anchor.canonicalize().unwrap_or(anchor);
    if canon_anchor.starts_with(&canon_root) {
        Ok(target.to_path_buf())
    } else {
        Err("路径超出源目录范围".to_string())
    }
}

/// Windows path literals kept as consts to avoid escaping headaches.
const BACKSLASH: char = '\\';
const DOUBLE_BACKSLASH: &str = "\\\\";
const RAW_VERBATIM: &str = "\\\\?\\";
const RAW_UNC: &str = "\\\\?\\UNC\\";

/// Forward-slash display of a path (strips Windows verbatim prefix).
fn disp(p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = s
        .strip_prefix(RAW_UNC)
        .map(|r| format!("{}{}", DOUBLE_BACKSLASH, r))
        .unwrap_or_else(|| s.strip_prefix(RAW_VERBATIM).unwrap_or(&s).to_string());
    s.replace(BACKSLASH, "/")
}

// -- Markdown metadata parsing -----------------------------------------------

/// Parsed metadata from a research agent / skill markdown file.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MdMeta {
    /// Logical id (e.g. literature_search), from the ID field or filename.
    pub name: String,
    /// Human title, from the first heading.
    pub title: String,
    /// One-line description, from the role/Description section.
    pub description: String,
    /// Category / group, from the group/Category field, else the parent dir.
    pub category: String,
    /// Absolute source path (forward slashes).
    pub path: String,
}

/// Extract the value of an inline field like an ID or group bold label.
fn field_value(body: &str, labels: &[&str]) -> Option<String> {
    for line in body.lines() {
        let t = line.trim_start_matches(['-', ' ', '\t']).trim();
        for label in labels {
            let needle = format!("**{}**", label);
            if let Some(rest) = t.strip_prefix(&needle) {
                let v = rest
                    .trim_start()
                    .trim_start_matches(':')
                    .trim()
                    .trim_matches('`')
                    .trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// First H1 heading line, stripped of leading hashes.
fn first_heading(body: &str) -> Option<String> {
    for line in body.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("# ") {
            let h = rest.trim();
            if !h.is_empty() {
                return Some(h.to_string());
            }
        }
    }
    None
}

/// First non-empty paragraph under any of the given section headings.
fn section_paragraph(body: &str, section_labels: &[&str]) -> Option<String> {
    let lines: Vec<&str> = body.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let t = lines[i].trim();
        let is_target = t.starts_with("## ")
            && section_labels
                .iter()
                .any(|lbl| t[3..].trim().starts_with(lbl));
        if is_target {
            let mut para = String::new();
            let mut j = i + 1;
            while j < lines.len() {
                let l = lines[j].trim();
                if l.is_empty() {
                    if !para.is_empty() {
                        break;
                    }
                } else if l.starts_with('#') || l.starts_with("```") {
                    break;
                } else {
                    if !para.is_empty() {
                        para.push(' ');
                    }
                    para.push_str(l);
                }
                j += 1;
            }
            if !para.is_empty() {
                return Some(para);
            }
        }
        i += 1;
    }
    None
}

/// Parse a research markdown file into MdMeta.
fn parse_md_meta(path: &Path, body: &str, fallback_category: &str) -> MdMeta {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let name = field_value(body, &["ID"]).unwrap_or_else(|| stem.clone());
    let title = first_heading(body).unwrap_or_else(|| stem.clone());
    let category = field_value(body, &["分组", "Category", "分类"])
        .unwrap_or_else(|| fallback_category.to_string());
    let description = section_paragraph(body, &["角色描述", "Description", "描述"])
        .map(|d| {
            let truncated: String = d.chars().take(400).collect();
            truncated
        })
        .unwrap_or_default();

    MdMeta {
        name,
        title,
        description,
        category,
        path: disp(path),
    }
}

// -- Directory scanning ------------------------------------------------------

/// Read a text file with a size cap; returns Err for missing / too-large.
fn read_text_capped(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("文件过大，超过 {} 字节", MAX_FILE_BYTES));
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

/// Scan agent markdown files under <agents_root>/agents/*.md.
fn scan_agents(agents_root: &Path) -> Vec<MdMeta> {
    let dir = agents_root.join("agents");
    let mut out = Vec::new();
    let rd = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        if let Ok(body) = read_text_capped(&p) {
            out.push(parse_md_meta(&p, &body, "agent"));
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Recursively scan skill markdown files under <skills_root>/skills/**/*.md.
/// The immediate subdirectory name is the fallback category.
fn scan_skills(skills_root: &Path) -> Vec<MdMeta> {
    let base = skills_root.join("skills");
    let mut out = Vec::new();
    let cats = match fs::read_dir(&base) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for cat_entry in cats.flatten() {
        let cat_path = cat_entry.path();
        let cat_name = cat_entry.file_name().to_string_lossy().to_string();
        if cat_path.is_dir() {
            scan_skill_dir(&cat_path, &cat_name, &mut out);
        } else if cat_path.extension().and_then(|s| s.to_str()) == Some("md") {
            if let Ok(body) = read_text_capped(&cat_path) {
                out.push(parse_md_meta(&cat_path, &body, "workflow"));
            }
        }
    }
    out.sort_by(|a, b| {
        a.category
            .to_lowercase()
            .cmp(&b.category.to_lowercase())
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

fn scan_skill_dir(dir: &Path, category: &str, out: &mut Vec<MdMeta>) {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            scan_skill_dir(&p, category, out);
        } else if p.extension().and_then(|s| s.to_str()) == Some("md") {
            if let Ok(body) = read_text_capped(&p) {
                out.push(parse_md_meta(&p, &body, category));
            }
        }
    }
}

// -- Pipelines ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PipelineInfo {
    /// Pipeline id (JSON key, or the skill file stem).
    pub id: String,
    pub name: String,
    pub description: String,
    /// Ordered agent / skill ids that make up the flow (best-effort).
    pub steps: Vec<String>,
    /// "agent" (from pipelines.json) or "skill" (workflow-category md).
    pub source: String,
}

/// Read <agents_root>/workflows/pipelines.json + skills-management workflow md.
fn scan_pipelines(agents_root: &Path, skills_root: &Path) -> Vec<PipelineInfo> {
    let mut out = Vec::new();

    let pj = agents_root.join("workflows").join("pipelines.json");
    if let Ok(body) = read_text_capped(&pj) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(map) = v.get("pipelines").and_then(|p| p.as_object()) {
                for (id, pl) in map {
                    let name = pl
                        .get("name")
                        .and_then(|x| x.as_str())
                        .unwrap_or(id)
                        .to_string();
                    let description = pl
                        .get("description")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let mut steps = Vec::new();
                    if let Some(arr) = pl.get("steps").and_then(|x| x.as_array()) {
                        for st in arr {
                            if let Some(a) = st.get("agent").and_then(|x| x.as_str()) {
                                steps.push(a.to_string());
                            } else if let Some(pr) =
                                st.get("pipeline_ref").and_then(|x| x.as_str())
                            {
                                steps.push(format!("↳ {}", pr));
                            } else if let Some(par) =
                                st.get("agents_parallel").and_then(|x| x.as_array())
                            {
                                for ap in par {
                                    if let Some(a) = ap.get("agent").and_then(|x| x.as_str()) {
                                        steps.push(a.to_string());
                                    }
                                }
                            }
                        }
                    }
                    out.push(PipelineInfo {
                        id: id.clone(),
                        name,
                        description,
                        steps,
                        source: "agent".to_string(),
                    });
                }
            }
        }
    }

    let wf_dir = skills_root.join("skills").join("workflow");
    if let Ok(rd) = fs::read_dir(&wf_dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            if let Ok(body) = read_text_capped(&p) {
                let meta = parse_md_meta(&p, &body, "workflow");
                out.push(PipelineInfo {
                    id: meta.name.clone(),
                    name: meta.title,
                    description: meta.description,
                    steps: Vec::new(),
                    source: "skill".to_string(),
                });
            }
        }
    }

    out.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));
    out
}

// -- Dashboard aggregation ---------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct RunArtifact {
    pub kind: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardRun {
    pub id: String,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub current_stage: String,
    pub artifacts: Vec<RunArtifact>,
    pub stages: Vec<DashboardStage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardStage {
    pub title: String,
    pub status: String,
    pub progress: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillStat {
    pub name: String,
    pub status: String,
    pub runs: i64,
    pub successes: i64,
    pub last_run: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub skill: String,
    pub status: String,
    pub project: String,
    pub finished: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Dashboard {
    pub skills: Vec<SkillStat>,
    pub runs: Vec<DashboardRun>,
    pub logs: Vec<LogEntry>,
    pub kb_total_papers: i64,
    pub kb_total_size_mb: f64,
    pub kb_last_scan: Option<String>,
}

fn json_str(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// Discover html / pdf / tex artifacts inside a run directory.
fn discover_artifacts(run_dir: &Path) -> Vec<RunArtifact> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(run_dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            let kind = match ext.as_str() {
                "html" | "htm" => "html",
                "pdf" => "pdf",
                "tex" => "tex",
                _ => continue,
            };
            out.push(RunArtifact {
                kind: kind.to_string(),
                path: disp(&p),
            });
        }
    }
    out.sort_by_key(|a| match a.kind.as_str() {
        "html" => 0,
        "pdf" => 1,
        "tex" => 2,
        _ => 3,
    });
    out
}

/// Parse one workflow_runs/wf_*.json file into a DashboardRun.
fn parse_run(json_path: &Path, run_dir: &Path) -> Option<DashboardRun> {
    let body = read_text_capped(json_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;

    let id = if json_str(&v, "id").is_empty() {
        json_path
            .file_stem()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        json_str(&v, "id")
    };
    let title = {
        let topic = json_str(&v, "topic");
        if topic.is_empty() { id.clone() } else { topic }
    };

    let mut stages = Vec::new();
    if let Some(arr) = v.get("stages").and_then(|x| x.as_array()) {
        for st in arr {
            stages.push(DashboardStage {
                title: json_str(st, "title"),
                status: json_str(st, "status"),
                progress: st.get("progress").and_then(|x| x.as_i64()).unwrap_or(0),
            });
        }
    }

    let artifacts = if run_dir.is_dir() {
        discover_artifacts(run_dir)
    } else {
        Vec::new()
    };

    Some(DashboardRun {
        id,
        title,
        status: json_str(&v, "status"),
        created_at: json_str(&v, "created_at"),
        updated_at: json_str(&v, "updated_at"),
        current_stage: json_str(&v, "current_stage"),
        artifacts,
        stages,
    })
}

/// Strip a leading UTF-8 BOM (EF BB BF) if present.
fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

/// Assemble the full dashboard from skills_root.
fn build_dashboard(skills_root: &Path) -> Dashboard {
    let mut skills = Vec::new();
    let mut kb_total_papers = 0;
    let mut kb_total_size_mb = 0.0;
    let mut kb_last_scan = None;

    let state_path = skills_root.join("config").join("state.json");
    if let Ok(body) = read_text_capped(&state_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(strip_bom(&body)) {
            if let Some(map) = v.get("skills").and_then(|x| x.as_object()) {
                for (name, st) in map {
                    skills.push(SkillStat {
                        name: name.clone(),
                        status: json_str(st, "status"),
                        runs: st.get("runs").and_then(|x| x.as_i64()).unwrap_or(0),
                        successes: st
                            .get("successes")
                            .and_then(|x| x.as_i64())
                            .unwrap_or(0),
                        last_run: st
                            .get("last_run")
                            .and_then(|x| x.as_str())
                            .map(|x| x.to_string()),
                        summary: st
                            .get("summary")
                            .and_then(|x| x.as_str())
                            .map(|x| x.to_string()),
                    });
                }
            }
            if let Some(kb) = v.get("kb") {
                kb_total_papers =
                    kb.get("total_papers").and_then(|x| x.as_i64()).unwrap_or(0);
                kb_total_size_mb = kb
                    .get("total_size_mb")
                    .and_then(|x| x.as_f64())
                    .unwrap_or(0.0);
                kb_last_scan = kb
                    .get("last_scan")
                    .and_then(|x| x.as_str())
                    .map(|x| x.to_string());
            }
        }
    }
    skills.sort_by(|a, b| {
        b.runs
            .cmp(&a.runs)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let mut runs = Vec::new();
    let runs_dir = skills_root.join("workflow_runs");
    if let Ok(rd) = fs::read_dir(&runs_dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let stem = p
                .file_stem()
                .map(|x| x.to_string_lossy().to_string())
                .unwrap_or_default();
            let run_dir = runs_dir.join(&stem);
            if let Some(run) = parse_run(&p, &run_dir) {
                runs.push(run);
            }
        }
    }
    runs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    let mut logs = Vec::new();
    let log_path = skills_root.join("logs").join("execution_log.jsonl");
    if let Ok(body) = read_text_capped(&log_path) {
        for line in strip_bom(&body).lines() {
            let line = strip_bom(line).trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                logs.push(LogEntry {
                    skill: json_str(&v, "skill"),
                    status: json_str(&v, "status"),
                    project: json_str(&v, "project"),
                    finished: json_str(&v, "finished"),
                    summary: json_str(&v, "summary"),
                });
            }
        }
    }
    logs.reverse();
    logs.truncate(50);

    Dashboard {
        skills,
        runs,
        logs,
        kb_total_papers,
        kb_total_size_mb,
        kb_last_scan,
    }
}

// -- Run pipeline (workbench hand-off) ---------------------------------------

/// Parameters returned to the frontend to open a pipeline / agent / skill in
/// the existing workbench engine (the safe path — we do NOT execute their
/// server.js or scripts). The frontend uses these to requestReuse + navigate.
#[derive(Debug, Clone, Serialize)]
pub struct RunLaunch {
    /// Working directory to open the workbench in (an agents/skills root).
    pub cwd: String,
    /// Pre-filled first prompt describing the pipeline / agent to run.
    pub prompt: String,
    /// Human label for the launched pipeline.
    pub label: String,
}

/// Build a launch descriptor for a pipeline id.
fn build_run_launch(
    agents_root: &Path,
    skills_root: &Path,
    id: &str,
    input: Option<&str>,
) -> Result<RunLaunch, String> {
    let pipelines = scan_pipelines(agents_root, skills_root);
    let pl = pipelines
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("未找到流水线: {id}"))?;

    let cwd = if pl.source == "skill" {
        disp(skills_root)
    } else {
        disp(agents_root)
    };

    let mut prompt = String::new();
    prompt.push_str(&format!("请执行科研流水线「{}」（id: {}）。\n", pl.name, pl.id));
    if !pl.description.is_empty() {
        prompt.push_str(&format!("流水线说明：{}\n", pl.description));
    }
    if !pl.steps.is_empty() {
        prompt.push_str(&format!(
            "按顺序协作的 agent/skill：{}\n",
            pl.steps.join(" -> ")
        ));
    }
    prompt.push_str(&format!(
        "相关 agent/skill 的定义位于本工作目录（{}）下的 agents/ 或 skills/ 目录，请据此逐步执行并给出结构化产出。\n",
        cwd
    ));
    if let Some(inp) = input {
        let inp = inp.trim();
        if !inp.is_empty() {
            prompt.push_str(&format!("\n用户输入 / 主题：\n{}\n", inp));
        }
    }

    Ok(RunLaunch {
        cwd,
        prompt,
        label: pl.name,
    })
}

// -- Tauri commands ----------------------------------------------------------

/// The two configured source roots (defaults applied).
#[derive(Debug, Clone, Serialize)]
pub struct ResearchRoots {
    pub agents_root: String,
    pub skills_root: String,
}

#[tauri::command]
pub(crate) async fn research_roots(state: State<'_, AppState>) -> Result<ResearchRoots, String> {
    Ok(ResearchRoots {
        agents_root: disp(&agents_root(&state.db)),
        skills_root: disp(&skills_root(&state.db)),
    })
}

/// List all research agents (agent管理/agents/*.md).
#[tauri::command]
pub(crate) async fn research_agents(state: State<'_, AppState>) -> Result<Vec<MdMeta>, String> {
    Ok(scan_agents(&agents_root(&state.db)))
}

/// Read one agent markdown file (path must live under the agents root).
#[tauri::command]
pub(crate) async fn research_agent_read(
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = agents_root(&state.db);
    let p = confine_to_root(&root, &PathBuf::from(path.trim()))?;
    read_text_capped(&p)
}

/// Write one agent markdown file (.md only, confined to the agents root).
#[tauri::command]
pub(crate) async fn research_agent_write(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = agents_root(&state.db);
    let p = confine_to_root(&root, &PathBuf::from(path.trim()))?;
    if p.extension().and_then(|s| s.to_str()) != Some("md") {
        return Err("只能编辑 .md 文件".to_string());
    }
    fs::write(&p, content.as_bytes()).map_err(|e| e.to_string())
}

/// List all research skills (skills管理/skills/**/*.md).
#[tauri::command]
pub(crate) async fn research_skills(state: State<'_, AppState>) -> Result<Vec<MdMeta>, String> {
    Ok(scan_skills(&skills_root(&state.db)))
}

/// Read one skill markdown file (path must live under the skills root).
#[tauri::command]
pub(crate) async fn research_skill_read(
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = skills_root(&state.db);
    let p = confine_to_root(&root, &PathBuf::from(path.trim()))?;
    read_text_capped(&p)
}

/// Write one skill markdown file (.md only, confined to the skills root).
#[tauri::command]
pub(crate) async fn research_skill_write(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = skills_root(&state.db);
    let p = confine_to_root(&root, &PathBuf::from(path.trim()))?;
    if p.extension().and_then(|s| s.to_str()) != Some("md") {
        return Err("只能编辑 .md 文件".to_string());
    }
    fs::write(&p, content.as_bytes()).map_err(|e| e.to_string())
}

/// List runnable pipelines (agent pipelines.json + skill workflow md).
#[tauri::command]
pub(crate) async fn research_pipelines(
    state: State<'_, AppState>,
) -> Result<Vec<PipelineInfo>, String> {
    Ok(scan_pipelines(&agents_root(&state.db), &skills_root(&state.db)))
}

/// Assemble the run dashboard (state.json + workflow_runs + execution log).
#[tauri::command]
pub(crate) async fn research_dashboard(state: State<'_, AppState>) -> Result<Dashboard, String> {
    Ok(build_dashboard(&skills_root(&state.db)))
}

/// Read a run artifact (html / tex text). Path must live under the skills root.
/// PDFs are opened by the frontend via convertFileSrc, not through this command.
#[tauri::command]
pub(crate) async fn research_run_output_read(
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = skills_root(&state.db);
    let p = confine_to_root(&root, &PathBuf::from(path.trim()))?;
    read_text_capped(&p)
}

/// Run a pipeline via the safe workbench hand-off path.
#[tauri::command]
pub(crate) async fn research_run_pipeline(
    id: String,
    input: Option<String>,
    state: State<'_, AppState>,
) -> Result<RunLaunch, String> {
    let agents = agents_root(&state.db);
    let skills = skills_root(&state.db);
    build_run_launch(&agents, &skills, &id, input.as_deref())
}

// -- Unit tests --------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_f(p: &Path, body: &str) {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, body).unwrap();
    }

    #[test]
    fn parse_agent_md_extracts_id_title_category_desc() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("agents").join("literature_search.md");
        let body = "# Literature Search Agent\n\n## 基本信息\n- **ID**: `literature_search`\n- **分组**: Research\n- **状态**: Active\n\n## 角色描述\n专门负责根据给定的研究主题检索论文。\n能够使用多个学术数据库。\n\n## 系统提示词\n";
        write_f(&p, body);
        let meta = parse_md_meta(&p, body, "agent");
        assert_eq!(meta.name, "literature_search");
        assert_eq!(meta.title, "Literature Search Agent");
        assert_eq!(meta.category, "Research");
        assert!(meta.description.contains("检索论文"));
        assert!(meta.description.contains("学术数据库"));
    }

    #[test]
    fn parse_md_falls_back_to_stem_and_category() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("mystery.md");
        let body = "some text without headings or fields\n";
        write_f(&p, body);
        let meta = parse_md_meta(&p, body, "workflow");
        assert_eq!(meta.name, "mystery");
        assert_eq!(meta.title, "mystery");
        assert_eq!(meta.category, "workflow");
        assert_eq!(meta.description, "");
    }

    #[test]
    fn scan_agents_finds_only_md() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_f(&root.join("agents").join("a.md"), "# A\n- **ID**: `a`\n");
        write_f(&root.join("agents").join("b.md"), "# B\n- **ID**: `b`\n");
        write_f(&root.join("agents").join("notes.txt"), "ignore me");
        let agents = scan_agents(root);
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].name, "a");
        assert_eq!(agents[1].name, "b");
    }

    #[test]
    fn scan_skills_uses_subdir_as_category() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_f(
            &root.join("skills").join("research").join("lit.md"),
            "# Lit\n## Meta\n- **ID**: `lit`\n",
        );
        write_f(
            &root.join("skills").join("writing").join("abs.md"),
            "# Abstract\n## Meta\n- **ID**: `abs`\n",
        );
        let skills = scan_skills(root);
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].name, "lit");
        assert_eq!(skills[0].category, "research");
        assert_eq!(skills[1].category, "writing");
    }

    #[test]
    fn confine_rejects_traversal_and_outside() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("agents")).unwrap();
        write_f(&root.join("agents").join("x.md"), "# X\n");

        let ok = confine_to_root(root, &root.join("agents").join("x.md"));
        assert!(ok.is_ok());

        let bad = confine_to_root(root, &root.join("agents").join("..").join("secret"));
        assert!(bad.is_err());

        let outside = tmp.path().parent().unwrap().join("evil.md");
        let bad2 = confine_to_root(root, &outside);
        assert!(bad2.is_err());
    }

    #[test]
    fn scan_pipelines_reads_json_and_workflow_md() {
        let tmp = TempDir::new().unwrap();
        let agents = tmp.path().join("agents_root");
        let skills = tmp.path().join("skills_root");
        let pj = agents.join("workflows").join("pipelines.json");
        write_f(
            &pj,
            r#"{"pipelines":{"p1":{"name":"研究流水线","description":"desc","steps":[{"step":1,"agent":"literature_search"},{"step":2,"agent":"idea_extraction"}]}}}"#,
        );
        write_f(
            &skills.join("skills").join("workflow").join("full.md"),
            "# Full Pipeline\n## Meta\n- **ID**: `full_paper_pipeline`\n\n## Description\n端到端流程。\n",
        );
        let pls = scan_pipelines(&agents, &skills);
        assert_eq!(pls.len(), 2);
        let p1 = pls.iter().find(|p| p.id == "p1").unwrap();
        assert_eq!(p1.name, "研究流水线");
        assert_eq!(p1.steps, vec!["literature_search", "idea_extraction"]);
        assert_eq!(p1.source, "agent");
        let full = pls.iter().find(|p| p.id == "full_paper_pipeline").unwrap();
        assert_eq!(full.source, "skill");
    }

    #[test]
    fn build_dashboard_aggregates_state_runs_logs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_f(
            &root.join("config").join("state.json"),
            r#"{"skills":{"literature_search":{"status":"idle","runs":3,"successes":2,"last_run":"2026-06-25","summary":"found papers"},"idea_extraction":{"status":"idle","runs":0,"successes":0}},"kb":{"total_papers":321,"total_size_mb":914.2,"last_scan":"2026-06-26"}}"#,
        );
        write_f(
            &root.join("workflow_runs").join("wf_abc.json"),
            r#"{"id":"wf_abc","topic":"CKKS bootstrapping","status":"completed","current_stage":"polish","created_at":"2026-06-30T09:00:00Z","updated_at":"2026-06-30T09:22:00Z","stages":[{"id":"lit","title":"Literature","status":"completed","progress":100}]}"#,
        );
        write_f(&root.join("workflow_runs").join("wf_abc").join("main.tex"), "\\documentclass{article}");
        write_f(&root.join("workflow_runs").join("wf_abc").join("paper.pdf"), "%PDF-1.4");
        write_f(
            &root.join("logs").join("execution_log.jsonl"),
            "\u{feff}{\"skill\":\"knowledge_base_monitor\",\"status\":\"success\",\"project\":\"kb\",\"finished\":\"2026-06-25\",\"summary\":\"277 papers\"}\n",
        );

        let dash = build_dashboard(root);
        assert_eq!(dash.kb_total_papers, 321);
        assert!((dash.kb_total_size_mb - 914.2).abs() < 0.01);
        assert_eq!(dash.skills[0].name, "literature_search");
        assert_eq!(dash.skills[0].runs, 3);
        assert_eq!(dash.runs.len(), 1);
        let run = &dash.runs[0];
        assert_eq!(run.id, "wf_abc");
        assert_eq!(run.title, "CKKS bootstrapping");
        assert_eq!(run.stages.len(), 1);
        assert!(run.artifacts.iter().any(|a| a.kind == "tex"));
        assert!(run.artifacts.iter().any(|a| a.kind == "pdf"));
        assert_eq!(dash.logs.len(), 1);
        assert_eq!(dash.logs[0].skill, "knowledge_base_monitor");
    }

    #[test]
    fn build_run_launch_composes_prompt_with_input() {
        let tmp = TempDir::new().unwrap();
        let agents = tmp.path().join("agents_root");
        let skills = tmp.path().join("skills_root");
        write_f(
            &agents.join("workflows").join("pipelines.json"),
            r#"{"pipelines":{"new_paper_research":{"name":"新论文研究流水线","description":"检索到idea","steps":[{"step":1,"agent":"literature_search"}]}}}"#,
        );
        let launch =
            build_run_launch(&agents, &skills, "new_paper_research", Some("CKKS bootstrapping"))
                .unwrap();
        assert!(launch.prompt.contains("新论文研究流水线"));
        assert!(launch.prompt.contains("literature_search"));
        assert!(launch.prompt.contains("CKKS bootstrapping"));
        assert_eq!(launch.label, "新论文研究流水线");
        assert!(launch.cwd.contains("agents_root"));

        assert!(build_run_launch(&agents, &skills, "nope", None).is_err());
    }
}
