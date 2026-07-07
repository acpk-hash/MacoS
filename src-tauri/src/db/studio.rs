//! SQLite V4 additions for the multimodal studio (chat + generated media).
//!
//! Tables (created by migration V4, wired from `super::Db::migrate`):
//!   - `chat_sessions`  : one row per chat conversation
//!   - `chat_messages`  : messages within a chat session
//!   - `gen_media`      : generated images / videos and their local files
//!
//! All CRUD lives in inherent `impl super::Db` blocks so it shares the same
//! single `Mutex<Connection>` as the rest of the database layer.

use super::{now_ms, Db};
use rusqlite::{params, Result as SqlResult};
use serde::{Deserialize, Serialize};

// -- Schema ------------------------------------------------------------------

/// V4: chat sessions/messages + generated media tables.
pub(crate) const SCHEMA_V4: &str = r#"
CREATE TABLE IF NOT EXISTS chat_sessions (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT '',
    model      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id               TEXT PRIMARY KEY,
    session_id       TEXT NOT NULL,
    role             TEXT NOT NULL,
    content          TEXT NOT NULL DEFAULT '',
    attachments_json TEXT,
    model            TEXT,
    status           TEXT NOT NULL DEFAULT 'complete',
    created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gen_media (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    prompt      TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    params_json TEXT,
    local_path  TEXT,
    source_url  TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    error       TEXT,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_gen_media_created     ON gen_media(created_at DESC);
"#;

// -- Row types ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSessionRow {
    pub id: String,
    pub title: String,
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageRow {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub attachments_json: Option<String>,
    pub model: Option<String>,
    pub status: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenMediaRow {
    pub id: String,
    pub kind: String,
    pub prompt: String,
    pub model: String,
    pub params_json: Option<String>,
    pub local_path: Option<String>,
    pub source_url: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
}

// -- Chat session CRUD -------------------------------------------------------

impl Db {
    /// Create a new (empty) chat session.
    pub fn chat_session_create(&self, id: &str, title: &str, model: &str) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO chat_sessions (id, title, model, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, title, model, now],
        )?;
        Ok(())
    }

    /// List chat sessions ordered by `updated_at DESC` (max 500).
    pub fn chat_sessions_list(&self) -> SqlResult<Vec<ChatSessionRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, model, created_at, updated_at \
             FROM chat_sessions ORDER BY updated_at DESC LIMIT 500",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ChatSessionRow {
                id: r.get(0)?,
                title: r.get(1)?,
                model: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// Fetch a single chat session by id.
    pub fn chat_session_get(&self, id: &str) -> SqlResult<Option<ChatSessionRow>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT id, title, model, created_at, updated_at FROM chat_sessions WHERE id = ?1",
            params![id],
            |r| {
                Ok(ChatSessionRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    model: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            },
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Rename a chat session and bump `updated_at`.
    pub fn chat_session_rename(&self, id: &str, title: &str) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "UPDATE chat_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now, id],
        )?;
        Ok(())
    }

    /// Set the title only if it is currently empty (used for auto-titling).
    pub fn chat_session_set_title_if_empty(&self, id: &str, title: &str) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "UPDATE chat_sessions SET title = ?1, updated_at = ?2 \
             WHERE id = ?3 AND (title IS NULL OR title = '')",
            params![title, now, id],
        )?;
        Ok(())
    }

    /// Bump a session's `updated_at` (called when a message is appended).
    pub fn chat_session_touch(&self, id: &str) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(())
    }

    /// Delete a chat session and all of its messages.
    pub fn chat_session_delete(&self, id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM chat_messages WHERE session_id = ?1",
            params![id],
        )?;
        conn.execute("DELETE FROM chat_sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    // -- Chat message CRUD ---------------------------------------------------

    /// Insert a chat message.
    #[allow(clippy::too_many_arguments)]
    pub fn chat_message_insert(
        &self,
        id: &str,
        session_id: &str,
        role: &str,
        content: &str,
        attachments_json: Option<&str>,
        model: Option<&str>,
        status: &str,
    ) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO chat_messages \
             (id, session_id, role, content, attachments_json, model, status, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                session_id,
                role,
                content,
                attachments_json,
                model,
                status,
                now
            ],
        )?;
        Ok(())
    }

    /// Update a message's content and status (used to finalize a streamed reply).
    pub fn chat_message_update(&self, id: &str, content: &str, status: &str) -> SqlResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE chat_messages SET content = ?1, status = ?2 WHERE id = ?3",
            params![content, status, id],
        )?;
        Ok(())
    }

    /// List all messages for a session ordered by `created_at ASC`.
    pub fn chat_messages_list(&self, session_id: &str) -> SqlResult<Vec<ChatMessageRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, attachments_json, model, status, created_at \
             FROM chat_messages WHERE session_id = ?1 ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |r| {
            Ok(ChatMessageRow {
                id: r.get(0)?,
                session_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                attachments_json: r.get(4)?,
                model: r.get(5)?,
                status: r.get(6)?,
                created_at: r.get(7)?,
            })
        })?;
        rows.collect()
    }

    // -- Generated media CRUD ------------------------------------------------

    /// Insert a generated-media row (typically with status `running`/`pending`).
    pub fn gen_media_insert(
        &self,
        id: &str,
        kind: &str,
        prompt: &str,
        model: &str,
        params_json: Option<&str>,
        status: &str,
    ) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO gen_media \
             (id, kind, prompt, model, params_json, status, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, kind, prompt, model, params_json, status, now],
        )?;
        Ok(())
    }

    /// Mark a media row as done with its local path (and optional source url).
    pub fn gen_media_mark_done(
        &self,
        id: &str,
        local_path: &str,
        source_url: Option<&str>,
    ) -> SqlResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE gen_media SET status = 'done', local_path = ?1, source_url = ?2, error = NULL \
             WHERE id = ?3",
            params![local_path, source_url, id],
        )?;
        Ok(())
    }

    /// Mark a media row as failed with an error message.
    pub fn gen_media_mark_failed(&self, id: &str, error: &str) -> SqlResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE gen_media SET status = 'failed', error = ?1 WHERE id = ?2",
            params![error, id],
        )?;
        Ok(())
    }

    /// List generated media, optionally filtered by `kind`, newest first.
    pub fn gen_media_list(&self, kind: Option<&str>) -> SqlResult<Vec<GenMediaRow>> {
        let conn = self.conn.lock().unwrap();
        match kind {
            Some(k) => {
                let mut stmt = conn.prepare(
                    "SELECT id, kind, prompt, model, params_json, local_path, source_url, status, error, created_at \
                     FROM gen_media WHERE kind = ?1 ORDER BY created_at DESC LIMIT 500",
                )?;
                let rows = stmt.query_map(params![k], map_gen_media)?;
                rows.collect()
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT id, kind, prompt, model, params_json, local_path, source_url, status, error, created_at \
                     FROM gen_media ORDER BY created_at DESC LIMIT 500",
                )?;
                let rows = stmt.query_map([], map_gen_media)?;
                rows.collect()
            }
        }
    }

    /// Fetch a single generated-media row by id (used for edit provenance).
    pub fn gen_media_get(&self, id: &str) -> SqlResult<Option<GenMediaRow>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT id, kind, prompt, model, params_json, local_path, source_url, status, error, created_at \
             FROM gen_media WHERE id = ?1",
            params![id],
            map_gen_media,
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Return the local file path stored for a media row.
    pub fn gen_media_get_local_path(&self, id: &str) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT local_path FROM gen_media WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        ) {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Delete a media row (the caller removes the file on disk).
    pub fn gen_media_delete(&self, id: &str) -> SqlResult<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM gen_media WHERE id = ?1", params![id])?;
        Ok(())
    }
}

