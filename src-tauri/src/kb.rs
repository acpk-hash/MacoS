//! Tauri commands for the research knowledge-base (KB).
//!
//! All commands delegate to `crate::db::Db` methods (via `state.db`).
//! DB connection / settings access follows the same pattern as lib.rs commands:
//! `state: State<'_, AppState>` → `state.db.settings_get/set/...`.
//!
//! Metadata extraction from filename (best-effort, no PDF parsing in Slice 1):
//!   arxiv_id  : r"(\d{4}\.\d{4,5})"
//!   eprint_id : r"(\d{4}/\d+)"
//!   doi       : r"(10\.\d{4,}/\S+)"
//!   year      : r"((?:19|20)\d{2})"

use std::path::{Path, PathBuf};

use tauri::State;

use crate::AppState;
use crate::db::{Category, Paper, PaperSummary, ScanResult, Tag};

// ── helpers ───────────────────────────────────────────────────────────────────

/// Return the KB root directory.
/// Priority: settings key `kb_root` → `%APPDATA%/agentboard/kb` (Windows)
///           or `~/.local/share/agentboard/kb` (other).
fn kb_root(db: &crate::db::Db) -> PathBuf {
    if let Ok(Some(v)) = db.settings_get("kb_root") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    #[cfg(windows)]
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:/Users/Default/AppData/Roaming"));
    #[cfg(not(windows))]
    let base = std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".local/share"))
        .unwrap_or_else(|_| PathBuf::from("/tmp"));
    base.join("agentboard").join("kb")
}

/// Extract metadata hints from a filename stem via simple regex-like patterns.
/// Returns (arxiv_id, eprint_id, doi, year) — all best-effort, may be None.
fn extract_filename_meta(stem: &str) -> (Option<String>, Option<String>, Option<String>, Option<i64>) {
    // arxiv_id: four digits, dot, four-or-five digits (e.g. 2301.12345)
    let arxiv_id = find_pattern_arxiv(stem);
    // eprint_id: four digits slash one-or-more digits (e.g. hep-th/9711200 or 1234/567)
    let eprint_id = find_pattern_eprint(stem);
    // doi: starts with 10. followed by 4+ digits and a slash (e.g. 10.1145/12345.67890)
    let doi = find_pattern_doi(stem);
    // year: (19|20)XX  four-digit year
    let year = find_pattern_year(stem);
    (arxiv_id, eprint_id, doi, year)
}

// ── Minimal pattern-matching without the `regex` crate ───────────────────────

