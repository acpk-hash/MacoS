//! F5 沉淀库 (sediment): read-only aggregation over data other features already
//! collected. This module NEVER writes to the collection tables and NEVER adds
//! schema — it merges `tasks`(codex 看板) and `workbench_sessions`(pi 工作台)
//! into a unified run history, scans local skill directories, and extracts the
//! parameters needed to re-open a run in the workbench.
//!
//! The only mutation exposed here is an explicit, user-initiated delete of a
//! recorded run (`delete_run`), which removes already-persisted rows; it does
//! not change how data is captured.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, Result as SqlResult, params};
use serde::Serialize;
use serde_json::Value;

use crate::db::{CanvasEventRow, CanvasSessionRow, Db, WorkbenchEntryRow};

// ── Public row types ──────────────────────────────────────────────────────────

/// One unified run in the sediment history. `kind` is `"board"` (codex task) or
/// `"workbench"` (pi workbench session).
#[derive(Debug, Clone, Serialize)]
pub struct RunSummary {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub cwd: String,
    /// Model used, when known (workbench records it; board tasks do not).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Total token usage, when known (workbench_stats; board = None).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<i64>,
    /// Distinct files changed during the run.
    pub files_changed: i64,
    /// Wall-clock duration in ms, when both endpoints are known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    pub status: String,
    pub created_at: i64,
}

/// One locally available skill discovered on disk.
#[derive(Debug, Clone, Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// `"pi"` or `"codex"`.
    pub source: String,
    /// Absolute path to the skill's directory.
    pub path: String,
}

/// Parameters needed to re-open a run in the workbench.
#[derive(Debug, Clone, Serialize)]
pub struct ReuseInfo {
    pub cwd: String,
    pub model: String,
    pub first_prompt: String,
}

/// Per-session raw event bundle for a board run detail.
#[derive(Debug, Clone, Serialize)]
pub struct SessionEvents {
    pub session_id: String,
    pub events: Vec<CanvasEventRow>,
}

/// Full detail of a single run, tagged by kind. Workbench runs return their
/// persisted entry stream (for read-only replay); board runs return their
/// sessions + raw events (rendered with the existing execution-flow builder).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunDetail {
    Workbench { entries: Vec<WorkbenchEntryRow> },
    Board {
        sessions: Vec<CanvasSessionRow>,
        events: Vec<SessionEvents>,
    },
}

// ── Runs aggregation ──────────────────────────────────────────────────────────

/// Merge board tasks + workbench sessions into a unified run list, newest first.
/// `kind` filters to `"board"` / `"workbench"` (any other value = no filter).
/// `query` is a case-insensitive substring match over title / cwd / model.
pub fn collect_runs(
    db: &Db,
    kind: Option<&str>,
    query: Option<&str>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<RunSummary>, String> {
    let conn = db.conn.lock().unwrap();

    let want_board = !matches!(kind, Some("workbench"));
    let want_workbench = !matches!(kind, Some("board"));

    let mut runs: Vec<RunSummary> = Vec::new();
    if want_board {
        runs.extend(board_runs(&conn).map_err(|e| e.to_string())?);
    }
    if want_workbench {
        runs.extend(workbench_runs(&conn).map_err(|e| e.to_string())?);
    }

    // Newest first.
    runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    // Optional keyword filter (title / cwd / model).
    if let Some(q) = query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty()) {
        runs.retain(|r| {
            r.title.to_lowercase().contains(&q)
                || r.cwd.to_lowercase().contains(&q)
                || r
                    .model
                    .as_deref()
                    .map(|m| m.to_lowercase().contains(&q))
                    .unwrap_or(false)
        });
    }

    // Pagination (applied after merge/sort/filter).
    let offset = offset.unwrap_or(0).max(0) as usize;
    let limit = limit.unwrap_or(200).max(0) as usize;
    let out: Vec<RunSummary> = runs.into_iter().skip(offset).take(limit).collect();
    Ok(out)
}

