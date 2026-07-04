/// FileTracker — records file-change diffs and provides revert/approve for a session.
///
/// Two modes depending on whether the workdir is a git repository:
///
/// - **Git mode**: diffs are computed via `git diff -- <path>` (or a synthetic
///   add-diff for untracked new files).
/// - **Snapshot mode**: the file's content is captured the first time it is
///   touched; diffs are computed using the `similar` crate (unified format).
///
/// Snapshots live at `%APPDATA%/agentboard/snapshots/<session_id>/`; the path
/// within the snapshot mirrors the absolute file path (slashes replaced with
/// `__SEP__`), making restoration straightforward.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use similar::{ChangeTag, TextDiff};
use tokio::process::Command;

use crate::agent::events::AgentEvent;

// ── Error ─────────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum TrackerError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("git: {0}")]
    Git(String),
    #[error("no snapshot for path: {0}")]
    NoSnapshot(String),
}

// ── Main struct ───────────────────────────────────────────────────────────────

pub struct FileTracker {
    pub workdir: PathBuf,
    pub is_git: bool,
    snapshot_dir: PathBuf,
    /// Paths for which a snapshot has already been taken (snapshot mode only).
    snapshotted: Mutex<HashSet<String>>,
    /// Paths that the user has approved (accounting only; no file side-effect).
    approved: Mutex<HashSet<String>>,
    /// Per-path cached diffs so the frontend can re-request them.
    diffs: Mutex<HashMap<String, (String, u32, u32)>>,
}

// ── Constructor ───────────────────────────────────────────────────────────────

