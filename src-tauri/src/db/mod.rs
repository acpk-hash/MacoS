/// SQLite persistence layer for agentboard.
///
/// Database location: `%APPDATA%/agentboard/data.db` (Windows) or
/// `~/.local/share/agentboard/data.db` (other platforms).
///
/// Schema versioning: `PRAGMA user_version` — current version is 2.
/// Migrations check the version on open and apply DDL incrementally.
///
/// Connection management: single `Mutex<Connection>` — acceptable for
/// single-user desktop use where all operations complete in microseconds.

use rusqlite::{Connection, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

// ── Schema DDL ────────────────────────────────────────────────────────────────

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS tasks (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'running',
    workdir    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    engine     TEXT NOT NULL DEFAULT 'codex',
    thread_id  TEXT,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    ts         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    type         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    ts           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_changes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    path       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    added      INTEGER NOT NULL DEFAULT 0,
    removed    INTEGER NOT NULL DEFAULT 0,
    diff       TEXT,
    state      TEXT NOT NULL DEFAULT 'pending',
    ts         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_task_id    ON sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_messages_session    ON messages(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_file_changes_session ON file_changes(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_tasks_updated       ON tasks(updated_at DESC);
"#;

/// V2: adds `snapshot_path` column to `file_changes` for cold-revert support.
const SCHEMA_V2: &str = r#"
ALTER TABLE file_changes ADD COLUMN snapshot_path TEXT;
"#;

/// V3: adds `settings` key-value table for persistent app configuration.
const SCHEMA_V3: &str = r#"
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

/// V5: adds `providers` table for user-configured OpenAI-compatible services.
///
/// Security: this table holds ONLY metadata. API keys are stored in the OS
/// credential store (keyring, service `agentboard`, account = provider id) and
/// never touch SQLite. `has_key` is a convenience boolean mirroring whether a
/// key exists in the credential store; it is not the key itself.
const SCHEMA_V5: &str = r#"
CREATE TABLE IF NOT EXISTS providers (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    base_url   TEXT NOT NULL,
    wire_api   TEXT NOT NULL DEFAULT 'chat',
    enabled    INTEGER NOT NULL DEFAULT 1,
    has_key    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
"#;

/// V6: local workbench (pi engine) persistence — F4a.
///
/// `workbench_sessions` records one pi RPC session (cwd + provider/model + the
/// exported HTML path once produced). `workbench_entries` stores the ordered
/// turn stream (user prompts, assistant messages, tool calls) for later replay
/// / F5 沉淀. `workbench_stats` holds the latest token usage snapshot per
/// session (upserted after every turn). No credentials are ever stored here.
const SCHEMA_V6: &str = r#"
CREATE TABLE IF NOT EXISTS workbench_sessions (
    id          TEXT PRIMARY KEY,
    cwd         TEXT NOT NULL,
    provider_id TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    pi_session  TEXT,
    export_path TEXT,
    created_at  INTEGER NOT NULL,
    ended_at    INTEGER
);

CREATE TABLE IF NOT EXISTS workbench_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    ts         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workbench_stats (
    session_id  TEXT PRIMARY KEY,
    input       INTEGER NOT NULL DEFAULT 0,
    output      INTEGER NOT NULL DEFAULT 0,
    cache_read  INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workbench_entries_session ON workbench_entries(session_id, ts);
"#;

// ── Public row types ──────────────────────────────────────────────────────────

/// Returned by `list_tasks` — one row per task, ordered by updated_at DESC.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRow {
    pub id: String,
    pub title: String,
    pub status: String,
    pub workdir: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub session_count: i64,
    /// Distinct file paths changed across all sessions for this task.
    pub file_count: i64,
    /// Most recently started session for this task (None for pure todo tasks).
    pub last_session_id: Option<String>,
}

/// A single merged timeline item returned by `get_session_timeline`.
/// `kind` is either `"message"` or `"file_change"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineItem {
    pub kind: String,
    pub ts: i64,
    // --- message fields ---
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    // --- file_change fields ---
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

/// One session row for the workflow canvas, returned by `get_task_sessions`
/// ordered by `started_at ASC`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasSessionRow {
    pub id: String,
    pub engine: String,
    pub thread_id: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

/// A flat session row for the sync snapshot (`sessions` kind). Includes
/// `task_id` (unlike `CanvasSessionRow`) so the mobile client can associate a
/// session with its task. Never carries chat text or secrets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSessionRow {
    pub id: String,
    pub task_id: String,
    pub engine: String,
    pub thread_id: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

/// One raw persisted event row for the workflow canvas, returned by
/// `get_session_events` ordered by `ts ASC`. `payload_json` is the serialized
/// `AgentEvent` (parsed on the frontend for step reconstruction).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasEventRow {
    #[serde(rename = "type")]
    pub event_type: String,
    pub ts: i64,
    pub payload_json: String,
}

/// One persisted workbench entry (F4a) returned by `workbench_entries`,
/// ordered by `ts ASC`. `payload_json` is the serialized `WorkbenchEvent`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkbenchEntryRow {
    pub kind: String,
    pub payload_json: String,
    pub ts: i64,
}

/// One configured OpenAI-compatible provider (metadata only — no API key).
/// The key lives in the OS credential store; `has_key` mirrors its presence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderRow {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub wire_api: String,
    pub enabled: bool,
    pub has_key: bool,
    pub created_at: i64,
}

// ── Db ────────────────────────────────────────────────────────────────────────

pub struct Db {
    pub(crate) conn: Mutex<Connection>,
}

impl Db {
    /// Open (or create) the on-disk database at the platform data dir.
    pub fn open() -> SqlResult<Self> {
        let path = db_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(&path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    /// In-memory database used by unit tests.
    #[cfg(test)]
    pub fn open_in_memory() -> SqlResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            conn.execute_batch(SCHEMA_V1)?;
            conn.execute_batch("PRAGMA user_version = 1")?;
        }
        if version < 2 {
            conn.execute_batch(SCHEMA_V2)?;
            conn.execute_batch("PRAGMA user_version = 2")?;
        }
        if version < 3 {
            conn.execute_batch(SCHEMA_V3)?;
            conn.execute_batch("PRAGMA user_version = 3")?;
        }
        if version < 4 {
            conn.execute_batch(studio::SCHEMA_V4)?;
            conn.execute_batch("PRAGMA user_version = 4")?;
        }
        if version < 5 {
            conn.execute_batch(SCHEMA_V5)?;
            conn.execute_batch("PRAGMA user_version = 5")?;
        }
        if version < 6 {
            conn.execute_batch(SCHEMA_V6)?;
            conn.execute_batch("PRAGMA user_version = 6")?;
        }
        Ok(())
    }

    // ── Task ──────────────────────────────────────────────────────────────────

    /// Insert a new task record with status `"running"` (used when agent_start
    /// creates both task and session atomically).
    pub fn insert_task(&self, id: &str, title: &str, workdir: &str) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO tasks (id, title, status, workdir, created_at, updated_at) \
             VALUES (?1, ?2, 'running', ?3, ?4, ?4)",
            params![id, title, workdir, now],
        )?;
        Ok(())
    }

    /// Insert a new task with status `"todo"` (created from the Board view before
    /// being dispatched to an agent).
    pub fn insert_task_todo(&self, id: &str, title: &str, workdir: &str) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO tasks (id, title, status, workdir, created_at, updated_at) \
             VALUES (?1, ?2, 'todo', ?3, ?4, ?4)",
            params![id, title, workdir, now],
        )?;
        Ok(())
    }

    /// Update task status and bump `updated_at`.
    pub fn update_task_status(&self, task_id: &str, status: &str) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "UPDATE tasks SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now, task_id],
        )?;
        Ok(())
    }

    /// Update task title and bump `updated_at`.
    pub fn update_task_title(&self, task_id: &str, title: &str) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "UPDATE tasks SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now, task_id],
        )?;
        Ok(())
    }

    /// Retrieve the current status string for a task, or None if not found.
    pub fn get_task_status(&self, task_id: &str) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT status FROM tasks WHERE id = ?1",
            params![task_id],
            |row| row.get(0),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Return the task_id for a session row.
    pub fn get_task_id_for_session(&self, session_id: &str) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT task_id FROM sessions WHERE id = ?1",
            params![session_id],
            |row| row.get::<_, String>(0),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Return `(title, workdir, status)` for a task by its id.
    pub fn get_task_by_id(&self, task_id: &str) -> SqlResult<Option<(String, String, String)>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT title, workdir, status FROM tasks WHERE id = ?1",
            params![task_id],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            )),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Validate a manual status transition and apply it.
    ///
    /// Allowed manual transitions (via the Board drag-and-drop or API):
    /// - `awaiting_review` → `done`  (human confirms the work)
    ///
    /// All other transitions are rejected with an error message.
    pub fn set_task_status_validated(
        &self,
        task_id: &str,
        new_status: &str,
    ) -> Result<(), String> {
        let current = self
            .get_task_status(task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("任务 {} 不存在", task_id))?;

        let allowed = matches!(
            (current.as_str(), new_status),
            ("awaiting_review", "done")
        );

        if !allowed {
            return Err(format!(
                "不允许的状态转换：{} → {}（仅支持 awaiting_review → done）",
                current, new_status
            ));
        }

        self.update_task_status(task_id, new_status)
            .map_err(|e| e.to_string())
    }

    /// Delete a task and cascade-delete all dependent records:
    /// sessions → messages, events, file_changes.
    pub fn delete_task(&self, task_id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        // Collect session ids for this task.
        let session_ids: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM sessions WHERE task_id = ?1")?;
            let ids = stmt.query_map(params![task_id], |row| row.get(0))?
                .collect::<SqlResult<Vec<_>>>()?;
            ids
        };

        // Cascade-delete child records for each session.
        for sid in &session_ids {
            conn.execute("DELETE FROM file_changes WHERE session_id = ?1", params![sid])?;
            conn.execute("DELETE FROM messages    WHERE session_id = ?1", params![sid])?;
            conn.execute("DELETE FROM events      WHERE session_id = ?1", params![sid])?;
        }

        conn.execute("DELETE FROM sessions WHERE task_id = ?1", params![task_id])?;
        conn.execute("DELETE FROM tasks    WHERE id = ?1",      params![task_id])?;
        Ok(())
    }

    /// Return tasks ordered by `updated_at DESC`, at most 100 rows.
    pub fn list_tasks(&self) -> SqlResult<Vec<TaskRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT \
               t.id, t.title, t.status, t.workdir, t.created_at, t.updated_at, \
               COUNT(DISTINCT s.id) AS session_count, \
               COALESCE(( \
                   SELECT COUNT(DISTINCT fc.path) \
                   FROM   file_changes fc \
                   JOIN   sessions     s2 ON fc.session_id = s2.id \
                   WHERE  s2.task_id = t.id \
               ), 0) AS file_count, \
               ( \
                   SELECT s3.id \
                   FROM   sessions s3 \
                   WHERE  s3.task_id = t.id \
                   ORDER BY s3.started_at DESC \
                   LIMIT 1 \
               ) AS last_session_id \
             FROM   tasks t \
             LEFT JOIN sessions s ON s.task_id = t.id \
             GROUP  BY t.id \
             ORDER  BY t.updated_at DESC \
             LIMIT  100",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(TaskRow {
                id: row.get(0)?,
                title: row.get(1)?,
                status: row.get(2)?,
                workdir: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                session_count: row.get(6)?,
                file_count: row.get(7)?,
                last_session_id: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    // ── Session ───────────────────────────────────────────────────────────────

    pub fn insert_session(&self, id: &str, task_id: &str, engine: &str) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO sessions (id, task_id, engine, started_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, task_id, engine, now],
        )?;
        Ok(())
    }

    pub fn update_session_thread_id(&self, session_id: &str, thread_id: &str) -> SqlResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE sessions SET thread_id = ?1 WHERE id = ?2",
            params![thread_id, session_id],
        )?;
        Ok(())
    }

    pub fn end_session(&self, session_id: &str) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "UPDATE sessions SET ended_at = ?1 WHERE id = ?2",
            params![now, session_id],
        )?;
        Ok(())
    }

    /// Return the `thread_id` stored for a session (used for cold-resume).
    pub fn get_thread_id(&self, session_id: &str) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT thread_id FROM sessions WHERE id = ?1",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        ) {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Return the workdir for a session (via task join), used on cold-resume.
    pub fn get_session_workdir(&self, session_id: &str) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT t.workdir FROM tasks t \
             JOIN sessions s ON s.task_id = t.id \
             WHERE s.id = ?1",
            params![session_id],
            |row| row.get::<_, String>(0),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Return all sessions (flat, newest-started first, max 500) for the sync
    /// `sessions` snapshot. No message/event bodies are included.
    pub fn list_sessions(&self) -> SqlResult<Vec<SyncSessionRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, task_id, engine, thread_id, started_at, ended_at \
             FROM sessions ORDER BY started_at DESC LIMIT 500",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SyncSessionRow {
                id: row.get(0)?,
                task_id: row.get(1)?,
                engine: row.get(2)?,
                thread_id: row.get(3)?,
                started_at: row.get(4)?,
                ended_at: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    // ── Messages ──────────────────────────────────────────────────────────────

    pub fn insert_message(&self, session_id: &str, role: &str, content: &str) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO messages (session_id, role, content, ts) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, role, content, now],
        )?;
        Ok(())
    }

    // ── Events ────────────────────────────────────────────────────────────────

    pub fn insert_event(
        &self,
        session_id: &str,
        event_type: &str,
        payload_json: &str,
    ) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO events (session_id, type, payload_json, ts) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, event_type, payload_json, now],
        )?;
        Ok(())
    }

    // ── File changes ──────────────────────────────────────────────────────────

    /// Insert or update a file-change record for `(session_id, path)`.
    ///
    /// On INSERT: writes all fields including `snapshot_path`.
    /// On UPDATE: overwrites kind/added/removed/diff/ts but preserves `snapshot_path`
    ///            (the snapshot is taken once on first touch and must not be overwritten).
    pub fn upsert_file_change(
        &self,
        session_id: &str,
        path: &str,
        kind: &str,
        added: i64,
        removed: i64,
        diff: Option<&str>,
        snapshot_path: Option<&str>,
    ) -> SqlResult<()> {
        let now = now_ms();
        let conn = self.conn.lock().unwrap();
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM file_changes WHERE session_id = ?1 AND path = ?2",
                params![session_id, path],
                |row| row.get(0),
            )
            .ok();

        if let Some(id) = existing {
            conn.execute(
                "UPDATE file_changes \
                 SET kind = ?1, added = ?2, removed = ?3, diff = ?4, ts = ?5 \
                 WHERE id = ?6",
                params![kind, added, removed, diff, now, id],
            )?;
        } else {
            conn.execute(
                "INSERT INTO file_changes \
                 (session_id, path, kind, added, removed, diff, state, snapshot_path, ts) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)",
                params![session_id, path, kind, added, removed, diff, snapshot_path, now],
            )?;
        }
        Ok(())
    }

    /// Return the snapshot_path stored for `(session_id, path)`, or None.
    /// Used by the cold-revert path after an app restart.
    pub fn get_snapshot_path(
        &self,
        session_id: &str,
        path: &str,
    ) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT snapshot_path FROM file_changes WHERE session_id = ?1 AND path = ?2",
            params![session_id, path],
            |row| row.get::<_, Option<String>>(0),
        ) {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Update the review state of a file change (`pending` → `approved` | `reverted`).
    pub fn update_file_change_state(
        &self,
        session_id: &str,
        path: &str,
        state: &str,
    ) -> SqlResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE file_changes SET state = ?1 \
             WHERE session_id = ?2 AND path = ?3",
            params![state, session_id, path],
        )?;
        Ok(())
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    /// Upsert a settings key-value pair.
    pub fn settings_set(&self, key: &str, value: &str) -> SqlResult<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Get a single setting value by key.
    pub fn settings_get(&self, key: &str) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Return all settings as a HashMap.
    pub fn settings_get_all(&self) -> SqlResult<HashMap<String, String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (k, v) = row?;
            map.insert(k, v);
        }
        Ok(map)
    }

    // ── Providers (multi-service model config) ─────────────────────────────────

    /// Insert or update a provider's metadata. On update, `created_at` and
    /// `has_key` are preserved (key presence is managed separately).
    pub fn provider_upsert(
        &self,
        id: &str,
        label: &str,
        base_url: &str,
        wire_api: &str,
        enabled: bool,
    ) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO providers (id, label, base_url, wire_api, enabled, has_key, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6) \
             ON CONFLICT(id) DO UPDATE SET \
               label = excluded.label, base_url = excluded.base_url, \
               wire_api = excluded.wire_api, enabled = excluded.enabled",
            params![id, label, base_url, wire_api, enabled, now],
        )?;
        Ok(())
    }

    /// List all providers ordered by `created_at ASC`.
    pub fn providers_list(&self) -> SqlResult<Vec<ProviderRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, label, base_url, wire_api, enabled, has_key, created_at \
             FROM providers ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], map_provider)?;
        rows.collect()
    }

    /// Fetch a single provider by id.
    pub fn provider_get(&self, id: &str) -> SqlResult<Option<ProviderRow>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT id, label, base_url, wire_api, enabled, has_key, created_at \
             FROM providers WHERE id = ?1",
            params![id],
            map_provider,
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Delete a provider row (the caller removes its credential-store entry).
    pub fn provider_delete(&self, id: &str) -> SqlResult<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM providers WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Mark whether a provider currently has a key in the credential store.
    pub fn provider_set_has_key(&self, id: &str, has_key: bool) -> SqlResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE providers SET has_key = ?1 WHERE id = ?2",
            params![has_key, id],
        )?;
        Ok(())
    }

    // ── Feishu stats helpers ──────────────────────────────────────────────────

    /// Return (title, workdir) for the task associated with `session_id`.
    pub fn get_task_info_for_session(
        &self,
        session_id: &str,
    ) -> SqlResult<Option<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT t.title, t.workdir \
             FROM tasks t JOIN sessions s ON s.task_id = t.id \
             WHERE s.id = ?1",
            params![session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Return the `started_at` timestamp (ms since epoch) for a session.
    pub fn get_session_started_at(&self, session_id: &str) -> SqlResult<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT started_at FROM sessions WHERE id = ?1",
            params![session_id],
            |row| row.get::<_, i64>(0),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Return the count of distinct file paths changed during a session.
    pub fn get_session_file_count(&self, session_id: &str) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(DISTINCT path) FROM file_changes WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, i64>(0),
        )
    }

    /// Return the most recent usage token counts for a session, or `None` if
    /// no usage event has been recorded yet.
    /// Returns `(input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens)`.
    pub fn get_last_usage_tokens(
        &self,
        session_id: &str,
    ) -> SqlResult<Option<(u64, u64, u64, u64)>> {
        // Fetch the JSON payload while holding the lock, then release before parsing.
        let json_str: Option<String> = {
            let conn = self.conn.lock().unwrap();
            match conn.query_row(
                "SELECT payload_json FROM events \
                 WHERE session_id = ?1 AND type = 'usage' \
                 ORDER BY ts DESC LIMIT 1",
                params![session_id],
                |row| row.get::<_, String>(0),
            ) {
                Ok(s) => Some(s),
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(e) => return Err(e),
            }
        };

        Ok(json_str.map(|s| {
            let v: serde_json::Value =
                serde_json::from_str(&s).unwrap_or(serde_json::Value::Null);
            (
                v["input_tokens"].as_u64().unwrap_or(0),
                v["cached_input_tokens"].as_u64().unwrap_or(0),
                v["output_tokens"].as_u64().unwrap_or(0),
                v["reasoning_output_tokens"].as_u64().unwrap_or(0),
            )
        }))
    }

    // ── File change kind lookup ────────────────────────────────────────────────

    /// Return the `kind` field for `(session_id, path)`, used by cold-revert
    /// to distinguish newly created files (kind = "create") from updates.
    pub fn get_file_change_kind(
        &self,
        session_id: &str,
        path: &str,
    ) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT kind FROM file_changes WHERE session_id = ?1 AND path = ?2",
            params![session_id, path],
            |row| row.get::<_, String>(0),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    // ── Timeline query ────────────────────────────────────────────────────────

    /// Merge messages + file_changes for a session into a single timeline
    /// sorted by `ts ASC`.
    pub fn get_session_timeline(&self, session_id: &str) -> SqlResult<Vec<TimelineItem>> {
        let conn = self.conn.lock().unwrap();
        let mut items: Vec<TimelineItem> = Vec::new();

        // Messages
        {
            let mut stmt = conn.prepare(
                "SELECT role, content, ts FROM messages \
                 WHERE session_id = ?1 ORDER BY ts ASC",
            )?;
            let rows = stmt.query_map(params![session_id], |row| {
                Ok(TimelineItem {
                    kind: "message".to_string(),
                    ts: row.get(2)?,
                    role: Some(row.get(0)?),
                    content: Some(row.get(1)?),
                    path: None,
                    change_kind: None,
                    added: None,
                    removed: None,
                    diff: None,
                    state: None,
                })
            })?;
            for row in rows {
                items.push(row?);
            }
        }

        // File changes
        {
            let mut stmt = conn.prepare(
                "SELECT path, kind, added, removed, diff, state, ts \
                 FROM file_changes WHERE session_id = ?1 ORDER BY ts ASC",
            )?;
            let rows = stmt.query_map(params![session_id], |row| {
                Ok(TimelineItem {
                    kind: "file_change".to_string(),
                    ts: row.get(6)?,
                    role: None,
                    content: None,
                    path: Some(row.get(0)?),
                    change_kind: Some(row.get(1)?),
                    added: Some(row.get(2)?),
                    removed: Some(row.get(3)?),
                    diff: row.get(4)?,
                    state: Some(row.get(5)?),
                })
            })?;
            for row in rows {
                items.push(row?);
            }
        }

        items.sort_by_key(|i| i.ts);
        Ok(items)
    }

    // ── Canvas queries ──────────────────────────────────────────────────────────

    /// Return all sessions for a task, ordered by `started_at ASC`.
    /// Used by the workflow canvas to render one session row per session.
    pub fn get_task_sessions(&self, task_id: &str) -> SqlResult<Vec<CanvasSessionRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, engine, thread_id, started_at, ended_at \
             FROM sessions WHERE task_id = ?1 ORDER BY started_at ASC",
        )?;
        let rows = stmt.query_map(params![task_id], |row| {
            Ok(CanvasSessionRow {
                id: row.get(0)?,
                engine: row.get(1)?,
                thread_id: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// Return all raw persisted events for a session, ordered by `ts ASC`.
    /// The canvas parses each `payload_json` to reconstruct command/reply/file
    /// steps (commands live only in the events table, not in the timeline).
    pub fn get_session_events(&self, session_id: &str) -> SqlResult<Vec<CanvasEventRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT type, ts, payload_json \
             FROM events WHERE session_id = ?1 ORDER BY ts ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(CanvasEventRow {
                event_type: row.get(0)?,
                ts: row.get(1)?,
                payload_json: row.get(2)?,
            })
        })?;
        rows.collect()
    }

    // ── Workbench (pi engine, F4a) ──────────────────────────────────────────────

    /// Create a workbench session row. Credentials are never stored.
    pub fn workbench_session_create(
        &self,
        id: &str,
        cwd: &str,
        provider_id: &str,
        model: &str,
    ) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO workbench_sessions (id, cwd, provider_id, model, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, cwd, provider_id, model, now],
        )?;
        Ok(())
    }

    /// Record the pi-side session id (from get_session_stats) for a workbench session.
    pub fn workbench_session_set_pi_session(&self, id: &str, pi_session: &str) -> SqlResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE workbench_sessions SET pi_session = ?1 WHERE id = ?2",
            params![pi_session, id],
        )?;
        Ok(())
    }

    /// Record the export_html output path for a workbench session.
    pub fn workbench_session_set_export(&self, id: &str, export_path: &str) -> SqlResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE workbench_sessions SET export_path = ?1 WHERE id = ?2",
            params![export_path, id],
        )?;
        Ok(())
    }

    /// Mark a workbench session ended.
    pub fn workbench_session_end(&self, id: &str) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "UPDATE workbench_sessions SET ended_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(())
    }

    /// Append one workbench entry (user prompt / assistant message / tool call).
    pub fn workbench_entry_insert(
        &self,
        session_id: &str,
        kind: &str,
        payload_json: &str,
    ) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO workbench_entries (session_id, kind, payload_json, ts) \
             VALUES (?1, ?2, ?3, ?4)",
            params![session_id, kind, payload_json, now],
        )?;
        Ok(())
    }

    /// Upsert the latest token usage snapshot for a workbench session.
    pub fn workbench_stats_upsert(
        &self,
        session_id: &str,
        input: i64,
        output: i64,
        cache_read: i64,
        cache_write: i64,
        total: i64,
    ) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO workbench_stats \
             (session_id, input, output, cache_read, cache_write, total, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(session_id) DO UPDATE SET \
               input = excluded.input, output = excluded.output, \
               cache_read = excluded.cache_read, cache_write = excluded.cache_write, \
               total = excluded.total, updated_at = excluded.updated_at",
            params![session_id, input, output, cache_read, cache_write, total, now],
        )?;
        Ok(())
    }

    /// Return the ordered entry stream for a workbench session.
    pub fn workbench_entries(&self, session_id: &str) -> SqlResult<Vec<WorkbenchEntryRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT kind, payload_json, ts FROM workbench_entries \
             WHERE session_id = ?1 ORDER BY ts ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(WorkbenchEntryRow {
                kind: row.get(0)?,
                payload_json: row.get(1)?,
                ts: row.get(2)?,
            })
        })?;
        rows.collect()
    }

    /// Delete a workbench session and all its entries + stats (F5 沉淀 cleanup).
    /// Read-only sediment aggregation never creates these rows; this only
    /// removes an already-recorded session on explicit user request.
    pub fn delete_workbench_session(&self, id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM workbench_entries WHERE session_id = ?1", params![id])?;
        conn.execute("DELETE FROM workbench_stats   WHERE session_id = ?1", params![id])?;
        conn.execute("DELETE FROM workbench_sessions WHERE id = ?1",         params![id])?;
        Ok(())
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn db_path() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:/Users/Default/AppData/Roaming"));

    #[cfg(not(windows))]
    let base = std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".local/share"))
        .unwrap_or_else(|_| PathBuf::from("/tmp"));

    base.join("agentboard").join("data.db")
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn map_provider(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderRow> {
    Ok(ProviderRow {
        id: r.get(0)?,
        label: r.get(1)?,
        base_url: r.get(2)?,
        wire_api: r.get(3)?,
        enabled: r.get(4)?,
        has_key: r.get(5)?,
        created_at: r.get(6)?,
    })
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn new_db() -> Db {
        Db::open_in_memory().expect("in-memory DB")
    }

    // Seed helpers
    fn seed_task(db: &Db, id: &str) {
        db.insert_task(id, &format!("Task {id}"), "/tmp").unwrap();
    }
    fn seed_session(db: &Db, sid: &str, tid: &str) {
        db.insert_session(sid, tid, "codex").unwrap();
    }

    // ── schema & basic CRUD ───────────────────────────────────────────────────

    #[test]
    fn schema_created_on_open() {
        let db = new_db();
        assert!(db.list_tasks().unwrap().is_empty());
    }

    #[test]
    fn insert_and_list_task() {
        let db = new_db();
        seed_task(&db, "t1");
        let tasks = db.list_tasks().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "t1");
        assert_eq!(tasks[0].status, "running");
    }

    #[test]
    fn update_task_status() {
        let db = new_db();
        seed_task(&db, "t2");
        seed_session(&db, "s2", "t2");
        db.update_task_status("t2", "awaiting_review").unwrap();
        let tasks = db.list_tasks().unwrap();
        assert_eq!(tasks[0].status, "awaiting_review");
    }

    // ── messages write-read ───────────────────────────────────────────────────

    #[test]
    fn insert_and_retrieve_messages() {
        let db = new_db();
        seed_task(&db, "t3");
        seed_session(&db, "s3", "t3");
        db.insert_message("s3", "user", "hello").unwrap();
        db.insert_message("s3", "assistant", "world").unwrap();

        let tl = db.get_session_timeline("s3").unwrap();
        assert_eq!(tl.len(), 2);
        assert_eq!(tl[0].role.as_deref(), Some("user"));
        assert_eq!(tl[0].content.as_deref(), Some("hello"));
        assert_eq!(tl[1].role.as_deref(), Some("assistant"));
    }

    // ── timeline merge + sort ─────────────────────────────────────────────────

    #[test]
    fn timeline_merge_sort_order() {
        let db = new_db();
        seed_task(&db, "t4");
        seed_session(&db, "s4", "t4");

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO messages (session_id, role, content, ts) \
                 VALUES ('s4', 'user', 'msg at 100', 100)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO file_changes \
                 (session_id, path, kind, added, removed, state, ts) \
                 VALUES ('s4', 'foo.rs', 'create', 5, 0, 'pending', 200)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (session_id, role, content, ts) \
                 VALUES ('s4', 'assistant', 'msg at 150', 150)",
                [],
            )
            .unwrap();
        }

        let tl = db.get_session_timeline("s4").unwrap();
        assert_eq!(tl.len(), 3);
        assert_eq!(tl[0].ts, 100, "first should be user msg");
        assert_eq!(tl[1].ts, 150, "second should be assistant msg");
        assert_eq!(tl[2].ts, 200, "third should be file_change");
        assert_eq!(tl[2].kind, "file_change");
    }

    // ── file_changes state flow ───────────────────────────────────────────────

    #[test]
    fn file_changes_state_flow() {
        let db = new_db();
        seed_task(&db, "t5");
        seed_session(&db, "s5", "t5");

        db.upsert_file_change("s5", "src/lib.rs", "update", 10, 2, Some("diff…"), None)
            .unwrap();

        let tl = db.get_session_timeline("s5").unwrap();
        assert_eq!(tl[0].state.as_deref(), Some("pending"), "initial state");

        db.update_file_change_state("s5", "src/lib.rs", "approved").unwrap();
        let tl = db.get_session_timeline("s5").unwrap();
        assert_eq!(tl[0].state.as_deref(), Some("approved"));

        db.update_file_change_state("s5", "src/lib.rs", "reverted").unwrap();
        let tl = db.get_session_timeline("s5").unwrap();
        assert_eq!(tl[0].state.as_deref(), Some("reverted"));
    }

    #[test]
    fn upsert_file_change_updates_existing() {
        let db = new_db();
        seed_task(&db, "t6");
        seed_session(&db, "s6", "t6");

        db.upsert_file_change("s6", "a.rs", "create", 3, 0, None, Some("/snap/a.rs")).unwrap();
        db.upsert_file_change("s6", "a.rs", "update", 7, 2, Some("new diff"), None).unwrap();

        let tl = db.get_session_timeline("s6").unwrap();
        assert_eq!(tl.len(), 1);
        assert_eq!(tl[0].added, Some(7));
        assert_eq!(tl[0].diff.as_deref(), Some("new diff"));

        // snapshot_path should be preserved from the first insert.
        let snap = db.get_snapshot_path("s6", "a.rs").unwrap();
        assert_eq!(snap.as_deref(), Some("/snap/a.rs"), "snapshot_path must survive upsert update");
    }

    // ── thread_id cold-resume path ────────────────────────────────────────────

    #[test]
    fn get_thread_id_initially_null_then_set() {
        let db = new_db();
        seed_task(&db, "t7");
        seed_session(&db, "s7", "t7");

        assert!(db.get_thread_id("s7").unwrap().is_none(), "should be null initially");

        db.update_session_thread_id("s7", "thread-xyz-789").unwrap();
        assert_eq!(
            db.get_thread_id("s7").unwrap().as_deref(),
            Some("thread-xyz-789")
        );
    }

    #[test]
    fn get_thread_id_unknown_session_returns_none() {
        let db = new_db();
        let result = db.get_thread_id("nonexistent").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn get_session_workdir() {
        let db = new_db();
        db.insert_task("t8", "Task 8", "/some/workdir").unwrap();
        db.insert_session("s8", "t8", "codex").unwrap();

        let wd = db.get_session_workdir("s8").unwrap();
        assert_eq!(wd.as_deref(), Some("/some/workdir"));
    }

    // ── session_count in list_tasks ───────────────────────────────────────────

    #[test]
    fn list_tasks_session_count() {
        let db = new_db();
        seed_task(&db, "t9");
        seed_session(&db, "s9a", "t9");
        seed_session(&db, "s9b", "t9");

        let tasks = db.list_tasks().unwrap();
        assert_eq!(tasks[0].session_count, 2);
    }

    // ── list_tasks ordering ───────────────────────────────────────────────────

    #[test]
    fn list_tasks_ordered_by_updated_at_desc() {
        let db = new_db();
        db.insert_task("older", "Older Task", "/a").unwrap();
        db.insert_task("newer", "Newer Task", "/b").unwrap();
        db.update_task_status("newer", "running").unwrap();

        let tasks = db.list_tasks().unwrap();
        assert_eq!(tasks[0].id, "newer", "most recently updated first");
        assert_eq!(tasks[1].id, "older");
    }

    // ── V2: snapshot_path storage & retrieval ─────────────────────────────────

    #[test]
    fn migration_v2_snapshot_path_column_exists() {
        // After open_in_memory(), both V1 and V2 migrations ran.
        // Inserting with snapshot_path should succeed.
        let db = new_db();
        seed_task(&db, "snap_t");
        seed_session(&db, "snap_s", "snap_t");
        db.upsert_file_change(
            "snap_s",
            "foo.txt",
            "create",
            5,
            0,
            None,
            Some("/snapshots/foo.txt"),
        )
        .unwrap();

        let snap = db.get_snapshot_path("snap_s", "foo.txt").unwrap();
        assert_eq!(snap.as_deref(), Some("/snapshots/foo.txt"));
    }

    #[test]
    fn old_rows_without_snapshot_path_are_null() {
        let db = new_db();
        seed_task(&db, "old_t");
        seed_session(&db, "old_s", "old_t");

        // Insert via raw SQL without snapshot_path (simulates a V1 row).
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO file_changes (session_id, path, kind, added, removed, state, ts) \
                 VALUES ('old_s', 'bar.rs', 'update', 1, 0, 'pending', 1000)",
                [],
            )
            .unwrap();
        }

        let snap = db.get_snapshot_path("old_s", "bar.rs").unwrap();
        assert!(snap.is_none(), "V1-style rows must have NULL snapshot_path");
    }

    // ── todo task creation ────────────────────────────────────────────────────

    #[test]
    fn insert_task_todo_creates_todo_status() {
        let db = new_db();
        db.insert_task_todo("td1", "My Todo Task", "/work").unwrap();
        let tasks = db.list_tasks().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, "todo");
        assert_eq!(tasks[0].last_session_id, None, "no session yet for todo task");
    }

    // ── update_task_title ─────────────────────────────────────────────────────

    #[test]
    fn update_task_title_changes_title() {
        let db = new_db();
        db.insert_task_todo("tt1", "Original Title", "/work").unwrap();
        db.update_task_title("tt1", "Updated Title").unwrap();
        let tasks = db.list_tasks().unwrap();
        assert_eq!(tasks[0].title, "Updated Title");
    }

    // ── delete_task cascade ───────────────────────────────────────────────────

    #[test]
    fn delete_task_cascades_all_child_records() {
        let db = new_db();
        seed_task(&db, "del_t");
        seed_session(&db, "del_s1", "del_t");
        seed_session(&db, "del_s2", "del_t");
        db.insert_message("del_s1", "user", "hi").unwrap();
        db.upsert_file_change("del_s1", "x.rs", "create", 1, 0, None, None).unwrap();
        db.insert_event("del_s2", "turn_completed", "{}").unwrap();

        db.delete_task("del_t").unwrap();

        // task should be gone
        let tasks = db.list_tasks().unwrap();
        assert!(tasks.is_empty(), "task should be deleted");

        // Verify cascade by attempting to read timeline (should be empty, not error).
        let tl = db.get_session_timeline("del_s1").unwrap();
        assert!(tl.is_empty(), "messages and file_changes should be cascade-deleted");
    }

    // ── state machine: valid transition ──────────────────────────────────────

    #[test]
    fn status_machine_awaiting_review_to_done_allowed() {
        let db = new_db();
        seed_task(&db, "sm1");
        db.update_task_status("sm1", "awaiting_review").unwrap();

        db.set_task_status_validated("sm1", "done").unwrap();

        let status = db.get_task_status("sm1").unwrap();
        assert_eq!(status.as_deref(), Some("done"));
    }

    // ── state machine: invalid transitions ───────────────────────────────────

    #[test]
    fn status_machine_todo_to_done_rejected() {
        let db = new_db();
        db.insert_task_todo("sm2", "T", "/").unwrap();
        let err = db.set_task_status_validated("sm2", "done").unwrap_err();
        assert!(err.contains("不允许"), "expected rejection, got: {}", err);
    }

    #[test]
    fn status_machine_running_to_done_rejected() {
        let db = new_db();
        seed_task(&db, "sm3"); // status = running
        let err = db.set_task_status_validated("sm3", "done").unwrap_err();
        assert!(err.contains("不允许"), "expected rejection, got: {}", err);
    }

    #[test]
    fn status_machine_nonexistent_task_rejected() {
        let db = new_db();
        let err = db.set_task_status_validated("nope", "done").unwrap_err();
        assert!(err.contains("不存在"), "expected not-found error, got: {}", err);
    }

    // ── last_session_id populated after dispatch ──────────────────────────────

    #[test]
    fn list_tasks_returns_last_session_id() {
        let db = new_db();
        db.insert_task_todo("task_ls", "Dispatched Task", "/w").unwrap();
        db.insert_session("sess_ls", "task_ls", "codex").unwrap();

        let tasks = db.list_tasks().unwrap();
        assert_eq!(
            tasks[0].last_session_id.as_deref(),
            Some("sess_ls"),
            "last_session_id should be the session we just created"
        );
    }

    // ── settings CRUD ─────────────────────────────────────────────────────────

    #[test]
    fn settings_set_and_get() {
        let db = new_db();
        db.settings_set("reasoning_effort", "high").unwrap();
        let v = db.settings_get("reasoning_effort").unwrap();
        assert_eq!(v.as_deref(), Some("high"));
    }

    #[test]
    fn settings_get_missing_returns_none() {
        let db = new_db();
        let v = db.settings_get("nonexistent_key").unwrap();
        assert!(v.is_none());
    }

    #[test]
    fn settings_upsert_overwrites() {
        let db = new_db();
        db.settings_set("k", "v1").unwrap();
        db.settings_set("k", "v2").unwrap();
        let v = db.settings_get("k").unwrap();
        assert_eq!(v.as_deref(), Some("v2"), "upsert should overwrite");
    }

    #[test]
    fn settings_get_all_returns_all() {
        let db = new_db();
        db.settings_set("a", "1").unwrap();
        db.settings_set("b", "2").unwrap();
        let all = db.settings_get_all().unwrap();
        assert_eq!(all.get("a").map(|s| s.as_str()), Some("1"));
        assert_eq!(all.get("b").map(|s| s.as_str()), Some("2"));
        assert_eq!(all.len(), 2);
    }

    // ── providers CRUD (V5) ───────────────────────────────────────────────────

    #[test]
    fn provider_upsert_insert_and_list() {
        let db = new_db();
        db.provider_upsert("p1", "OpenAI", "https://a.com", "chat", true)
            .unwrap();
        db.provider_upsert("p2", "Relay", "https://b.com", "responses", false)
            .unwrap();
        let list = db.providers_list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "p1", "ordered by created_at ASC");
        assert_eq!(list[0].wire_api, "chat");
        assert!(list[0].enabled);
        assert!(!list[0].has_key, "no key set yet");
        assert_eq!(list[1].wire_api, "responses");
        assert!(!list[1].enabled);
    }

    #[test]
    fn provider_upsert_updates_preserves_created_at_and_has_key() {
        let db = new_db();
        db.provider_upsert("p1", "Old", "https://a.com", "chat", true)
            .unwrap();
        let created = db.provider_get("p1").unwrap().unwrap().created_at;
        db.provider_set_has_key("p1", true).unwrap();

        db.provider_upsert("p1", "New", "https://b.com", "responses", false)
            .unwrap();
        let row = db.provider_get("p1").unwrap().unwrap();
        assert_eq!(row.label, "New");
        assert_eq!(row.base_url, "https://b.com");
        assert_eq!(row.wire_api, "responses");
        assert!(!row.enabled);
        assert_eq!(row.created_at, created, "created_at preserved on update");
        assert!(row.has_key, "has_key preserved across metadata update");
    }

    #[test]
    fn provider_set_has_key_and_delete() {
        let db = new_db();
        db.provider_upsert("p1", "L", "u", "chat", true).unwrap();
        db.provider_set_has_key("p1", true).unwrap();
        assert!(db.provider_get("p1").unwrap().unwrap().has_key);
        db.provider_set_has_key("p1", false).unwrap();
        assert!(!db.provider_get("p1").unwrap().unwrap().has_key);

        db.provider_delete("p1").unwrap();
        assert!(db.provider_get("p1").unwrap().is_none());
        assert!(db.providers_list().unwrap().is_empty());
    }

    #[test]
    fn get_file_change_kind_returns_correct_kind() {
        let db = new_db();
        seed_task(&db, "fck_t");
        seed_session(&db, "fck_s", "fck_t");
        db.upsert_file_change("fck_s", "new_file.rs", "create", 5, 0, None, None).unwrap();
        let kind = db.get_file_change_kind("fck_s", "new_file.rs").unwrap();
        assert_eq!(kind.as_deref(), Some("create"));
    }

    #[test]
    fn get_file_change_kind_missing_returns_none() {
        let db = new_db();
        let kind = db.get_file_change_kind("no_session", "no_file.rs").unwrap();
        assert!(kind.is_none());
    }

    // ── file_count in list_tasks ──────────────────────────────────────────────

    #[test]
    fn list_tasks_file_count() {
        let db = new_db();
        seed_task(&db, "fc_t");
        seed_session(&db, "fc_s", "fc_t");
        db.upsert_file_change("fc_s", "a.rs", "create", 1, 0, None, None).unwrap();
        db.upsert_file_change("fc_s", "b.rs", "create", 2, 0, None, None).unwrap();
        // Upsert same path again — should not increase count.
        db.upsert_file_change("fc_s", "a.rs", "update", 3, 1, None, None).unwrap();

        let tasks = db.list_tasks().unwrap();
        assert_eq!(tasks[0].file_count, 2, "2 distinct paths");
    }

    // ── canvas: get_task_sessions ─────────────────────────────────────────────

    #[test]
    fn get_task_sessions_ordered_by_started_at() {
        let db = new_db();
        seed_task(&db, "cts_t");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO sessions (id, task_id, engine, started_at) \
                 VALUES ('s_b', 'cts_t', 'codex', 200)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sessions (id, task_id, engine, thread_id, started_at, ended_at) \
                 VALUES ('s_a', 'cts_t', 'claude', 'th-1', 100, 150)",
                [],
            )
            .unwrap();
        }
        let rows = db.get_task_sessions("cts_t").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "s_a", "earlier started_at first");
        assert_eq!(rows[0].engine, "claude");
        assert_eq!(rows[0].thread_id.as_deref(), Some("th-1"));
        assert_eq!(rows[0].ended_at, Some(150));
        assert_eq!(rows[1].id, "s_b");
        assert!(rows[1].ended_at.is_none(), "running session has null ended_at");
        assert!(rows[1].thread_id.is_none());
    }

    #[test]
    fn get_task_sessions_empty_for_unknown_task() {
        let db = new_db();
        assert!(db.get_task_sessions("nope").unwrap().is_empty());
    }

    // ── canvas: get_session_events ────────────────────────────────────────────

    #[test]
    fn get_session_events_ordered_by_ts() {
        let db = new_db();
        seed_task(&db, "ge_t");
        seed_session(&db, "ge_s", "ge_t");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO events (session_id, type, payload_json, ts) \
                 VALUES ('ge_s', 'command_run', '{\"type\":\"command_run\",\"cmd\":\"ls\",\"exit_code\":0,\"output_tail\":\"a\"}', 300)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events (session_id, type, payload_json, ts) \
                 VALUES ('ge_s', 'assistant_message', '{\"type\":\"assistant_message\",\"text\":\"hi\"}', 100)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events (session_id, type, payload_json, ts) \
                 VALUES ('ge_s', 'file_edit', '{\"type\":\"file_edit\",\"path\":\"a.rs\"}', 200)",
                [],
            )
            .unwrap();
        }
        let rows = db.get_session_events("ge_s").unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].event_type, "assistant_message", "sorted by ts ASC");
        assert_eq!(rows[1].event_type, "file_edit");
        assert_eq!(rows[2].event_type, "command_run");
        assert!(rows[0].payload_json.contains("hi"));
        assert_eq!(rows[2].ts, 300);
    }

    #[test]
    fn get_session_events_empty_for_unknown_session() {
        let db = new_db();
        assert!(db.get_session_events("nope").unwrap().is_empty());
    }
}

mod studio;
pub use studio::{ChatMessageRow, ChatSessionRow, GenMediaRow};
