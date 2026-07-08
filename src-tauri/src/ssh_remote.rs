//! SSH remote browsing / editing / command execution (G2c).
//!
//! Uses the pure-Rust `russh` + `russh-sftp` stack so there is **no** OpenSSL /
//! libssh2 system dependency on Windows. The frontend reuses the same file-tree
//! and editor by talking to `ssh_*` commands whose signatures mirror the local
//! `ws_*` ones (a `conn_id` + `rel_path` instead of just `rel_path`).
//!
//! ## Scope / boundary
//! This lets you connect over SSH, browse the remote tree (SFTP), edit remote
//! files, and run remote commands. It does **not** run an AI agent on the
//! remote host — that would require installing `pi` remotely and is out of
//! scope for this milestone.
//!
//! ## Credential handling
//! The password / passphrase / private key are consumed once inside
//! `ssh_connect` and are **never** stored in state, persisted, or logged. Only
//! the live session handle (plus host/port/user/root metadata) is kept in
//! memory for the lifetime of the connection. "Remember host" (frontend) stores
//! only non-secret fields (host/port/user/auth-kind/key-path) in settings.
//!
//! ## Host key verification
//! `check_server_key` currently accepts any server key (trust-on-first-use is
//! not yet implemented). This is a known limitation for a desktop developer
//! tool; a future version can pin/verify fingerprints.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::keys::key;
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;

use crate::workspace_fs::{WsEntry, WsFileContent};
use crate::AppState;

/// Files larger than this are never read into memory in full.
const MAX_FILE_BYTES: u64 = 1024 * 1024; // 1 MB
/// Timeout for the TCP connect + auth handshake.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Timeout for a single remote command.
const EXEC_TIMEOUT: Duration = Duration::from_secs(120);
/// Cap on captured stdout/stderr per command (avoid unbounded memory).
const EXEC_MAX_BYTES: usize = 256 * 1024;

// ── Auth input (from the frontend) ──────────────────────────────────────────

/// Authentication material for a connection. Deserialized from the frontend as
/// `{ kind: "password", password }` or `{ kind: "key", keyPath, passphrase? }`.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SshAuth {
    Password {
        password: String,
    },
    Key {
        // `rename_all` renames variant names, not their fields, so rename the
        // one camelCase field explicitly to match the JS payload (`keyPath`).
        #[serde(rename = "keyPath")]
        key_path: String,
        passphrase: Option<String>,
    },
}

// ── Serialized results ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SshConnInfo {
    pub conn_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Absolute remote root the tree browses from (canonicalized home or "/").
    pub root: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SshExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit: i32,
}

// ── russh client handler ────────────────────────────────────────────────────

struct ClientHandler;

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Trust-on-first-use is not implemented yet (see module docs).
        Ok(true)
    }
}

// ── Connection + state ──────────────────────────────────────────────────────

/// A live SSH connection: the russh session handle plus a ready SFTP session.
struct Conn {
    host: String,
    port: u16,
    user: String,
    root: String,
    handle: client::Handle<ClientHandler>,
    sftp: SftpSession,
}

/// Holds all open SSH connections keyed by an opaque connection id.
pub struct SshState {
    conns: Mutex<HashMap<String, Arc<Conn>>>,
    counter: AtomicU64,
}

impl Default for SshState {
    fn default() -> Self {
        Self::new()
    }
}

impl SshState {
    pub fn new() -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(1),
        }
    }
}

async fn conn_of(state: &State<'_, AppState>, conn_id: &str) -> Result<Arc<Conn>, String> {
    state
        .ssh
        .conns
        .lock()
        .await
        .get(conn_id)
        .cloned()
        .ok_or_else(|| "SSH 连接不存在或已断开".to_string())
}

// ── Path safety (remote, POSIX) ─────────────────────────────────────────────

/// Normalize a caller-supplied `rel_path` into a clean forward-slash relative
/// path, rejecting `..` traversal. Absolute markers / drive prefixes are
/// flattened into relative segments so a request can never escape the root.
fn normalize_rel(rel: &str) -> Result<String, String> {
    let mut parts: Vec<&str> = Vec::new();
    for seg in rel.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => return Err("路径包含非法的 .. 穿越".to_string()),
            s => parts.push(s),
        }
    }
    Ok(parts.join("/"))
}

