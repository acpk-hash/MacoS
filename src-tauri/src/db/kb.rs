//! SQLite V7 additions for the research knowledge-base (KB).
//!
//! Tables (created by migration V7, wired from `super::Db::migrate`):
//!   - `kb_papers`      : indexed/managed PDF papers
//!   - `kb_categories`  : tree-form categories
//!   - `kb_tags`        : flat tag registry
//!   - `kb_paper_tags`  : paper ↔ tag join
//!   - `kb_scan_runs`   : import scan audit log
//!
//! All CRUD lives in inherent `impl super::Db` blocks so it shares the same
//! single `Mutex<Connection>` as the rest of the database layer.

use super::{now_ms, Db};
use rusqlite::{params, Result as SqlResult};
use serde::{Deserialize, Serialize};

// ── Schema ────────────────────────────────────────────────────────────────────

/// V7: knowledge-base tables.
///
/// `managed` flag: 0 = just-in-place index (original file untouched),
///                 1 = file has been copied into the unified KB root.
pub(crate) const SCHEMA_V7: &str = r#"
CREATE TABLE IF NOT EXISTS kb_papers (
    id            TEXT PRIMARY KEY,
    title         TEXT,
    authors       TEXT,
    year          INTEGER,
    venue         TEXT,
    abstract      TEXT,
    doi           TEXT,
    arxiv_id      TEXT,
    eprint_id     TEXT,
    orig_filename TEXT,
    file_path     TEXT UNIQUE,
    file_size     INTEGER,
    category_id   TEXT,
    starred       INTEGER NOT NULL DEFAULT 0,
    notes         TEXT,
    managed       INTEGER NOT NULL DEFAULT 0,
    added_at      INTEGER,
    updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS kb_categories (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    parent_id TEXT,
    color     TEXT,
    sort      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kb_tags (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE,
    color TEXT
);

CREATE TABLE IF NOT EXISTS kb_paper_tags (
    paper_id TEXT NOT NULL,
    tag_id   TEXT NOT NULL,
    PRIMARY KEY (paper_id, tag_id)
);

CREATE TABLE IF NOT EXISTS kb_scan_runs (
    id    TEXT PRIMARY KEY,
    dir   TEXT NOT NULL,
    found INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    ts    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_papers_category  ON kb_papers(category_id);
CREATE INDEX IF NOT EXISTS idx_kb_papers_added     ON kb_papers(added_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_paper_tags_paper ON kb_paper_tags(paper_id);
CREATE INDEX IF NOT EXISTS idx_kb_paper_tags_tag   ON kb_paper_tags(tag_id);
"#;

// ── Row types ─────────────────────────────────────────────────────────────────

/// Lightweight paper row returned by `kb_list_papers`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperSummary {
    pub id: String,
    pub title: Option<String>,
    pub authors: Option<String>,
    pub year: Option<i64>,
    pub venue: Option<String>,
    pub category_id: Option<String>,
    pub starred: i64,
    pub file_size: Option<i64>,
    pub added_at: Option<i64>,
    pub orig_filename: Option<String>,
}

/// Full paper row (all fields + tag list) returned by `kb_get_paper`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Paper {
    pub id: String,
    pub title: Option<String>,
    pub authors: Option<String>,
    pub year: Option<i64>,
    pub venue: Option<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub eprint_id: Option<String>,
    pub orig_filename: Option<String>,
    pub file_path: Option<String>,
    pub file_size: Option<i64>,
    pub category_id: Option<String>,
    pub starred: i64,
    pub notes: Option<String>,
    pub managed: i64,
    pub added_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub tags: Vec<TagRef>,
}

/// A tag reference attached to a paper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagRef {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
}

/// Category row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub color: Option<String>,
    pub sort: i64,
}

/// Tag row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
}

/// Scan run summary returned by `kb_import_dir`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub found: i64,
    pub added: i64,
}

// ── impl Db ───────────────────────────────────────────────────────────────────

impl Db {
    // ── Papers ────────────────────────────────────────────────────────────────