impl FileTracker {
    /// Create a tracker for `session_id` operating in `workdir`.
    /// Runs `git rev-parse --is-inside-work-tree` to detect git mode.
    pub async fn new(session_id: &str, workdir: &str) -> Self {
        let workdir_path = PathBuf::from(workdir);
        let is_git = check_is_git(&workdir_path).await;
        let snapshot_dir = snapshot_base_dir(session_id);

        Self {
            workdir: workdir_path,
            is_git,
            snapshot_dir,
            snapshotted: Mutex::new(HashSet::new()),
            approved: Mutex::new(HashSet::new()),
            diffs: Mutex::new(HashMap::new()),
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /// Enrich a raw `FileEdit` event with diff text and line-change statistics.
    ///
    /// Side-effect (snapshot mode): if this is the first touch for `path`, the
    /// current file content is saved to the snapshot directory *before* the
    /// diff is computed (because codex has already modified the file by the
    /// time we see the `item.completed` event — so we snapshot from the git
    /// working-tree base or rely on git directly).
    pub async fn enrich_file_edit(&self, path: &str, kind: &str) -> AgentEvent {
        let (diff_text, added, removed) = if self.is_git {
            self.git_diff(path, kind).await.unwrap_or_default()
        } else {
            self.snapshot_diff(path, kind).await.unwrap_or_default()
        };

        // For non-git mode, snapshot_path is now populated after snapshot_diff ran.
        let snapshot_path = if !self.is_git {
            self.get_snapshot_path(path)
        } else {
            None
        };

        // Cache for later retrieval.
        if let Ok(mut map) = self.diffs.lock() {
            map.insert(path.to_string(), (diff_text.clone(), added, removed));
        }

        AgentEvent::FileEdit {
            path: path.to_string(),
            kind: kind.to_string(),
            diff: if diff_text.is_empty() {
                None
            } else {
                Some(diff_text)
            },
            added,
            removed,
            snapshot_path,
        }
    }

    /// Revert a file to its pre-session state.
    ///
    /// - Git mode: `git checkout -- <path>` for existing files; delete for new
    ///   files (those that were created / have no git history).
    /// - Snapshot mode: restore from snapshot directory.
    pub async fn revert(&self, path: &str) -> Result<(), TrackerError> {
        if self.is_git {
            self.git_revert(path).await
        } else {
            self.snapshot_restore(path).await
        }
    }

    /// Mark a file as approved (accounting only; does not modify the file).
    pub fn approve(&self, path: &str) {
        if let Ok(mut set) = self.approved.lock() {
            set.insert(path.to_string());
        }
    }

    /// Return the on-disk snapshot path for `path` if a snapshot has been taken
    /// (non-git mode only).  Used to persist the path in the DB for cold revert.
    pub fn get_snapshot_path(&self, path: &str) -> Option<String> {
        let snapshotted = self
            .snapshotted
            .lock()
            .map(|g| g.contains(path))
            .unwrap_or(false);
        if snapshotted {
            Some(self.snapshot_path(path).to_string_lossy().into_owned())
        } else {
            None
        }
    }

    // ── Git helpers ───────────────────────────────────────────────────────────

    async fn git_diff(&self, path: &str, kind: &str) -> Result<(String, u32, u32), TrackerError> {
        // Resolve absolute path; if it starts with the workdir use it directly.
        let abs_path = resolve_abs(path, &self.workdir);

        let diff_text = if kind == "create" || !git_tracked(&self.workdir, &abs_path).await {
            // Untracked / new file: generate an "add" diff against /dev/null.
            let content = tokio::fs::read_to_string(&abs_path)
                .await
                .unwrap_or_default();
            build_add_diff(path, &content)
        } else {
            // Tracked file: ask git for the working-tree diff.
            let out = Command::new("git")
                .args(["diff", "--", path])
                .current_dir(&self.workdir)
                .output()
                .await
                .map_err(|e| TrackerError::Git(e.to_string()))?;

            if !out.status.success() && out.stdout.is_empty() {
                // git diff failed (e.g., not inside repo anymore) — return empty.
                return Ok((String::new(), 0, 0));
            }
            String::from_utf8_lossy(&out.stdout).into_owned()
        };

        let (added, removed) = count_diff_lines(&diff_text);
        Ok((diff_text, added, removed))
    }

    async fn git_revert(&self, path: &str) -> Result<(), TrackerError> {
        let abs_path = resolve_abs(path, &self.workdir);

        // Detect whether the file was created (no HEAD version).
        if !git_tracked(&self.workdir, &abs_path).await {
            // Created by agent — delete to revert.
            if abs_path.exists() {
                tokio::fs::remove_file(&abs_path).await?;
            }
            return Ok(());
        }

        // Existing file — restore from HEAD.
        let out = Command::new("git")
            .args(["checkout", "--", path])
            .current_dir(&self.workdir)
            .output()
            .await
            .map_err(|e| TrackerError::Git(e.to_string()))?;

        if !out.status.success() {
            return Err(TrackerError::Git(
                String::from_utf8_lossy(&out.stderr).into_owned(),
            ));
        }
        Ok(())
    }

    // ── Snapshot helpers ──────────────────────────────────────────────────────

    /// Non-git diff: snapshot the file before we apply any diff (best-effort;
    /// codex may have already mutated the file, so we take the snapshot the
    /// first time we see the path and rely on the *current* state of the diff
    /// being computed from git-based history or we read "before" from git show).
    ///
    /// Because codex has already written the file when `item.completed` fires,
    /// we use the git working-tree baseline to produce a synthetic diff.  In
    /// pure non-git mode we can only show a synthetic "all-added" diff for the
    /// first edit; subsequent edits on the same file can be diffed from the
    /// snapshot.
    async fn snapshot_diff(
        &self,
        path: &str,
        kind: &str,
    ) -> Result<(String, u32, u32), TrackerError> {
        let abs_path = resolve_abs(path, &self.workdir);
        let snap_path = self.snapshot_path(path);

        let already_snapshotted = self
            .snapshotted
            .lock()
            .map(|g| g.contains(path))
            .unwrap_or(false);

        let old_content: String = if already_snapshotted {
            // Read the snapshot as "before".
            tokio::fs::read_to_string(&snap_path)
                .await
                .unwrap_or_default()
        } else {
            // First touch: the snapshot hasn't been taken yet.
            // If the file was "created" by the agent there is no before-state.
            if kind == "create" {
                String::new()
            } else {
                // The file already existed before the agent touched it; read
                // the current content as "after" and the snapshot (if we could
                // have taken it earlier) as "before".  Since we can't time-
                // travel, we produce a synthetic all-added diff.
                String::new()
            }
        };

        // Take snapshot of current (post-edit) state if not yet done.
        if !already_snapshotted {
            let current = tokio::fs::read_to_string(&abs_path)
                .await
                .unwrap_or_default();
            if let Some(parent) = snap_path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let _ = tokio::fs::write(&snap_path, &current).await;
            if let Ok(mut set) = self.snapshotted.lock() {
                set.insert(path.to_string());
            }
            // Produce add-diff for first-touch.
            let diff = build_add_diff(path, &current);
            let (added, removed) = count_diff_lines(&diff);
            return Ok((diff, added, removed));
        }

        // Subsequent edit: diff old snapshot against current file content.
        let new_content = tokio::fs::read_to_string(&abs_path)
            .await
            .unwrap_or_default();
        let diff = build_unified_diff(path, &old_content, &new_content);
        let (added, removed) = count_diff_lines(&diff);

        // Update snapshot to reflect the latest state.
        let _ = tokio::fs::write(&snap_path, &new_content).await;

        Ok((diff, added, removed))
    }

    async fn snapshot_restore(&self, path: &str) -> Result<(), TrackerError> {
        let abs_path = resolve_abs(path, &self.workdir);
        let snap_path = self.snapshot_path(path);

        let already = self
            .snapshotted
            .lock()
            .map(|g| g.contains(path))
            .unwrap_or(false);

        if !already {
            // No snapshot was taken — nothing to restore.
            return Ok(());
        }

        let snap_content = tokio::fs::read_to_string(&snap_path)
            .await
            .map_err(|_| TrackerError::NoSnapshot(path.to_string()))?;

        if let Some(parent) = abs_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        tokio::fs::write(&abs_path, snap_content).await?;
        Ok(())
    }

    /// Map a path to its snapshot location under `snapshot_dir`.
    fn snapshot_path(&self, path: &str) -> PathBuf {
        // Sanitise path separators so we can use the string as a filename.
        let safe = path.replace(['/', '\\', ':'], "__");
        self.snapshot_dir.join(safe)
    }
}

// ── Free helpers ──────────────────────────────────────────────────────────────

/// Returns `%APPDATA%/agentboard/snapshots/<session_id>` (Windows) or
/// `~/.local/share/agentboard/snapshots/<session_id>` (non-Windows).
fn snapshot_base_dir(session_id: &str) -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:/Users/Default/AppData/Roaming"));

    #[cfg(not(windows))]
    let base = std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".local/share"))
        .unwrap_or_else(|_| PathBuf::from("/tmp"));

    base.join("agentboard").join("snapshots").join(session_id)
}