fn map_gen_media(r: &rusqlite::Row<'_>) -> rusqlite::Result<GenMediaRow> {
    Ok(GenMediaRow {
        id: r.get(0)?,
        kind: r.get(1)?,
        prompt: r.get(2)?,
        model: r.get(3)?,
        params_json: r.get(4)?,
        local_path: r.get(5)?,
        source_url: r.get(6)?,
        status: r.get(7)?,
        error: r.get(8)?,
        created_at: r.get(9)?,
    })
}

// -- Unit tests --------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn new_db() -> Db {
        Db::open_in_memory().expect("in-memory DB")
    }

    #[test]
    fn chat_session_create_and_list() {
        let db = new_db();
        db.chat_session_create("cs1", "Hello", "gpt-5.5").unwrap();
        let list = db.chat_sessions_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "cs1");
        assert_eq!(list[0].title, "Hello");
        assert_eq!(list[0].model, "gpt-5.5");
    }

    #[test]
    fn chat_session_rename_and_get() {
        let db = new_db();
        db.chat_session_create("cs2", "old", "m").unwrap();
        db.chat_session_rename("cs2", "new").unwrap();
        let row = db.chat_session_get("cs2").unwrap().unwrap();
        assert_eq!(row.title, "new");
    }

    #[test]
    fn chat_session_set_title_if_empty_only_when_blank() {
        let db = new_db();
        db.chat_session_create("cs3", "", "m").unwrap();
        db.chat_session_set_title_if_empty("cs3", "Auto Title")
            .unwrap();
        assert_eq!(
            db.chat_session_get("cs3").unwrap().unwrap().title,
            "Auto Title"
        );
        // Second call must NOT overwrite an existing title.
        db.chat_session_set_title_if_empty("cs3", "Should Not Apply")
            .unwrap();
        assert_eq!(
            db.chat_session_get("cs3").unwrap().unwrap().title,
            "Auto Title"
        );
    }

    #[test]
    fn chat_messages_insert_list_order() {
        let db = new_db();
        db.chat_session_create("cs4", "t", "m").unwrap();
        db.chat_message_insert("m1", "cs4", "user", "hi", None, Some("m"), "complete")
            .unwrap();
        db.chat_message_insert("m2", "cs4", "assistant", "", None, Some("m"), "streaming")
            .unwrap();
        let rows = db.chat_messages_list("cs4").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].role, "user");
        assert_eq!(rows[1].role, "assistant");
        assert_eq!(rows[1].status, "streaming");
    }

    #[test]
    fn chat_message_update_finalizes() {
        let db = new_db();
        db.chat_session_create("cs5", "t", "m").unwrap();
        db.chat_message_insert("mm", "cs5", "assistant", "", None, None, "streaming")
            .unwrap();
        db.chat_message_update("mm", "final text", "complete")
            .unwrap();
        let rows = db.chat_messages_list("cs5").unwrap();
        assert_eq!(rows[0].content, "final text");
        assert_eq!(rows[0].status, "complete");
    }

    #[test]
    fn chat_message_attachments_roundtrip() {
        let db = new_db();
        db.chat_session_create("cs6", "t", "m").unwrap();
        let atts = r#"[{"kind":"image","data_url":"data:image/png;base64,AAAA"}]"#;
        db.chat_message_insert(
            "ma",
            "cs6",
            "user",
            "look",
            Some(atts),
            Some("m"),
            "complete",
        )
        .unwrap();
        let rows = db.chat_messages_list("cs6").unwrap();
        assert_eq!(rows[0].attachments_json.as_deref(), Some(atts));
    }

    #[test]
    fn chat_session_delete_cascades_messages() {
        let db = new_db();
        db.chat_session_create("cs7", "t", "m").unwrap();
        db.chat_message_insert("x1", "cs7", "user", "a", None, None, "complete")
            .unwrap();
        db.chat_session_delete("cs7").unwrap();
        assert!(db.chat_sessions_list().unwrap().is_empty());
        assert!(db.chat_messages_list("cs7").unwrap().is_empty());
    }

    #[test]
    fn gen_media_insert_done_flow() {
        let db = new_db();
        db.gen_media_insert(
            "g1",
            "image",
            "a cat",
            "gpt-image-2",
            Some("{\"n\":1}"),
            "running",
        )
        .unwrap();
        db.gen_media_mark_done("g1", "C:/media/g1.png", Some("https://img/x.png"))
            .unwrap();
        let list = db.gen_media_list(Some("image")).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].status, "done");
        assert_eq!(list[0].local_path.as_deref(), Some("C:/media/g1.png"));
        assert_eq!(list[0].source_url.as_deref(), Some("https://img/x.png"));
    }

    #[test]
    fn gen_media_failed_flow_and_kind_filter() {
        let db = new_db();
        db.gen_media_insert("g2", "image", "p", "m", None, "running")
            .unwrap();
        db.gen_media_insert("g3", "video", "p", "m", None, "running")
            .unwrap();
        db.gen_media_mark_failed("g2", "boom").unwrap();
        let imgs = db.gen_media_list(Some("image")).unwrap();
        assert_eq!(imgs.len(), 1);
        assert_eq!(imgs[0].status, "failed");
        assert_eq!(imgs[0].error.as_deref(), Some("boom"));
        let all = db.gen_media_list(None).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn gen_media_get_path_and_delete() {
        let db = new_db();
        db.gen_media_insert("g4", "image", "p", "m", None, "running")
            .unwrap();
        db.gen_media_mark_done("g4", "/tmp/g4.png", None).unwrap();
        assert_eq!(
            db.gen_media_get_local_path("g4").unwrap().as_deref(),
            Some("/tmp/g4.png")
        );
        db.gen_media_delete("g4").unwrap();
        assert!(db.gen_media_get_local_path("g4").unwrap().is_none());
        assert!(db.gen_media_list(None).unwrap().is_empty());
    }
}