    /// List papers with optional filters: category_id, tag_id, fulltext query,
    /// and starred flag. `query` is matched against title/authors/notes via LIKE.
    pub fn kb_list_papers(
        &self,
        category_id: Option<&str>,
        tag_id: Option<&str>,
        query: Option<&str>,
        starred: Option<bool>,
    ) -> SqlResult<Vec<PaperSummary>> {
        let conn = self.conn.lock().unwrap();

        // Build dynamic WHERE clauses.
        let mut conds: Vec<String> = Vec::new();
        if category_id.is_some() {
            conds.push("p.category_id = ?1".to_string());
        }
        if starred.is_some() {
            conds.push(format!("p.starred = {}", if starred.unwrap() { 1 } else { 0 }));
        }
        if query.is_some() {
            conds.push("(p.title LIKE ?2 OR p.authors LIKE ?2 OR p.notes LIKE ?2)".to_string());
        }
        if tag_id.is_some() {
            conds.push(
                "EXISTS (SELECT 1 FROM kb_paper_tags pt WHERE pt.paper_id = p.id AND pt.tag_id = ?3)"
                    .to_string(),
            );
        }

        let where_clause = if conds.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conds.join(" AND "))
        };

        let sql = format!(
            "SELECT p.id, p.title, p.authors, p.year, p.venue, p.category_id, \
                    p.starred, p.file_size, p.added_at, p.orig_filename \
             FROM kb_papers p \
             {} \
             ORDER BY p.added_at DESC",
            where_clause
        );

        let like_query = query.map(|q| format!("%{}%", q));

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(build_kb_list_params(
                category_id,
                like_query.as_deref(),
                tag_id,
            )),
            |row| {
                Ok(PaperSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    authors: row.get(2)?,
                    year: row.get(3)?,
                    venue: row.get(4)?,
                    category_id: row.get(5)?,
                    starred: row.get(6)?,
                    file_size: row.get(7)?,
                    added_at: row.get(8)?,
                    orig_filename: row.get(9)?,
                })
            },
        )?;
        rows.collect()
    }

    /// Fetch a single paper by id plus its attached tags. Returns None if not found.
    pub fn kb_get_paper(&self, id: &str) -> SqlResult<Option<Paper>> {
        let conn = self.conn.lock().unwrap();

        let paper_opt: Option<Paper> = match conn.query_row(
            "SELECT id, title, authors, year, venue, abstract, doi, arxiv_id, eprint_id, \
                    orig_filename, file_path, file_size, category_id, starred, notes, managed, \
                    added_at, updated_at \
             FROM kb_papers WHERE id = ?1",
            params![id],
            |row| {
                Ok(Paper {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    authors: row.get(2)?,
                    year: row.get(3)?,
                    venue: row.get(4)?,
                    abstract_text: row.get(5)?,
                    doi: row.get(6)?,
                    arxiv_id: row.get(7)?,
                    eprint_id: row.get(8)?,
                    orig_filename: row.get(9)?,
                    file_path: row.get(10)?,
                    file_size: row.get(11)?,
                    category_id: row.get(12)?,
                    starred: row.get(13)?,
                    notes: row.get(14)?,
                    managed: row.get(15)?,
                    added_at: row.get(16)?,
                    updated_at: row.get(17)?,
                    tags: Vec::new(),
                })
            },
        ) {
            Ok(p) => Some(p),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e),
        };

        let mut paper = match paper_opt {
            Some(p) => p,
            None => return Ok(None),
        };

        // Attach tags.
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, t.color \
             FROM kb_tags t \
             JOIN kb_paper_tags pt ON pt.tag_id = t.id \
             WHERE pt.paper_id = ?1",
        )?;
        let tag_rows = stmt.query_map(params![id], |row| {
            Ok(TagRef {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })?;
        for t in tag_rows {
            paper.tags.push(t?);
        }

        Ok(Some(paper))
    }

    /// Insert a new paper record (just-in-place index, managed=0).
    /// Returns the inserted id.
    pub fn kb_insert_paper(
        &self,
        id: &str,
        title: Option<&str>,
        orig_filename: Option<&str>,
        file_path: &str,
        file_size: Option<i64>,
        year: Option<i64>,
        doi: Option<&str>,
        arxiv_id: Option<&str>,
        eprint_id: Option<&str>,
        category_id: Option<&str>,
        managed: i64,
    ) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO kb_papers \
             (id, title, orig_filename, file_path, file_size, year, doi, arxiv_id, eprint_id, \
              category_id, managed, added_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
            params![
                id, title, orig_filename, file_path, file_size, year, doi, arxiv_id,
                eprint_id, category_id, managed, now
            ],
        )?;
        Ok(())
    }

    /// Check whether a file_path already exists in kb_papers.
    pub fn kb_paper_exists_by_path(&self, file_path: &str) -> SqlResult<bool> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM kb_papers WHERE file_path = ?1",
            params![file_path],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Update writable metadata fields (only non-None args are applied).
    pub fn kb_update_metadata(
        &self,
        id: &str,
        title: Option<&str>,
        authors: Option<&str>,
        year: Option<i64>,
        venue: Option<&str>,
        doi: Option<&str>,
        notes: Option<&str>,
        starred: Option<bool>,
    ) -> SqlResult<()> {
        let now = now_ms();
        let conn = self.conn.lock().unwrap();
        if let Some(v) = title {
            conn.execute("UPDATE kb_papers SET title = ?1, updated_at = ?2 WHERE id = ?3", params![v, now, id])?;
        }
        if let Some(v) = authors {
            conn.execute("UPDATE kb_papers SET authors = ?1, updated_at = ?2 WHERE id = ?3", params![v, now, id])?;
        }
        if let Some(v) = year {
            conn.execute("UPDATE kb_papers SET year = ?1, updated_at = ?2 WHERE id = ?3", params![v, now, id])?;
        }
        if let Some(v) = venue {
            conn.execute("UPDATE kb_papers SET venue = ?1, updated_at = ?2 WHERE id = ?3", params![v, now, id])?;
        }
        if let Some(v) = doi {
            conn.execute("UPDATE kb_papers SET doi = ?1, updated_at = ?2 WHERE id = ?3", params![v, now, id])?;
        }
        if let Some(v) = notes {
            conn.execute("UPDATE kb_papers SET notes = ?1, updated_at = ?2 WHERE id = ?3", params![v, now, id])?;
        }
        if let Some(v) = starred {
            let flag: i64 = if v { 1 } else { 0 };
            conn.execute("UPDATE kb_papers SET starred = ?1, updated_at = ?2 WHERE id = ?3", params![flag, now, id])?;
        }
        Ok(())
    }

    /// Set the category for a paper (None clears it).
    pub fn kb_set_category(&self, paper_id: &str, category_id: Option<&str>) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "UPDATE kb_papers SET category_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![category_id, now, paper_id],
        )?;
        Ok(())
    }

    /// Update a paper's file_path and managed flag (used after copying to library).
    pub fn kb_paper_set_managed_path(
        &self,
        id: &str,
        file_path: &str,
        managed: i64,
    ) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "UPDATE kb_papers SET file_path = ?1, managed = ?2, updated_at = ?3 WHERE id = ?4",
            params![file_path, managed, now, id],
        )?;
        Ok(())
    }

    /// Return the managed flag and file_path for a paper.
    pub fn kb_paper_managed_info(&self, id: &str) -> SqlResult<Option<(i64, String)>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT managed, file_path FROM kb_papers WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Return the id of a paper by its file_path, or None if not found.
    pub fn kb_get_paper_id_by_path(&self, file_path: &str) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row(
            "SELECT id FROM kb_papers WHERE file_path = ?1",
            params![file_path],
            |row| row.get::<_, String>(0),
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Delete a paper record and its tag associations.
    pub fn kb_delete_paper(&self, id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM kb_paper_tags WHERE paper_id = ?1", params![id])?;
        conn.execute("DELETE FROM kb_papers WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ── Scan runs ─────────────────────────────────────────────────────────────

    /// Record a completed scan run.
    pub fn kb_insert_scan_run(
        &self,
        id: &str,
        dir: &str,
        found: i64,
        added: i64,
    ) -> SqlResult<()> {
        let now = now_ms();
        self.conn.lock().unwrap().execute(
            "INSERT INTO kb_scan_runs (id, dir, found, added, ts) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, dir, found, added, now],
        )?;
        Ok(())
    }

    // ── Categories ────────────────────────────────────────────────────────────

    /// List all categories.
    pub fn kb_list_categories(&self) -> SqlResult<Vec<Category>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, parent_id, color, sort FROM kb_categories ORDER BY sort ASC, name ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                color: row.get(3)?,
                sort: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// Insert a new category row. Returns nothing (caller supplies id).
    pub fn kb_insert_category(
        &self,
        id: &str,
        name: &str,
        parent_id: Option<&str>,
        color: Option<&str>,
    ) -> SqlResult<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO kb_categories (id, name, parent_id, color) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, parent_id, color],
        )?;
        Ok(())
    }

    /// Update category fields (only non-None args applied).
    pub fn kb_update_category(
        &self,
        id: &str,
        name: Option<&str>,
        parent_id: Option<Option<&str>>,
        color: Option<Option<&str>>,
        sort: Option<i64>,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        if let Some(v) = name {
            conn.execute("UPDATE kb_categories SET name = ?1 WHERE id = ?2", params![v, id])?;
        }
        if let Some(v) = parent_id {
            conn.execute("UPDATE kb_categories SET parent_id = ?1 WHERE id = ?2", params![v, id])?;
        }
        if let Some(v) = color {
            conn.execute("UPDATE kb_categories SET color = ?1 WHERE id = ?2", params![v, id])?;
        }
        if let Some(v) = sort {
            conn.execute("UPDATE kb_categories SET sort = ?1 WHERE id = ?2", params![v, id])?;
        }
        Ok(())
    }

    /// Delete a category and set all its papers' category_id to NULL.
    pub fn kb_delete_category(&self, id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE kb_papers SET category_id = NULL WHERE category_id = ?1",
            params![id],
        )?;
        conn.execute("DELETE FROM kb_categories WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ── Tags ──────────────────────────────────────────────────────────────────

    /// List all tags.
    pub fn kb_list_tags(&self) -> SqlResult<Vec<Tag>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, color FROM kb_tags ORDER BY name ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })?;
        rows.collect()
    }

    /// Upsert a tag by name (insert if absent, return existing id if present).
    /// Returns the tag id.
    pub fn kb_upsert_tag_by_name(&self, id_new: &str, name: &str) -> SqlResult<String> {
        let conn = self.conn.lock().unwrap();
        // Try to find existing.
        let existing: Option<String> = match conn.query_row(
            "SELECT id FROM kb_tags WHERE name = ?1",
            params![name],
            |row| row.get(0),
        ) {
            Ok(v) => Some(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e),
        };
        if let Some(existing_id) = existing {
            return Ok(existing_id);
        }
        conn.execute(
            "INSERT INTO kb_tags (id, name) VALUES (?1, ?2)",
            params![id_new, name],
        )?;
        Ok(id_new.to_string())
    }

    /// Attach a tag to a paper (idempotent — ignores duplicate).
    pub fn kb_attach_tag(&self, paper_id: &str, tag_id: &str) -> SqlResult<()> {
        self.conn.lock().unwrap().execute(
            "INSERT OR IGNORE INTO kb_paper_tags (paper_id, tag_id) VALUES (?1, ?2)",
            params![paper_id, tag_id],
        )?;
        Ok(())
    }

    /// Detach a tag from a paper.
    pub fn kb_remove_tag(&self, paper_id: &str, tag_id: &str) -> SqlResult<()> {
        self.conn.lock().unwrap().execute(
            "DELETE FROM kb_paper_tags WHERE paper_id = ?1 AND tag_id = ?2",
            params![paper_id, tag_id],
        )?;
        Ok(())
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Build the positional parameter list for `kb_list_papers`.
///
/// Slot mapping (matches the WHERE clause built in `kb_list_papers`):
///   ?1 = category_id (if Some)
///   ?2 = LIKE query  (if Some)
///   ?3 = tag_id      (if Some)
fn build_kb_list_params<'a>(
    category_id: Option<&'a str>,
    like_query: Option<&'a str>,
    tag_id: Option<&'a str>,
) -> Vec<Box<dyn rusqlite::ToSql + 'a>> {
    let mut p: Vec<Box<dyn rusqlite::ToSql + 'a>> = Vec::new();
    if let Some(v) = category_id {
        p.push(Box::new(v));
    }
    if let Some(v) = like_query {
        p.push(Box::new(v));
    }
    if let Some(v) = tag_id {
        p.push(Box::new(v));
    }
    p
}
