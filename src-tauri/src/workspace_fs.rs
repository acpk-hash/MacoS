//! Workspace filesystem backend (G2a).
//!
//! Provides a Trae/Cursor-style "open a folder → file tree + editor" backend:
//! a single active **workspace root** plus safe, root-confined filesystem
//! commands (list / read / write / create / rename / delete / search).
//!
//! ## Security model
//! Every command takes a `rel_path` relative to the workspace root. The root is
//! canonicalized once at `ws_open_folder` time. Each `rel_path` is:
//! 1. Lexically normalized — absolute paths, drive prefixes, and any `..`
//!    component are rejected outright (no directory traversal).
//! 2. Symlink-escape checked — the deepest existing ancestor of the target is
//!    canonicalized and must stay within the canonical root, so a symlink that
//!    points outside the workspace cannot be used to escape.
//!
//! Binary and large (>1 MB) files are never read into memory in full; the
//! frontend receives `too_large = true` and shows a placeholder instead.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::AppState;
use crate::db::Db;

/// Files larger than this are never read/grepped in full.
const MAX_FILE_BYTES: u64 = 1024 * 1024; // 1 MB

/// Upper bound for binary preview reads (`ws_read_bytes`) — PDF / images for
/// the editor preview pane. Kept well below anything that could OOM the
/// webview once base64-inflated (~4/3×).
const MAX_PREVIEW_BYTES: u64 = 50 * 1024 * 1024; // 50 MB

/// Directories skipped during recursive search (still listed by `ws_list_dir`).
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
];

/// Settings key holding the recent-folders JSON array (most recent first).
const RECENT_KEY: &str = "ws_recent_folders";
const RECENT_MAX: usize = 12;

// ── State ───────────────────────────────────────────────────────────────────

/// Holds the single active workspace root (canonicalized).
pub struct WorkspaceState {
    root: Mutex<Option<PathBuf>>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceState {
    pub fn new() -> Self {
        Self {
            root: Mutex::new(None),
        }
    }

    fn set_root(&self, p: PathBuf) {
        *self.root.lock().unwrap() = Some(p);
    }

    /// The current canonical root, or a clear error if no folder is open.
    fn root(&self) -> Result<PathBuf, String> {
        self.root
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "未打开工作目录，请先选择文件夹".to_string())
    }
}

// ── Serialized results ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct WsOpenResult {
    /// Canonical root path (verbatim `\\?\` prefix stripped), forward slashes.
    pub root: String,
    /// Final directory name (display label for the tree header).
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsEntry {
    pub name: String,
    /// Path relative to the workspace root, forward slashes.
    pub rel_path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Lowercased extension without the dot (empty for dirs / no extension).
    pub ext: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsFileContent {
    /// UTF-8 text, or empty when `too_large` is true.
    pub content: String,
    /// `"utf-8"`, `"binary"`, or `"too_large"`.
    pub encoding: String,
    pub too_large: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsFileBytes {
    /// Raw file bytes, base64-encoded (standard alphabet, padded).
    pub base64: String,
    /// Original byte length on disk.
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsSearchHit {
    pub rel_path: String,
    /// 1-based line number for a content match; `None` for a filename match.
    pub line: Option<u64>,
    /// Trimmed line preview for a content match; `None` for a filename match.
    pub preview: Option<String>,
}

// ── Path safety ─────────────────────────────────────────────────────────────

/// Lexically normalize a caller-supplied `rel_path`, rejecting anything that
/// could escape the root: absolute paths, drive/root prefixes, and `..`.
fn normalize_rel(rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel.trim());
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir => return Err("路径包含非法的 .. 穿越".to_string()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("路径必须是相对工作根的相对路径".to_string());
            }
        }
    }
    Ok(out)
}

/// Return the deepest ancestor of `p` (including `p`) that exists on disk.
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

/// Resolve `rel` to an absolute path inside `root`, rejecting traversal and
/// symlink-escape. `root` must already be canonical.
fn resolve_within(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = normalize_rel(rel)?;
    let target = root.join(&rel);

    // Symlink-escape guard: canonicalize the deepest existing ancestor and
    // verify it stays within the canonical root. (A non-existent leaf — e.g.
    // for create/write — has its existing parent checked instead.)
    let anchor = deepest_existing(&target);
    if let Ok(canon) = anchor.canonicalize() {
        if !canon.starts_with(root) {
            return Err("路径超出工作根范围".to_string());
        }
    }
    Ok(target)
}