/// Join the connection root with a normalized `rel` into an absolute remote path.
fn remote_join(root: &str, rel: &str) -> Result<String, String> {
    let rel = normalize_rel(rel)?;
    let base = root.trim_end_matches('/');
    if rel.is_empty() {
        Ok(if base.is_empty() {
            "/".to_string()
        } else {
            base.to_string()
        })
    } else if base.is_empty() {
        Ok(format!("/{rel}"))
    } else {
        Ok(format!("{base}/{rel}"))
    }
}

/// Lowercased extension of a filename (empty for dotfiles / no extension).
fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Establish an SSH session and open an SFTP subsystem. Returns a connection id
/// the frontend uses for every follow-up call. Credentials are dropped here.
#[tauri::command]
pub(crate) async fn ssh_connect(
    host: String,
    port: u16,
    user: String,
    auth: SshAuth,
    state: State<'_, AppState>,
) -> Result<SshConnInfo, String> {
    let host = host.trim().to_string();
    let user = user.trim().to_string();
    if host.is_empty() || user.is_empty() {
        return Err("主机和用户名不能为空".to_string());
    }

    let config = Arc::new(client::Config::default());
    let mut handle = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(config, (host.as_str(), port), ClientHandler),
    )
    .await
    .map_err(|_| "连接超时（检查主机 / 端口 / 网络）".to_string())?
    .map_err(|e| format!("SSH 连接失败: {e}"))?;

    let authed = match auth {
        SshAuth::Password { password } => handle
            .authenticate_password(&user, password)
            .await
            .map_err(|e| format!("密码认证出错: {e}"))?,
        SshAuth::Key {
            key_path,
            passphrase,
        } => {
            let kp = russh::keys::load_secret_key(&key_path, passphrase.as_deref())
                .map_err(|e| format!("私钥加载失败: {e}"))?;
            handle
                .authenticate_publickey(&user, Arc::new(kp))
                .await
                .map_err(|e| format!("密钥认证出错: {e}"))?
        }
    };
    if !authed {
        return Err("认证失败：用户名 / 密码 / 密钥不正确".to_string());
    }

    // Open an SFTP subsystem on a dedicated channel.
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SFTP 通道失败: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("请求 SFTP 子系统失败: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP 初始化失败: {e}"))?;

    let root = sftp
        .canonicalize(".")
        .await
        .unwrap_or_else(|_| "/".to_string());

    let conn_id = format!("ssh-{}", state.ssh.counter.fetch_add(1, Ordering::Relaxed));
    let conn = Arc::new(Conn {
        host: host.clone(),
        port,
        user: user.clone(),
        root: root.clone(),
        handle,
        sftp,
    });
    state.ssh.conns.lock().await.insert(conn_id.clone(), conn);

    Ok(SshConnInfo {
        conn_id,
        host,
        port,
        user,
        root,
    })
}