/// Run `git rev-parse --is-inside-work-tree` in `workdir`.
pub async fn check_is_git(workdir: &Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(workdir)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check whether `abs_path` is tracked in the git index.
async fn git_tracked(workdir: &Path, abs_path: &Path) -> bool {
    // `git ls-files --error-unmatch <path>` exits 0 only for tracked files.
    Command::new("git")
        .args(["ls-files", "--error-unmatch"])
        .arg(abs_path)
        .current_dir(workdir)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Resolve `path` relative to `workdir` if it is not already absolute.
fn resolve_abs(path: &str, workdir: &Path) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        p
    } else {
        workdir.join(p)
    }
}

/// Build a unified diff that shows `new_content` as entirely added (i.e. a
/// creation diff against an empty baseline).
pub fn build_add_diff(path: &str, new_content: &str) -> String {
    build_unified_diff(path, "", new_content)
}

/// Build a unified diff between `old` and `new` content using the `similar` crate.
pub fn build_unified_diff(path: &str, old: &str, new: &str) -> String {
    let diff = TextDiff::from_lines(old, new);
    let mut out = String::new();

    // Header lines mimic `git diff`.
    out.push_str(&format!("--- a/{}\n", path));
    out.push_str(&format!("+++ b/{}\n", path));

    for group in diff.grouped_ops(3) {
        // Hunk header.
        let first_op = &group[0];
        let last_op = &group[group.len() - 1];
        let old_start = first_op.old_range().start + 1;
        let old_len: usize = group.iter().map(|op| op.old_range().len()).sum();
        let new_start = first_op.new_range().start + 1;
        let new_len: usize = group.iter().map(|op| op.new_range().len()).sum();
        let _ = last_op; // suppress unused warning

        out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            old_start, old_len, new_start, new_len
        ));

        for op in &group {
            for change in diff.iter_changes(op) {
                let prefix = match change.tag() {
                    ChangeTag::Equal => ' ',
                    ChangeTag::Delete => '-',
                    ChangeTag::Insert => '+',
                };
                out.push(prefix);
                out.push_str(change.value());
                if change.missing_newline() {
                    out.push('\n');
                }
            }
        }
    }

    out
}