/// Compute a root-relative, forward-slash path string for `abs`.
fn rel_of(root: &Path, abs: &Path) -> String {
    let rel = abs.strip_prefix(root).unwrap_or(abs);
    rel.to_string_lossy().replace('\\', "/")
}

/// Strip the Windows verbatim `\\?\` prefix and use forward slashes for display.
fn clean_display(p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = s
        .strip_prefix(r"\\?\UNC\")
        .map(|r| format!(r"\\{r}"))
        .unwrap_or_else(|| s.strip_prefix(r"\\?\").unwrap_or(&s).to_string());
    s.replace('\\', "/")
}

// ── Core operations (pure; unit-tested directly) ────────────────────────────

fn list_dir(root: &Path, rel: &str) -> Result<Vec<WsEntry>, String> {
    let dir = resolve_within(root, rel)?;
    if !dir.is_dir() {
        return Err(format!("不是目录: {rel}"));
    }
    let mut entries = Vec::new();
    let rd = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let ext = if is_dir {
            String::new()
        } else {
            path.extension()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        };
        entries.push(WsEntry {
            name,
            rel_path: rel_of(root, &path),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            ext,
        });
    }
    // Directories first, then case-insensitive name order.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

fn read_file(root: &Path, rel: &str) -> Result<WsFileContent, String> {
    let path = resolve_within(root, rel)?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err(format!("这是目录，不是文件: {rel}"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Ok(WsFileContent {
            content: String::new(),
            encoding: "too_large".to_string(),
            too_large: true,
        });
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    // NUL byte or invalid UTF-8 → treat as binary; do not return content.
    if bytes.contains(&0) {
        return Ok(WsFileContent {
            content: String::new(),
            encoding: "binary".to_string(),
            too_large: true,
        });
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(WsFileContent {
            content: text,
            encoding: "utf-8".to_string(),
            too_large: false,
        }),
        Err(_) => Ok(WsFileContent {
            content: String::new(),
            encoding: "binary".to_string(),
            too_large: true,
        }),
    }
}

/// Read a file as raw bytes (base64) for binary previews (PDF / images).
/// `cap` bounds the on-disk size; oversize files are refused with a clear
/// message instead of being truncated (a truncated PDF is useless).
fn read_bytes_capped(root: &Path, rel: &str, cap: u64) -> Result<WsFileBytes, String> {
    let path = resolve_within(root, rel)?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err(format!("这是目录，不是文件: {rel}"));
    }
    if meta.len() > cap {
        return Err(format!(
            "文件过大（{:.1} MB，上限 {} MB），无法预览",
            meta.len() as f64 / (1024.0 * 1024.0),
            cap / (1024 * 1024)
        ));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    use base64::Engine as _;
    Ok(WsFileBytes {
        size: bytes.len() as u64,
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

fn write_file(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let path = resolve_within(root, rel)?;
    if path.is_dir() {
        return Err(format!("目标是目录，无法写入: {rel}"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // `fs::write` emits raw bytes — UTF-8, never a BOM.
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

fn create(root: &Path, rel: &str, is_dir: bool) -> Result<(), String> {
    let path = resolve_within(root, rel)?;
    if path.exists() {
        return Err(format!("已存在: {rel}"));
    }
    if is_dir {
        fs::create_dir_all(&path).map_err(|e| e.to_string())
    } else {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&path, b"").map_err(|e| e.to_string())
    }
}

fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let from_p = resolve_within(root, from)?;
    let to_p = resolve_within(root, to)?;
    if !from_p.exists() {
        return Err(format!("源不存在: {from}"));
    }
    if to_p.exists() {
        return Err(format!("目标已存在: {to}"));
    }
    if let Some(parent) = to_p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&from_p, &to_p).map_err(|e| e.to_string())
}

fn delete(root: &Path, rel: &str) -> Result<(), String> {
    let path = resolve_within(root, rel)?;
    // Guard against deleting the root itself.
    if path == root {
        return Err("不能删除工作根目录".to_string());
    }
    let meta = fs::symlink_metadata(&path).map_err(|_| format!("不存在: {rel}"))?;
    if meta.is_dir() {
        // Refuse to recursively delete a non-empty directory (safety).
        let empty = fs::read_dir(&path)
            .map_err(|e| e.to_string())?
            .next()
            .is_none();
        if !empty {
            return Err(format!(
                "目录非空，拒绝递归删除: {rel}（请先清空或逐项删除）"
            ));
        }
        fs::remove_dir(&path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

fn search(root: &Path, query: &str, max: usize) -> Result<Vec<WsSearchHit>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let max = if max == 0 { 200 } else { max };
    let q_lower = query.to_lowercase();
    let mut hits: Vec<WsSearchHit> = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if hits.len() >= max {
            break;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let mut children: Vec<_> = rd.flatten().collect();
        children.sort_by_key(|e| e.file_name());
        for e in children {
            if hits.len() >= max {
                break;
            }
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let ft = match e.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                // Skip heavy/vendored dirs; skip symlinked dirs (not is_dir).
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
                continue;
            }
            if !ft.is_file() {
                continue; // skip symlinks / special files
            }
            let rel = rel_of(root, &path);
            // Filename match.
            if name.to_lowercase().contains(&q_lower) {
                hits.push(WsSearchHit {
                    rel_path: rel.clone(),
                    line: None,
                    preview: None,
                });
                if hits.len() >= max {
                    break;
                }
            }
            // Content grep (small text files only).
            let small = e.metadata().map(|m| m.len() <= MAX_FILE_BYTES).unwrap_or(false);
            if small {
                if let Ok(text) = fs::read_to_string(&path) {
                    for (i, l) in text.lines().enumerate() {
                        if l.to_lowercase().contains(&q_lower) {
                            let preview: String = l.trim().chars().take(200).collect();
                            hits.push(WsSearchHit {
                                rel_path: rel.clone(),
                                line: Some((i as u64) + 1),
                                preview: Some(preview),
                            });
                            if hits.len() >= max {
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(hits)
}

// ── Recent folders (persisted in settings) ──────────────────────────────────

fn recent_get(db: &Db) -> Vec<String> {
    db.settings_get(RECENT_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn recent_push(db: &Db, path: &str) {
    let mut list = recent_get(db);
    list.retain(|p| p != path);
    list.insert(0, path.to_string());
    list.truncate(RECENT_MAX);
    if let Ok(json) = serde_json::to_string(&list) {
        let _ = db.settings_set(RECENT_KEY, &json);
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Open (set) the active workspace root. Canonicalizes the path, records it in
/// the recent-folders list, and returns the cleaned root + display name.
#[tauri::command]
pub(crate) async fn ws_open_folder(
    path: String,
    state: State<'_, AppState>,
) -> Result<WsOpenResult, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_dir() {
        return Err(format!("目录不存在: {}", p.display()));
    }
    let canon = p.canonicalize().map_err(|e| e.to_string())?;
    if !canon.is_dir() {
        return Err("所选路径不是目录".to_string());
    }
    let display = clean_display(&canon);
    let name = canon
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| display.clone());

    state.ws.set_root(canon);
    recent_push(&state.db, &display);

    Ok(WsOpenResult {
        root: display,
        name,
    })
}

/// List a single directory level (for lazy file-tree expansion).
#[tauri::command]
pub(crate) async fn ws_list_dir(
    rel_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<WsEntry>, String> {
    let root = state.ws.root()?;
    list_dir(&root, &rel_path)
}

/// Read a text file for the editor (binary / >1 MB → `too_large`, no content).
#[tauri::command]
pub(crate) async fn ws_read_file(
    rel_path: String,
    state: State<'_, AppState>,
) -> Result<WsFileContent, String> {
    let root = state.ws.root()?;
    read_file(&root, &rel_path)
}

/// Read a file as base64 bytes for binary previews (PDF / images, ≤ 50 MB).
#[tauri::command]
pub(crate) async fn ws_read_bytes(
    rel_path: String,
    state: State<'_, AppState>,
) -> Result<WsFileBytes, String> {
    let root = state.ws.root()?;
    read_bytes_capped(&root, &rel_path, MAX_PREVIEW_BYTES)
}

/// Open a file with the system default application (explorer/xdg-open).
#[tauri::command]
pub(crate) async fn ws_open_system(
    rel_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.ws.root()?;
    let path = resolve_within(&root, &rel_path)?;
    if !path.is_file() {
        return Err(format!("文件不存在: {}", path.display()));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &path.to_string_lossy()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Write a text file back (UTF-8, no BOM).
#[tauri::command]
pub(crate) async fn ws_write_file(
    rel_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.ws.root()?;
    write_file(&root, &rel_path, &content)
}

/// Create a new file or directory.
#[tauri::command]
pub(crate) async fn ws_create(
    rel_path: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.ws.root()?;
    create(&root, &rel_path, is_dir)
}

/// Rename / move a file or directory within the workspace.
#[tauri::command]
pub(crate) async fn ws_rename(
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.ws.root()?;
    rename(&root, &from, &to)
}

/// Delete a file, or an empty directory (non-empty dirs are refused).
#[tauri::command]
pub(crate) async fn ws_delete(rel_path: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = state.ws.root()?;
    delete(&root, &rel_path)
}

/// Filename + content search within the workspace (skips vendored dirs).
#[tauri::command]
pub(crate) async fn ws_search(
    query: String,
    max: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<WsSearchHit>, String> {
    let root = state.ws.root()?;
    search(&root, &query, max.unwrap_or(200))
}

/// Return the recently opened folder paths (most recent first).
#[tauri::command]
pub(crate) async fn ws_recent_folders(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(recent_get(&state.db))
}

// ── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Canonicalize a TempDir path so `resolve_within` prefix checks line up
    /// (macOS/Windows temp dirs are often symlinked/verbatim).
    fn canon_root(tmp: &TempDir) -> PathBuf {
        tmp.path().canonicalize().unwrap()
    }

    #[test]
    fn traversal_and_absolute_paths_rejected() {
        let tmp = TempDir::new().unwrap();
        let root = canon_root(&tmp);

        assert!(resolve_within(&root, "../evil").is_err());
        assert!(resolve_within(&root, "a/../../b").is_err());
        assert!(resolve_within(&root, "sub/../../../etc/passwd").is_err());
        // Absolute paths / drive prefixes are rejected.
        #[cfg(windows)]
        assert!(resolve_within(&root, r"C:\Windows\system32").is_err());
        #[cfg(not(windows))]
        assert!(resolve_within(&root, "/etc/passwd").is_err());

        // A legit nested relative path resolves inside the root.
        let ok = resolve_within(&root, "a/b/c.txt").unwrap();
        assert!(ok.starts_with(&root));
    }

    #[test]
    fn list_dir_sorts_dirs_first_then_name() {
        let tmp = TempDir::new().unwrap();
        let root = canon_root(&tmp);
        fs::create_dir(root.join("zeta_dir")).unwrap();
        fs::create_dir(root.join("Alpha_dir")).unwrap();
        fs::write(root.join("banana.txt"), "b").unwrap();
        fs::write(root.join("apple.rs"), "a").unwrap();

        let entries = list_dir(&root, "").unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Dirs first (case-insensitive sorted), then files.
        assert_eq!(names, vec!["Alpha_dir", "zeta_dir", "apple.rs", "banana.txt"]);

        let apple = entries.iter().find(|e| e.name == "apple.rs").unwrap();
        assert!(!apple.is_dir);
        assert_eq!(apple.ext, "rs");
        assert_eq!(apple.rel_path, "apple.rs");
    }

    #[test]
    fn write_read_roundtrip_no_bom() {
        let tmp = TempDir::new().unwrap();
        let root = canon_root(&tmp);
        let body = "héllo, 世界\nsecond line\n";

        write_file(&root, "docs/note.md", body).unwrap();
        let got = read_file(&root, "docs/note.md").unwrap();
        assert!(!got.too_large);
        assert_eq!(got.encoding, "utf-8");
        assert_eq!(got.content, body);

        // Verify the on-disk bytes carry no UTF-8 BOM.
        let raw = fs::read(root.join("docs").join("note.md")).unwrap();
        assert_ne!(&raw[0..3.min(raw.len())], b"\xEF\xBB\xBF");
    }

    #[test]
    fn large_and_binary_files_flagged_too_large() {
        let tmp = TempDir::new().unwrap();
        let root = canon_root(&tmp);

        // >1 MB text file.
        let big = "x".repeat((MAX_FILE_BYTES as usize) + 10);
        fs::write(root.join("big.txt"), &big).unwrap();
        let r = read_file(&root, "big.txt").unwrap();
        assert!(r.too_large);
        assert_eq!(r.encoding, "too_large");
        assert!(r.content.is_empty());

        // Binary file (embedded NUL byte).
        fs::write(root.join("blob.bin"), [0x00u8, 0x01, 0x02, 0x00]).unwrap();
        let b = read_file(&root, "blob.bin").unwrap();
        assert!(b.too_large);
        assert_eq!(b.encoding, "binary");
        assert!(b.content.is_empty());
    }

    #[test]
    fn search_matches_filename_and_content() {
        let tmp = TempDir::new().unwrap();
        let root = canon_root(&tmp);
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules").join("needle_in_haystack.js"), "needle").unwrap();
        fs::write(root.join("keep.rs"), "let x = 1;\nlet needle = 2;\n").unwrap();
        fs::write(root.join("needle_name.txt"), "unrelated body\n").unwrap();

        let hits = search(&root, "needle", 100).unwrap();
        // node_modules must be skipped entirely.
        assert!(hits.iter().all(|h| !h.rel_path.contains("node_modules")));
        // Filename match on needle_name.txt (line = None).
        assert!(hits
            .iter()
            .any(|h| h.rel_path == "needle_name.txt" && h.line.is_none()));
        // Content match inside keep.rs at line 2.
        assert!(hits
            .iter()
            .any(|h| h.rel_path == "keep.rs" && h.line == Some(2)));
    }

    #[test]
    fn read_bytes_roundtrip_and_cap() {
        let tmp = TempDir::new().unwrap();
        let root = canon_root(&tmp);
        // Binary payload with NUL bytes + a fake PDF header.
        let payload: Vec<u8> = b"%PDF-1.7\x00\x01\xff\xfe binary".to_vec();
        fs::write(root.join("doc.pdf"), &payload).unwrap();

        let got = read_bytes_capped(&root, "doc.pdf", 1024).unwrap();
        assert_eq!(got.size, payload.len() as u64);
        use base64::Engine as _;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(got.base64.as_bytes())
            .unwrap();
        assert_eq!(decoded, payload);

        // Over the cap → clear refusal, no truncation.
        let err = read_bytes_capped(&root, "doc.pdf", 4).unwrap_err();
        assert!(err.contains("文件过大"));
        // Directories are refused.
        fs::create_dir(root.join("sub")).unwrap();
        assert!(read_bytes_capped(&root, "sub", 1024).is_err());
        // Traversal is still rejected on the bytes path.
        assert!(read_bytes_capped(&root, "../evil.pdf", 1024).is_err());
    }

    #[test]
    fn create_rename_delete_lifecycle() {
        let tmp = TempDir::new().unwrap();
        let root = canon_root(&tmp);

        create(&root, "sub", true).unwrap();
        assert!(root.join("sub").is_dir());
        create(&root, "sub/a.txt", false).unwrap();
        assert!(root.join("sub").join("a.txt").is_file());
        // Creating an existing path errors.
        assert!(create(&root, "sub/a.txt", false).is_err());

        rename(&root, "sub/a.txt", "sub/b.txt").unwrap();
        assert!(!root.join("sub").join("a.txt").exists());
        assert!(root.join("sub").join("b.txt").is_file());

        // Non-empty dir refuses deletion.
        assert!(delete(&root, "sub").is_err());
        delete(&root, "sub/b.txt").unwrap();
        delete(&root, "sub").unwrap();
        assert!(!root.join("sub").exists());
    }

    #[test]
    fn root_not_set_errors() {
        let ws = WorkspaceState::new();
        assert!(ws.root().is_err());
    }
}