/// List a single remote directory level (mirrors `ws_list_dir`).
#[tauri::command]
pub(crate) async fn ssh_list_dir(
    conn_id: String,
    rel_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<WsEntry>, String> {
    let conn = conn_of(&state, &conn_id).await?;
    let dir = remote_join(&conn.root, &rel_path)?;
    let base_rel = normalize_rel(&rel_path)?;

    let rd = conn
        .sftp
        .read_dir(dir)
        .await
        .map_err(|e| format!("读取远程目录失败: {e}"))?;

    let mut entries = Vec::new();
    for item in rd {
        let name = item.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = item.metadata();
        let is_dir = meta.is_dir();
        let rel = if base_rel.is_empty() {
            name.clone()
        } else {
            format!("{base_rel}/{name}")
        };
        let ext = if is_dir { String::new() } else { ext_of(&name) };
        entries.push(WsEntry {
            name,
            rel_path: rel,
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            ext,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// Read a remote text file (binary / >1 MB → `too_large`, no content).
#[tauri::command]
pub(crate) async fn ssh_read_file(
    conn_id: String,
    rel_path: String,
    state: State<'_, AppState>,
) -> Result<WsFileContent, String> {
    let conn = conn_of(&state, &conn_id).await?;
    let path = remote_join(&conn.root, &rel_path)?;

    let meta = conn
        .sftp
        .metadata(path.clone())
        .await
        .map_err(|e| format!("读取远程文件信息失败: {e}"))?;
    if meta.is_dir() {
        return Err(format!("这是目录，不是文件: {rel_path}"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Ok(WsFileContent {
            content: String::new(),
            encoding: "too_large".to_string(),
            too_large: true,
        });
    }

    let bytes = conn
        .sftp
        .read(path)
        .await
        .map_err(|e| format!("读取远程文件失败: {e}"))?;
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

/// Write a remote text file (UTF-8, no BOM).
#[tauri::command]
pub(crate) async fn ssh_write_file(
    conn_id: String,
    rel_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = conn_of(&state, &conn_id).await?;
    let path = remote_join(&conn.root, &rel_path)?;
    conn.sftp
        .write(path, content.as_bytes())
        .await
        .map_err(|e| format!("写入远程文件失败: {e}"))
}

/// Create a new remote file or directory.
#[tauri::command]
pub(crate) async fn ssh_create(
    conn_id: String,
    rel_path: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = conn_of(&state, &conn_id).await?;
    let path = remote_join(&conn.root, &rel_path)?;
    if is_dir {
        conn.sftp
            .create_dir(path)
            .await
            .map_err(|e| format!("新建远程文件夹失败: {e}"))
    } else {
        conn.sftp
            .write(path, "".as_bytes())
            .await
            .map_err(|e| format!("新建远程文件失败: {e}"))
    }
}

/// Rename / move a remote file or directory.
#[tauri::command]
pub(crate) async fn ssh_rename(
    conn_id: String,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = conn_of(&state, &conn_id).await?;
    let from_p = remote_join(&conn.root, &from)?;
    let to_p = remote_join(&conn.root, &to)?;
    conn.sftp
        .rename(from_p, to_p)
        .await
        .map_err(|e| format!("重命名失败: {e}"))
}

/// Delete a remote file or directory.
#[tauri::command]
pub(crate) async fn ssh_delete(
    conn_id: String,
    rel_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = conn_of(&state, &conn_id).await?;
    let path = remote_join(&conn.root, &rel_path)?;
    let meta = conn
        .sftp
        .metadata(path.clone())
        .await
        .map_err(|e| format!("读取远程信息失败: {e}"))?;
    if meta.is_dir() {
        conn.sftp
            .remove_dir(path)
            .await
            .map_err(|e| format!("删除远程文件夹失败: {e}"))
    } else {
        conn.sftp
            .remove_file(path)
            .await
            .map_err(|e| format!("删除远程文件失败: {e}"))
    }
}

/// Run a command on the remote host and return stdout / stderr / exit code.
#[tauri::command]
pub(crate) async fn ssh_exec(
    conn_id: String,
    command: String,
    state: State<'_, AppState>,
) -> Result<SshExecResult, String> {
    let conn = conn_of(&state, &conn_id).await?;
    let mut channel = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开远程通道失败: {e}"))?;
    channel
        .exec(true, command.into_bytes())
        .await
        .map_err(|e| format!("远程执行失败: {e}"))?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit: i32 = 0;

    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => {
                    if stdout.len() < EXEC_MAX_BYTES {
                        stdout.extend_from_slice(data);
                    }
                }
                ChannelMsg::ExtendedData { ref data, ext } => {
                    let sink = if ext == 1 { &mut stderr } else { &mut stdout };
                    if sink.len() < EXEC_MAX_BYTES {
                        sink.extend_from_slice(data);
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    exit = exit_status as i32;
                }
                ChannelMsg::Eof | ChannelMsg::Close => {}
                _ => {}
            }
        }
    };

    tokio::time::timeout(EXEC_TIMEOUT, read)
        .await
        .map_err(|_| "远程命令超时（>120s）".to_string())?;

    Ok(SshExecResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit,
    })
}

/// Close and drop an SSH connection.
#[tauri::command]
pub(crate) async fn ssh_disconnect(
    conn_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Dropping the Arc<Conn> drops the russh handle, which tears the session down.
    let removed = state.ssh.conns.lock().await.remove(&conn_id);
    if let Some(conn) = removed {
        let _ = conn
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
    }
    Ok(())
}

/// List currently open SSH connections (host/port/user/root metadata only).
#[tauri::command]
pub(crate) async fn ssh_list_conns(state: State<'_, AppState>) -> Result<Vec<SshConnInfo>, String> {
    let map = state.ssh.conns.lock().await;
    let mut out: Vec<SshConnInfo> = map
        .iter()
        .map(|(id, c)| SshConnInfo {
            conn_id: id.clone(),
            host: c.host.clone(),
            port: c.port,
            user: c.user.clone(),
            root: c.root.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.conn_id.cmp(&b.conn_id));
    Ok(out)
}

// ── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rel_flattens_and_rejects_traversal() {
        assert_eq!(normalize_rel("").unwrap(), "");
        assert_eq!(normalize_rel("a/b/c.txt").unwrap(), "a/b/c.txt");
        assert_eq!(normalize_rel("./a//b/").unwrap(), "a/b");
        // Absolute markers are flattened to relative (cannot escape root).
        assert_eq!(normalize_rel("/etc/passwd").unwrap(), "etc/passwd");
        assert_eq!(normalize_rel("a\\b").unwrap(), "a/b");
        assert!(normalize_rel("../evil").is_err());
        assert!(normalize_rel("a/../../b").is_err());
    }

    #[test]
    fn remote_join_builds_absolute_paths() {
        assert_eq!(remote_join("/home/u", "").unwrap(), "/home/u");
        assert_eq!(
            remote_join("/home/u/", "src/main.rs").unwrap(),
            "/home/u/src/main.rs"
        );
        assert_eq!(remote_join("", "a").unwrap(), "/a");
        assert_eq!(remote_join("/", "").unwrap(), "/");
        assert!(remote_join("/home/u", "../etc").is_err());
    }

    #[test]
    fn ext_of_matches_expectations() {
        assert_eq!(ext_of("main.RS"), "rs");
        assert_eq!(ext_of("archive.tar.gz"), "gz");
        assert_eq!(ext_of("Makefile"), "");
        assert_eq!(ext_of(".gitignore"), "");
        assert_eq!(ext_of("noext."), "");
    }

    #[test]
    fn ssh_auth_deserializes_camelcase_tagged() {
        let p: SshAuth = serde_json::from_str(r#"{"kind":"password","password":"pw"}"#).unwrap();
        match p {
            SshAuth::Password { password } => assert_eq!(password, "pw"),
            _ => panic!("expected password variant"),
        }
        let k: SshAuth =
            serde_json::from_str(r#"{"kind":"key","keyPath":"/k","passphrase":null}"#).unwrap();
        match k {
            SshAuth::Key {
                key_path,
                passphrase,
            } => {
                assert_eq!(key_path, "/k");
                assert!(passphrase.is_none());
            }
            _ => panic!("expected key variant"),
        }
    }

    /// Live end-to-end test — requires a reachable SSH host. Ignored by default
    /// (no fixed test host). To run manually, set the env vars and:
    ///   `cargo test -p agentboard ssh_live -- --ignored --nocapture`
    /// Env: SSH_TEST_HOST, SSH_TEST_PORT (default 22), SSH_TEST_USER,
    ///      SSH_TEST_PASSWORD.
    #[tokio::test]
    #[ignore]
    async fn ssh_live_connect_list_exec() {
        let host = std::env::var("SSH_TEST_HOST").expect("SSH_TEST_HOST");
        let port: u16 = std::env::var("SSH_TEST_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(22);
        let user = std::env::var("SSH_TEST_USER").expect("SSH_TEST_USER");
        let password = std::env::var("SSH_TEST_PASSWORD").expect("SSH_TEST_PASSWORD");

        let config = Arc::new(client::Config::default());
        let mut handle = client::connect(config, (host.as_str(), port), ClientHandler)
            .await
            .expect("connect");
        assert!(handle
            .authenticate_password(&user, password)
            .await
            .expect("auth call"));

        let channel = handle.channel_open_session().await.unwrap();
        channel.request_subsystem(true, "sftp").await.unwrap();
        let sftp = SftpSession::new(channel.into_stream()).await.unwrap();
        let root = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());
        println!("remote root = {root}");
        let rd = sftp.read_dir(root).await.unwrap();
        for e in rd.take(5) {
            println!("  {} (dir={})", e.file_name(), e.metadata().is_dir());
        }
    }
}