/// Board runs from `tasks` (+ derived file count / duration from `sessions`).
fn board_runs(conn: &Connection) -> SqlResult<Vec<RunSummary>> {
    let mut stmt = conn.prepare(
        "SELECT \
           t.id, t.title, t.status, t.workdir, t.created_at, \
           COALESCE(( \
               SELECT COUNT(DISTINCT fc.path) \
               FROM   file_changes fc \
               JOIN   sessions s ON fc.session_id = s.id \
               WHERE  s.task_id = t.id \
           ), 0) AS files_changed, \
           (SELECT MIN(started_at) FROM sessions s WHERE s.task_id = t.id) AS first_start, \
           (SELECT MAX(ended_at)   FROM sessions s WHERE s.task_id = t.id) AS last_end \
         FROM tasks t \
         ORDER BY t.created_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let created_at: i64 = row.get(4)?;
        let first_start: Option<i64> = row.get(6)?;
        let last_end: Option<i64> = row.get(7)?;
        let duration_ms = match (first_start, last_end) {
            (Some(s), Some(e)) if e >= s => Some(e - s),
            _ => None,
        };
        Ok(RunSummary {
            id: row.get(0)?,
            kind: "board".to_string(),
            title: row.get(1)?,
            status: row.get(2)?,
            cwd: row.get(3)?,
            created_at,
            files_changed: row.get(5)?,
            model: None,
            total_tokens: None,
            duration_ms,
        })
    })?;
    rows.collect()
}

/// Workbench runs from `workbench_sessions` (+ stats + entry-derived fields).
fn workbench_runs(conn: &Connection) -> SqlResult<Vec<RunSummary>> {
    // Base rows first, then per-session derived data (bounded desktop scale).
    let mut stmt = conn.prepare(
        "SELECT ws.id, ws.cwd, ws.model, ws.created_at, ws.ended_at, st.total \
         FROM workbench_sessions ws \
         LEFT JOIN workbench_stats st ON st.session_id = ws.id \
         ORDER BY ws.created_at DESC",
    )?;
    struct Base {
        id: String,
        cwd: String,
        model: String,
        created_at: i64,
        ended_at: Option<i64>,
        total: Option<i64>,
    }
    let bases: Vec<Base> = stmt
        .query_map([], |row| {
            Ok(Base {
                id: row.get(0)?,
                cwd: row.get(1)?,
                model: row.get(2)?,
                created_at: row.get(3)?,
                ended_at: row.get(4)?,
                total: row.get(5)?,
            })
        })?
        .collect::<SqlResult<Vec<_>>>()?;

    let mut out = Vec::with_capacity(bases.len());
    for b in bases {
        let files_changed = workbench_files_changed(conn, &b.id)?;
        let title = workbench_first_prompt(conn, &b.id)?
            .map(|p| truncate(&p, 120))
            .unwrap_or_else(|| "工作台会话".to_string());
        let duration_ms = match b.ended_at {
            Some(e) if e >= b.created_at => Some(e - b.created_at),
            _ => None,
        };
        let status = if b.ended_at.is_some() { "ended" } else { "active" };
        out.push(RunSummary {
            id: b.id,
            kind: "workbench".to_string(),
            title,
            cwd: b.cwd,
            model: Some(b.model).filter(|m| !m.is_empty()),
            total_tokens: b.total,
            files_changed,
            duration_ms,
            status: status.to_string(),
            created_at: b.created_at,
        });
    }
    Ok(out)
}

/// Distinct file paths touched by tool_edit / tool_write entries in a session.
fn workbench_files_changed(conn: &Connection, session_id: &str) -> SqlResult<i64> {
    let mut stmt = conn.prepare(
        "SELECT payload_json FROM workbench_entries \
         WHERE session_id = ?1 AND kind IN ('tool_edit', 'tool_write')",
    )?;
    let paths = stmt.query_map(params![session_id], |row| row.get::<_, String>(0))?;
    let mut set = std::collections::HashSet::new();
    for p in paths {
        if let Ok(json) = serde_json::from_str::<Value>(&p?) {
            if let Some(path) = json.get("path").and_then(|v| v.as_str()) {
                set.insert(path.to_string());
            }
        }
    }
    Ok(set.len() as i64)
}

/// The text of the first user prompt entry in a workbench session.
fn workbench_first_prompt(conn: &Connection, session_id: &str) -> SqlResult<Option<String>> {
    let payload: Option<String> = match conn.query_row(
        "SELECT payload_json FROM workbench_entries \
         WHERE session_id = ?1 AND kind = 'user' ORDER BY ts ASC, id ASC LIMIT 1",
        params![session_id],
        |row| row.get::<_, String>(0),
    ) {
        Ok(v) => Some(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(e),
    };
    Ok(payload.and_then(|p| {
        serde_json::from_str::<Value>(&p)
            .ok()
            .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()))
    }))
}

