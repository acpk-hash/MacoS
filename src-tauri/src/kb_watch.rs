//! File-system watcher for the research knowledge-base (KB).
//!
//! Watches all directories that contain indexed KB papers (plus the KB root if
//! configured) and emits a `kb-event` Tauri event whenever a change is detected.
//!
//! Commands:
//!   `kb_watch_start` — collect watched dirs from DB and (re)start the debouncer.
//!   `kb_watch_stop`  — drop the debouncer (stops all watches).
//!
//! Event contract:
//!   channel : "kb-event"
//!   payload : { "kind": "changed" }

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::{new_debouncer, notify::RecommendedWatcher, Debouncer};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

// ── State type ────────────────────────────────────────────────────────────────

/// Managed state holding the live debouncer (if watching) or None (stopped).
pub struct KbWatcher {
    pub inner: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

impl Default for KbWatcher {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Collect the set of directories to watch from the DB:
///   1. KB root (if the `kb_root` setting is configured and the dir exists).
///   2. Parent directory of every paper's `file_path` (de-duplicated).
fn collect_watch_dirs(state: &AppState) -> Vec<PathBuf> {
    let mut dirs: HashSet<PathBuf> = HashSet::new();

    // 1. KB root setting.
    if let Ok(Some(root_str)) = state.db.settings_get("kb_root") {
        let root = PathBuf::from(root_str.trim());
        if root.is_dir() {
            dirs.insert(root);
        }
    }

    // 2. Parent directories of all indexed paper file_paths.
    //    We query the DB directly (kb_list_papers returns PaperSummary without file_path).
    {
        let conn = state.db.conn.lock().unwrap();
        let mut stmt = match conn.prepare("SELECT file_path FROM kb_papers WHERE file_path IS NOT NULL") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[kb_watch] DB prepare error: {e}");
                return dirs.into_iter().collect();
            }
        };
        let paths: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap_or_else(|_| {
                // rusqlite MappedRows doesn't implement Default; return empty via early-exit
                panic!("unreachable: query_map failed after prepare succeeded")
            })
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        drop(conn);
        for path_str in paths {
            let path = PathBuf::from(&path_str);
            if let Some(parent) = path.parent() {
                let parent = parent.to_path_buf();
                if parent.is_dir() {
                    dirs.insert(parent);
                }
            }
        }
    }

    dirs.into_iter().collect()
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Start (or restart) the KB file-system watcher.
///
/// Collects all directories that contain indexed papers (plus the KB root) and
/// registers a non-recursive inotify/FSEvents/ReadDirectoryChangesW watch on
/// each. Incoming file-system events are debounced for ~800 ms; a single
/// `kb-event { kind: "changed" }` is then emitted to all frontend listeners.
///
/// Calling this again while already watching is safe — it drops the old
/// debouncer (stopping previous watches) and rebuilds from the current DB state.
#[tauri::command]
pub fn kb_watch_start(
    app: AppHandle,
    state: State<'_, AppState>,
    watcher: State<'_, KbWatcher>,
) -> Result<(), String> {
    let dirs = collect_watch_dirs(&state);

    if dirs.is_empty() {
        // Nothing to watch yet; stop any existing watcher and return OK.
        let mut guard = watcher.inner.lock().map_err(|e| e.to_string())?;
        *guard = None;
        return Ok(());
    }

    let app_clone = app.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(800),
        move |res: notify_debouncer_mini::DebounceEventResult| {
            if let Ok(_events) = res {
                // Emit a single coalesced notification regardless of how many
                // file-system events were batched.
                let _ = app_clone.emit(
                    "kb-event",
                    serde_json::json!({ "kind": "changed" }),
                );
            }
        },
    )
    .map_err(|e| format!("failed to create FS watcher: {e}"))?;

    // Watch each directory (non-recursive — parent-dir level is enough for
    // paper files, and the KB root is already at the top of the tree).
    {
        // The watcher is inside the Debouncer; grab it via the accessor.
        // We use a separate block so we can move the debouncer into the Mutex.
        let watcher_ref = debouncer.watcher();
        for dir in &dirs {
            if let Err(e) = watcher_ref.watch(dir, notify_debouncer_mini::notify::RecursiveMode::NonRecursive) {
                // Skip dirs that can't be watched (e.g. permissions, race with deletion).
                eprintln!("[kb_watch] skipping {}: {e}", dir.display());
            }
        }
    }

    let mut guard = watcher.inner.lock().map_err(|e| e.to_string())?;
    // Drop the old debouncer first (stops previous watches).
    *guard = Some(debouncer);

    Ok(())
}

/// Stop the KB file-system watcher.
///
/// Drops the debouncer, which unregisters all OS-level directory watches.
/// Safe to call when already stopped (no-op).
#[tauri::command]
pub fn kb_watch_stop(watcher: State<'_, KbWatcher>) -> Result<(), String> {
    let mut guard = watcher.inner.lock().map_err(|e| e.to_string())?;
    *guard = None; // Drop debouncer → OS watches unregistered.
    Ok(())
}