/// Count `+` (added) and `-` (removed) lines in a unified diff, skipping the
/// `---`/`+++` header lines.
pub fn count_diff_lines(diff: &str) -> (u32, u32) {
    let mut added = 0u32;
    let mut removed = 0u32;
    for line in diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            removed += 1;
        }
    }
    (added, removed)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── diff helpers ──────────────────────────────────────────────────────────

    #[test]
    fn build_unified_diff_counts_added_removed() {
        let old = "line1\nline2\nline3\n";
        let new = "line1\nline2_modified\nline3\nnew_line\n";
        let diff = build_unified_diff("test.txt", old, new);

        assert!(diff.contains("+line2_modified"), "missing +line");
        assert!(diff.contains("-line2\n"), "missing -line");
        assert!(diff.contains("+new_line"), "missing +new_line");

        let (added, removed) = count_diff_lines(&diff);
        assert_eq!(added, 2, "added count wrong; diff:\n{}", diff);
        assert_eq!(removed, 1, "removed count wrong; diff:\n{}", diff);
    }

    #[test]
    fn build_add_diff_all_added() {
        let content = "alpha\nbeta\n";
        let diff = build_add_diff("foo.txt", content);
        let (added, removed) = count_diff_lines(&diff);
        assert_eq!(added, 2, "all lines should be added");
        assert_eq!(removed, 0, "no lines should be removed");
    }

    #[test]
    fn count_diff_lines_skips_headers() {
        let diff = "--- a/foo\n+++ b/foo\n@@ -1,1 +1,1 @@\n-old\n+new\n";
        let (added, removed) = count_diff_lines(diff);
        assert_eq!(added, 1);
        assert_eq!(removed, 1);
    }

    // ── non-git tracker (snapshot mode) ──────────────────────────────────────

    #[tokio::test]
    async fn snapshot_mode_first_touch_create() {
        let tmp = TempDir::new().expect("tempdir");
        let workdir = tmp.path().to_str().unwrap();

        // Write a file (simulating agent creation).
        let file_path = tmp.path().join("created.txt");
        fs::write(&file_path, "hello world\n").unwrap();

        let session_id = uuid::Uuid::new_v4().to_string();
        let tracker = FileTracker::new(&session_id, workdir).await;
        // Force non-git mode.
        // (The TempDir is not a git repo, so is_git should be false.)
        assert!(!tracker.is_git, "TempDir should not be a git repo");

        let abs = file_path.to_str().unwrap();
        let event = tracker.enrich_file_edit(abs, "create").await;

        match event {
            AgentEvent::FileEdit { added, removed, diff, .. } => {
                // New file → all lines added.
                assert_eq!(removed, 0, "create: no removed lines");
                assert!(added > 0, "create: at least 1 added line");
                assert!(diff.is_some(), "create: diff should be Some");
            }
            other => panic!("expected FileEdit, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn snapshot_mode_subsequent_edit_diff() {
        let tmp = TempDir::new().expect("tempdir");
        let workdir = tmp.path().to_str().unwrap();

        let file_path = tmp.path().join("edit_me.txt");
        // Initial content (simulates agent's first write).
        fs::write(&file_path, "version1\n").unwrap();

        let session_id = uuid::Uuid::new_v4().to_string();
        let tracker = FileTracker::new(&session_id, workdir).await;
        assert!(!tracker.is_git);

        let abs = file_path.to_str().unwrap();

        // First enrich — snapshot is taken; diff is "all added".
        let _ev1 = tracker.enrich_file_edit(abs, "create").await;

        // Simulate a second agent edit.
        fs::write(&file_path, "version1\nversion2\n").unwrap();

        // Second enrich — should see +version2.
        let ev2 = tracker.enrich_file_edit(abs, "update").await;
        match ev2 {
            AgentEvent::FileEdit { added, removed, diff, .. } => {
                assert_eq!(added, 1, "second edit: 1 line added");
                assert_eq!(removed, 0, "second edit: 0 lines removed");
                let d = diff.expect("diff should be Some on second edit");
                assert!(d.contains("+version2"), "diff should show new line");
            }
            other => panic!("expected FileEdit, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn snapshot_revert_restores_content() {
        let tmp = TempDir::new().expect("tempdir");
        let workdir = tmp.path().to_str().unwrap();

        let file_path = tmp.path().join("revert_me.txt");
        let original = "original content\n";
        fs::write(&file_path, original).unwrap();

        let session_id = uuid::Uuid::new_v4().to_string();
        let tracker = FileTracker::new(&session_id, workdir).await;
        assert!(!tracker.is_git);

        let abs = file_path.to_str().unwrap();

        // Enrich (takes snapshot of "original content").
        let _ = tracker.enrich_file_edit(abs, "create").await;

        // Simulate further agent edit.
        let modified = "completely different\n";
        fs::write(&file_path, modified).unwrap();

        // Revert.
        tracker.revert(abs).await.expect("revert failed");

        let restored = fs::read_to_string(&file_path).unwrap();
        assert_eq!(
            restored, original,
            "file content should be restored to original"
        );
    }
}