// ── Run detail ────────────────────────────────────────────────────────────────

/// Fetch the full detail for one run (for read-only replay / display).
pub fn run_detail(db: &Db, kind: &str, id: &str) -> Result<RunDetail, String> {
    match kind {
        "workbench" => {
            let entries = db.workbench_entries(id).map_err(|e| e.to_string())?;
            Ok(RunDetail::Workbench { entries })
        }
        "board" => {
            let sessions = db.get_task_sessions(id).map_err(|e| e.to_string())?;
            let mut events = Vec::with_capacity(sessions.len());
            for s in &sessions {
                let evs = db.get_session_events(&s.id).map_err(|e| e.to_string())?;
                events.push(SessionEvents {
                    session_id: s.id.clone(),
                    events: evs,
                });
            }
            Ok(RunDetail::Board { sessions, events })
        }
        other => Err(format!("未知运行类型: {other}")),
    }
}

// ── Reuse extraction ──────────────────────────────────────────────────────────

/// Extract the parameters needed to re-open a run in the workbench.
pub fn reuse_info(db: &Db, kind: &str, id: &str) -> Result<ReuseInfo, String> {
    match kind {
        "workbench" => {
            let conn = db.conn.lock().unwrap();
            let (cwd, model): (String, String) = conn
                .query_row(
                    "SELECT cwd, model FROM workbench_sessions WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|_| format!("工作台会话不存在: {id}"))?;
            let first_prompt = workbench_first_prompt(&conn, id)
                .map_err(|e| e.to_string())?
                .unwrap_or_default();
            Ok(ReuseInfo {
                cwd,
                model,
                first_prompt,
            })
        }
        "board" => {
            let info = db.get_task_by_id(id).map_err(|e| e.to_string())?;
            let (title, workdir, _status) =
                info.ok_or_else(|| format!("任务不存在: {id}"))?;
            Ok(ReuseInfo {
                cwd: workdir,
                model: String::new(),
                first_prompt: title,
            })
        }
        other => Err(format!("未知运行类型: {other}")),
    }
}

// ── Delete ────────────────────────────────────────────────────────────────────

/// Delete a recorded run (board task cascade, or workbench session cleanup).
pub fn delete_run(db: &Db, kind: &str, id: &str) -> Result<(), String> {
    match kind {
        "board" => db.delete_task(id).map_err(|e| e.to_string()),
        "workbench" => db.delete_workbench_session(id).map_err(|e| e.to_string()),
        other => Err(format!("未知运行类型: {other}")),
    }
}

// ── Skills scanning ───────────────────────────────────────────────────────────

/// Scan pi + codex skill directories. Missing directories are tolerated
/// (returns whatever was found, never errors on absence).
pub fn collect_skills() -> Vec<SkillInfo> {
    let mut out = Vec::new();

    // pi: `$PI_CODING_AGENT_DIR/skills`, then the default agent dir locations.
    let mut pi_roots: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        if !dir.trim().is_empty() {
            pi_roots.push(PathBuf::from(dir).join("skills"));
        }
    }
    if let Some(home) = home_dir() {
        pi_roots.push(home.join(".pi").join("agent").join("skills"));
        pi_roots.push(home.join(".pi").join("skills"));
    }
    for root in dedup_paths(pi_roots) {
        scan_skill_root(&root, "pi", 3, &mut out);
    }

    // codex: `~/.codex/skills` (includes the `.system` subtree).
    if let Some(home) = home_dir() {
        scan_skill_root(&home.join(".codex").join("skills"), "codex", 3, &mut out);
    }

    out
}

/// Recursively find directories containing a `SKILL.md`, up to `depth` levels.
/// A directory with a `SKILL.md` is treated as a skill and not descended into.
fn scan_skill_root(root: &Path, source: &str, depth: usize, out: &mut Vec<SkillInfo>) {
    let Ok(entries) = fs::read_dir(root) else {
        return; // missing / unreadable dir → tolerated
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if skill_md.is_file() {
            let (name, description) = parse_skill_md(&skill_md);
            let fallback = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("skill")
                .to_string();
            out.push(SkillInfo {
                name: name.unwrap_or(fallback),
                description: description.unwrap_or_default(),
                source: source.to_string(),
                path: path.to_string_lossy().to_string(),
            });
        } else if depth > 0 {
            scan_skill_root(&path, source, depth - 1, out);
        }
    }
}