fn find_pattern_arxiv(s: &str) -> Option<String> {
    // Match \d{4}\.\d{4,5}
    let bytes = s.as_bytes();
    let n = bytes.len();
    if n < 9 { return None; }
    for i in 0..=(n - 9) {
        if bytes[i..i+4].iter().all(|b| b.is_ascii_digit()) {
            if bytes[i + 4] == b'.' {
                let rest_start = i + 5;
                let rest_end_min = rest_start + 4;
                let rest_end_max = (rest_start + 5).min(n);
                if rest_end_min <= n {
                    // Find actual length of digits after dot
                    let digit_len = bytes[rest_start..rest_end_max]
                        .iter()
                        .take_while(|b| b.is_ascii_digit())
                        .count();
                    if digit_len == 4 || digit_len == 5 {
                        // Make sure the next char (if any) is not a digit
                        let end = rest_start + digit_len;
                        let terminated = end >= n || !bytes[end].is_ascii_digit();
                        if terminated {
                            return Some(s[i..end].to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

fn find_pattern_eprint(s: &str) -> Option<String> {
    // Match \d{4}/\d+ (but NOT inside a DOI, so skip if preceded by "10.")
    let bytes = s.as_bytes();
    let n = bytes.len();
    if n < 6 { return None; }
    for i in 0..=(n - 6) {
        if bytes[i..i+4].iter().all(|b| b.is_ascii_digit()) && bytes[i + 4] == b'/' {
            let rest = &bytes[i + 5..];
            let digit_len = rest.iter().take_while(|b| b.is_ascii_digit()).count();
            if digit_len >= 1 {
                return Some(s[i..i + 5 + digit_len].to_string());
            }
        }
    }
    None
}

fn find_pattern_doi(s: &str) -> Option<String> {
    // Match 10\.\d{4,}/\S+
    let mut i = 0;
    while i + 4 < s.len() {
        if s[i..].starts_with("10.") {
            let after = &s[i + 3..];
            // count digits
            let digit_len = after.bytes().take_while(|b| b.is_ascii_digit()).count();
            if digit_len >= 4 {
                let slash_pos = i + 3 + digit_len;
                if slash_pos < s.len() && s.as_bytes()[slash_pos] == b'/' {
                    // Collect non-whitespace chars after slash
                    let rest = &s[slash_pos + 1..];
                    let suffix_len = rest
                        .bytes()
                        .take_while(|b| !b.is_ascii_whitespace())
                        .count();
                    if suffix_len >= 1 {
                        return Some(s[i..slash_pos + 1 + suffix_len].to_string());
                    }
                }
            }
        }
        i += 1;
    }
    None
}

fn find_pattern_year(s: &str) -> Option<i64> {
    // Match (19|20)\d{2}
    let bytes = s.as_bytes();
    let n = bytes.len();
    if n < 4 { return None; }
    for i in 0..=(n - 4) {
        if (bytes[i] == b'1' && bytes[i + 1] == b'9')
            || (bytes[i] == b'2' && bytes[i + 1] == b'0')
        {
            if bytes[i + 2].is_ascii_digit() && bytes[i + 3].is_ascii_digit() {
                // Make sure not embedded in a longer digit run.
                let before_ok = i == 0 || !bytes[i - 1].is_ascii_digit();
                let after_ok = i + 4 >= n || !bytes[i + 4].is_ascii_digit();
                if before_ok && after_ok {
                    let year_str = &s[i..i + 4];
                    if let Ok(y) = year_str.parse::<i64>() {
                        return Some(y);
                    }
                }
            }
        }
    }
    None
}

/// Collect all `.pdf` files under `dir`. If `recursive` is false, only the
/// immediate directory is scanned (non-recursive).
fn collect_pdfs(dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let mut results = Vec::new();
    collect_pdfs_inner(dir, recursive, &mut results);
    results
}

fn collect_pdfs_inner(dir: &Path, recursive: bool, out: &mut Vec<PathBuf>) {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if recursive {
                collect_pdfs_inner(&path, recursive, out);
            }
        } else if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext.to_ascii_lowercase() == "pdf" {
                    out.push(path);
                }
            }
        }
    }
}

// ── Paper commands ────────────────────────────────────────────────────────────

/// List papers with optional filters.
///
/// - `category_id` : filter to this category (None = all categories)
/// - `tag_id`      : filter to papers that have this tag
/// - `query`       : LIKE match over title, authors, notes
/// - `starred`     : filter by starred flag
#[tauri::command]
pub async fn kb_list_papers(
    category_id: Option<String>,
    tag_id: Option<String>,
    query: Option<String>,
    starred: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<PaperSummary>, String> {
    state
        .db
        .kb_list_papers(
            category_id.as_deref(),
            tag_id.as_deref(),
            query.as_deref(),
            starred,
        )
        .map_err(|e| e.to_string())
}

/// Return the full paper record plus its tags.
#[tauri::command]
pub async fn kb_get_paper(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<Paper>, String> {
    state.db.kb_get_paper(&id).map_err(|e| e.to_string())
}

/// Scan a directory for PDF files and index them (just-in-place, managed=0).
///
/// Files already indexed (same absolute `file_path`) are skipped.
/// Metadata is extracted best-effort from the filename.
/// A `kb_scan_runs` record is inserted on completion.
#[tauri::command]
pub async fn kb_import_dir(
    dir: String,
    recursive: bool,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    let dir_path = PathBuf::from(&dir);
    let pdfs = collect_pdfs(&dir_path, recursive);
    let found = pdfs.len() as i64;
    let mut added: i64 = 0;

    for pdf in &pdfs {
        let file_path = match pdf.to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };

        // Skip if already indexed.
        match state.db.kb_paper_exists_by_path(&file_path) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => return Err(e.to_string()),
        }

        // Derive title from filename stem.
        let stem = pdf
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        let file_size = std::fs::metadata(pdf).ok().map(|m| m.len() as i64);

        let (arxiv_id, eprint_id, doi, year) = extract_filename_meta(&stem);

        let id = uuid::Uuid::new_v4().to_string();
        let orig_filename = pdf
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string());

        state
            .db
            .kb_insert_paper(
                &id,
                Some(&stem),
                orig_filename.as_deref(),
                &file_path,
                file_size,
                year,
                doi.as_deref(),
                arxiv_id.as_deref(),
                eprint_id.as_deref(),
                None,
                0,
            )
            .map_err(|e| e.to_string())?;

        added += 1;
    }

    // Record the scan run.
    let run_id = uuid::Uuid::new_v4().to_string();
    state
        .db
        .kb_insert_scan_run(&run_id, &dir, found, added)
        .map_err(|e| e.to_string())?;

    Ok(ScanResult { found, added })
}

/// Upload / index a single PDF file.
///
/// `mode`:
/// - `"index"`   : just-in-place (managed=0), no file copy
/// - `"library"` : copy the file into `kb_root/` (managed=1)
///
/// Returns the new paper id.
#[tauri::command]
pub async fn kb_upload_paper(
    src_path: String,
    mode: String,
    category_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let src = PathBuf::from(&src_path);
    if !src.exists() {
        return Err(format!("文件不存在: {}", src_path));
    }

    let (dest_path, managed) = if mode == "library" {
        let root = kb_root(&state.db);
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let fname = src
            .file_name()
            .ok_or_else(|| "无法获取文件名".to_string())?;
        let dest = root.join(fname);
        std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
        (dest.to_string_lossy().into_owned(), 1i64)
    } else {
        (src_path.clone(), 0i64)
    };

    // Check if already indexed by dest path.
    if state
        .db
        .kb_paper_exists_by_path(&dest_path)
        .map_err(|e| e.to_string())?
    {
        // Return existing id.
        // (Full dedup: find existing id by file_path.)
        let existing = state
            .db
            .kb_get_paper_id_by_path(&dest_path)
            .map_err(|e| e.to_string())?;
        return Ok(existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));
    }

    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let file_size = std::fs::metadata(&src).ok().map(|m| m.len() as i64);
    let (arxiv_id, eprint_id, doi, year) = extract_filename_meta(&stem);
    let orig_filename = src
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());

    let id = uuid::Uuid::new_v4().to_string();
    state
        .db
        .kb_insert_paper(
            &id,
            Some(&stem),
            orig_filename.as_deref(),
            &dest_path,
            file_size,
            year,
            doi.as_deref(),
            arxiv_id.as_deref(),
            eprint_id.as_deref(),
            category_id.as_deref(),
            managed,
        )
        .map_err(|e| e.to_string())?;

    Ok(id)
}

/// Update editable metadata fields for a paper.
/// Only non-None fields are written.
#[tauri::command]
pub async fn kb_update_metadata(
    id: String,
    title: Option<String>,
    authors: Option<String>,
    year: Option<i64>,
    venue: Option<String>,
    doi: Option<String>,
    notes: Option<String>,
    starred: Option<bool>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .db
        .kb_update_metadata(
            &id,
            title.as_deref(),
            authors.as_deref(),
            year,
            venue.as_deref(),
            doi.as_deref(),
            notes.as_deref(),
            starred,
        )
        .map_err(|e| e.to_string())
}

/// Assign a category to a paper. Pass `None` to clear.
#[tauri::command]
pub async fn kb_set_category(
    paper_id: String,
    category_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .db
        .kb_set_category(&paper_id, category_id.as_deref())
        .map_err(|e| e.to_string())
}

/// Delete a paper record (and its tag associations).
///
/// `delete_file` controls whether the physical file is removed:
/// - managed=1 and delete_file=true  → file is deleted from disk.
/// - managed=0 (just-in-place index) → **never** deletes the original file,
///   even if `delete_file=true`. Only the index record is removed.
///   (Safety: the user's original files must not be removed silently.)
#[tauri::command]
pub async fn kb_delete_paper(
    id: String,
    delete_file: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Read managed flag + path before deleting the DB record.
    let info = state
        .db
        .kb_paper_managed_info(&id)
        .map_err(|e| e.to_string())?;

    state.db.kb_delete_paper(&id).map_err(|e| e.to_string())?;

    // Only remove the physical file for managed=1 papers when explicitly requested.
    // managed=0 just-in-place papers: never touch the original file.
    if let Some((managed, file_path)) = info {
        if delete_file && managed == 1 {
            let _ = std::fs::remove_file(&file_path);
        }
        // managed=0: skip file deletion regardless of delete_file flag.
    }

    Ok(())
}

// ── Category commands ─────────────────────────────────────────────────────────

/// List all categories (sorted by sort ASC, name ASC).
#[tauri::command]
pub async fn kb_list_categories(
    state: State<'_, AppState>,
) -> Result<Vec<Category>, String> {
    state.db.kb_list_categories().map_err(|e| e.to_string())
}

/// Create a new category. Returns the new id.
#[tauri::command]
pub async fn kb_add_category(
    name: String,
    parent_id: Option<String>,
    color: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    state
        .db
        .kb_insert_category(&id, &name, parent_id.as_deref(), color.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Update category fields. Only non-None args are applied.
///
/// Note: `parent_id` and `color` use `Option<Option<String>>` so the caller can
/// explicitly set them to NULL (`Some(None)`) vs. leave them unchanged (`None`).
#[tauri::command]
pub async fn kb_update_category(
    id: String,
    name: Option<String>,
    parent_id: Option<Option<String>>,
    color: Option<Option<String>>,
    sort: Option<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .db
        .kb_update_category(
            &id,
            name.as_deref(),
            parent_id.as_ref().map(|o| o.as_deref()),
            color.as_ref().map(|o| o.as_deref()),
            sort,
        )
        .map_err(|e| e.to_string())
}

/// Delete a category. Papers in this category will have their category_id set to NULL.
#[tauri::command]
pub async fn kb_delete_category(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.kb_delete_category(&id).map_err(|e| e.to_string())
}

// ── Tag commands ──────────────────────────────────────────────────────────────

/// List all tags.
#[tauri::command]
pub async fn kb_list_tags(state: State<'_, AppState>) -> Result<Vec<Tag>, String> {
    state.db.kb_list_tags().map_err(|e| e.to_string())
}

/// Add one or more tags to a paper by name.
/// Each tag is upserted (created if it doesn't exist) then attached.
#[tauri::command]
pub async fn kb_add_tags(
    paper_id: String,
    tags: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    for tag_name in &tags {
        let new_id = uuid::Uuid::new_v4().to_string();
        let tag_id = state
            .db
            .kb_upsert_tag_by_name(&new_id, tag_name)
            .map_err(|e| e.to_string())?;
        state
            .db
            .kb_attach_tag(&paper_id, &tag_id)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Remove a tag from a paper.
#[tauri::command]
pub async fn kb_remove_tag(
    paper_id: String,
    tag_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .db
        .kb_remove_tag(&paper_id, &tag_id)
        .map_err(|e| e.to_string())
}

// ── Library root commands ─────────────────────────────────────────────────────

/// Return the KB root directory path (creates the default if no setting found).
#[tauri::command]
pub async fn kb_root_get(state: State<'_, AppState>) -> Result<String, String> {
    Ok(kb_root(&state.db).to_string_lossy().into_owned())
}

/// Set the KB root directory path.
#[tauri::command]
pub async fn kb_root_set(path: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .db
        .settings_set("kb_root", &path)
        .map_err(|e| e.to_string())
}