/// Parse `name` / `description` from a SKILL.md YAML frontmatter block.
/// Returns `(None, None)` when there is no frontmatter.
fn parse_skill_md(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(content) = fs::read_to_string(path) else {
        return (None, None);
    };
    let trimmed = content.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---") {
        return (None, None);
    }
    // Take the block between the first and second `---` fences.
    let mut lines = trimmed.lines();
    lines.next(); // opening ---
    let mut name = None;
    let mut description = None;
    for line in lines {
        let l = line.trim_end();
        if l.trim() == "---" {
            break;
        }
        if let Some(rest) = l.strip_prefix("name:") {
            name = Some(unquote(rest.trim()));
        } else if let Some(rest) = l.strip_prefix("description:") {
            description = Some(unquote(rest.trim()));
        }
    }
    (
        name.filter(|s| !s.is_empty()),
        description.filter(|s| !s.is_empty()),
    )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

fn dedup_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect()
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

fn truncate(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() > n {
        let head: String = s.chars().take(n).collect();
        format!("{head}…")
    } else {
        s.to_string()
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn new_db() -> Db {
        Db::open_in_memory().expect("in-memory DB")
    }

    /// Force a specific created_at on a board task (bypasses now_ms()).
    fn set_task_created(db: &Db, id: &str, created: i64) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE tasks SET created_at = ?1 WHERE id = ?2",
                params![created, id],
            )
            .unwrap();
    }

    fn set_wb_created(db: &Db, id: &str, created: i64) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE workbench_sessions SET created_at = ?1 WHERE id = ?2",
                params![created, id],
            )
            .unwrap();
    }

    // ── runs aggregation + sorting ────────────────────────────────────────────

    #[test]
    fn runs_merge_sort_and_derive() {
        let db = new_db();

        // Board task (older) with 2 distinct changed files across a session.
        db.insert_task("bt1", "看板任务 A", "/work/board").unwrap();
        db.insert_session("bs1", "bt1", "codex").unwrap();
        db.upsert_file_change("bs1", "a.rs", "update", 3, 1, None, None)
            .unwrap();
        db.upsert_file_change("bs1", "b.rs", "create", 5, 0, None, None)
            .unwrap();
        set_task_created(&db, "bt1", 1_000);

        // Workbench session (newer) with a first prompt, stats, and one edit.
        db.workbench_session_create("wb1", "/work/wb", "prov", "gpt-5.5")
            .unwrap();
        db.workbench_entry_insert("wb1", "user", r#"{"text":"帮我修 build"}"#)
            .unwrap();
        db.workbench_entry_insert("wb1", "tool_edit", r#"{"path":"src/main.rs","diff":"x"}"#)
            .unwrap();
        db.workbench_entry_insert("wb1", "tool_edit", r#"{"path":"src/main.rs","diff":"y"}"#)
            .unwrap();
        db.workbench_stats_upsert("wb1", 100, 20, 0, 0, 120).unwrap();
        set_wb_created(&db, "wb1", 2_000);

        let runs = collect_runs(&db, None, None, None, None).unwrap();
        assert_eq!(runs.len(), 2);

        // Newest first → workbench then board.
        assert_eq!(runs[0].id, "wb1");
        assert_eq!(runs[0].kind, "workbench");
        assert_eq!(runs[0].title, "帮我修 build");
        assert_eq!(runs[0].model.as_deref(), Some("gpt-5.5"));
        assert_eq!(runs[0].total_tokens, Some(120));
        assert_eq!(runs[0].files_changed, 1, "distinct edited path deduped");

        assert_eq!(runs[1].id, "bt1");
        assert_eq!(runs[1].kind, "board");
        assert_eq!(runs[1].model, None);
        assert_eq!(runs[1].total_tokens, None);
        assert_eq!(runs[1].files_changed, 2);
    }

    #[test]
    fn runs_kind_filter_and_query() {
        let db = new_db();
        db.insert_task("bt1", "看板任务", "/board").unwrap();
        db.workbench_session_create("wb1", "/wb", "p", "m").unwrap();
        db.workbench_entry_insert("wb1", "user", r#"{"text":"翻译文档"}"#)
            .unwrap();

        let board_only = collect_runs(&db, Some("board"), None, None, None).unwrap();
        assert_eq!(board_only.len(), 1);
        assert_eq!(board_only[0].kind, "board");

        let wb_only = collect_runs(&db, Some("workbench"), None, None, None).unwrap();
        assert_eq!(wb_only.len(), 1);
        assert_eq!(wb_only[0].kind, "workbench");

        // Query matches the workbench title only.
        let q = collect_runs(&db, None, Some("翻译"), None, None).unwrap();
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].id, "wb1");

        // Pagination: limit 1 keeps only the newest.
        let paged = collect_runs(&db, None, None, Some(1), Some(0)).unwrap();
        assert_eq!(paged.len(), 1);
    }

    // ── reuse extraction ──────────────────────────────────────────────────────

    #[test]
    fn reuse_extracts_workbench_and_board() {
        let db = new_db();
        db.workbench_session_create("wb1", "/work/wb", "prov", "gpt-5.5")
            .unwrap();
        db.workbench_entry_insert("wb1", "user", r#"{"text":"第一条指令"}"#)
            .unwrap();
        db.workbench_entry_insert("wb1", "assistant_message", r#"{"text":"ok"}"#)
            .unwrap();

        let wb = reuse_info(&db, "workbench", "wb1").unwrap();
        assert_eq!(wb.cwd, "/work/wb");
        assert_eq!(wb.model, "gpt-5.5");
        assert_eq!(wb.first_prompt, "第一条指令");

        db.insert_task("bt1", "看板标题作 prompt", "/board/dir")
            .unwrap();
        let board = reuse_info(&db, "board", "bt1").unwrap();
        assert_eq!(board.cwd, "/board/dir");
        assert_eq!(board.model, "");
        assert_eq!(board.first_prompt, "看板标题作 prompt");

        assert!(reuse_info(&db, "workbench", "missing").is_err());
    }

    // ── skills scanning tolerance ─────────────────────────────────────────────

    #[test]
    fn scan_skill_root_missing_dir_is_empty() {
        let mut out = Vec::new();
        scan_skill_root(Path::new("/no/such/dir/xyz123"), "pi", 3, &mut out);
        assert!(out.is_empty(), "missing dir must not error and yields nothing");
    }

    #[test]
    fn scan_skill_root_finds_frontmatter_skill() {
        let tmp = tempfile::TempDir::new().unwrap();
        // root/foo/SKILL.md  (direct) and root/.system/bar/SKILL.md (nested)
        let foo = tmp.path().join("foo");
        fs::create_dir_all(&foo).unwrap();
        fs::write(
            foo.join("SKILL.md"),
            "---\nname: foo-skill\ndescription: A test skill.\n---\n# body\n",
        )
        .unwrap();

        let bar = tmp.path().join(".system").join("bar");
        fs::create_dir_all(&bar).unwrap();
        fs::write(
            bar.join("SKILL.md"),
            "---\nname: \"bar-skill\"\ndescription: 'Nested one.'\n---\n",
        )
        .unwrap();

        // A directory without SKILL.md should be ignored gracefully.
        fs::create_dir_all(tmp.path().join("empty")).unwrap();

        let mut out = Vec::new();
        scan_skill_root(tmp.path(), "codex", 3, &mut out);

        assert_eq!(out.len(), 2, "should find both direct and nested skills");
        let names: Vec<&str> = out.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"foo-skill"));
        assert!(names.contains(&"bar-skill"));
        let foo_skill = out.iter().find(|s| s.name == "foo-skill").unwrap();
        assert_eq!(foo_skill.description, "A test skill.");
        assert_eq!(foo_skill.source, "codex");
    }

    #[test]
    fn parse_skill_md_without_frontmatter() {
        let tmp = tempfile::TempDir::new().unwrap();
        let p = tmp.path().join("SKILL.md");
        fs::write(&p, "# Just a heading\nno frontmatter here\n").unwrap();
        let (name, desc) = parse_skill_md(&p);
        assert!(name.is_none());
        assert!(desc.is_none());
    }
}
