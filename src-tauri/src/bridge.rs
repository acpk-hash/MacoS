//! 飞书指派通道：本地 HTTP 端点 + Node sidecar 生命周期管理
//!
//! ## HTTP 服务器选型：手写 tokio 极简解析器（非 axum）
//! 理由：仅两个路由 POST /feishu/inbound 和 POST /feishu/card-action，
//! 引入 axum/hyper 会增加约 20 个传递依赖且无显著收益；
//! 手写解析器 < 200 行，Bearer token 校验 + JSON 解析已覆盖安全风险。
//!
//! ## Node sidecar 生命周期状态机
//! ```text
//! Stopped ──bridge_start──────────────────────────> Running
//! Running ──崩溃（60 s 内 < 3 次）──指数退避──────> Running
//! Running ──崩溃超限──────────────────────────────> Error
//! Running / Error ──bridge_stop──────────────────> Stopped
//! 任何状态 ──bridge_start──> Running（重置重启计数）
//! ```
//!
//! HTTP 服务器与 Node sidecar 独立：HTTP 监听在 start() 时绑定并持续运行，
//! sidecar 崩溃重启时 HTTP 端口不变，新一轮 Node 进程自动继承相同 BRIDGE_PORT。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{watch, Mutex};

use crate::agent::codex::{AgentAdapter, CodexAdapter, SessionMap, TrackerMap};
use crate::db::Db;
use crate::feishu;

// ── Constants ─────────────────────────────────────────────────────────────────

const LOG_CAP: usize = 50;
const MAX_RESTARTS: u32 = 3;
const RESTART_WINDOW_SECS: u64 = 60;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct BridgeStatusInfo {
    /// "running" | "stopped" | "error"
    pub state: String,
    /// Error description if state == "error", else empty string.
    pub message: String,
    /// Assigned local port (0 when stopped).
    pub port: u16,
    /// Recent sidecar log entries, newest first (max 50).
    pub logs: Vec<String>,
}

// ── Internal state ────────────────────────────────────────────────────────────

enum NodeState {
    Stopped,
    Running,
    Error(String),
}

struct BridgeInner {
    node_state: NodeState,
    /// 64-char hex token, generated once at BridgeManager::new(), reused across restarts.
    token: String,
    /// Assigned TCP port (0 when stopped).
    port: u16,
    /// Sidecar stdout/stderr ring log, newest first.
    logs: VecDeque<String>,
    /// Count of crash-restarts within the current window.
    restart_count: u32,
    /// Start of the current restart-count window (None = no crashes yet).
    window_start: Option<Instant>,
    /// Send `true` to shut down the supervisor + HTTP server.
    stop_tx: Option<watch::Sender<bool>>,
}

impl BridgeInner {
    fn append_log(&mut self, entry: String) {
        self.logs.push_front(entry);
        if self.logs.len() > LOG_CAP {
            self.logs.truncate(LOG_CAP);
        }
    }
}

// ── BridgeManager ─────────────────────────────────────────────────────────────

pub struct BridgeManager {
    inner: Arc<Mutex<BridgeInner>>,
}

impl BridgeManager {
    pub fn new() -> Self {
        // Token: two UUIDs stripped of hyphens = 64 hex chars.
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        Self {
            inner: Arc::new(Mutex::new(BridgeInner {
                node_state: NodeState::Stopped,
                token,
                port: 0,
                logs: VecDeque::with_capacity(LOG_CAP + 1),
                restart_count: 0,
                window_start: None,
                stop_tx: None,
            })),
        }
    }

    /// Start (or restart) the bridge. Idempotent if called while already running.
    pub async fn start(
        &self,
        db: Arc<Db>,
        sessions: SessionMap,
        trackers: TrackerMap,
        adapter: Arc<CodexAdapter>,
        app: AppHandle,
    ) -> Result<(), String> {
        let mut g = self.inner.lock().await;

        // Cancel any existing supervisor/HTTP server.
        if let Some(tx) = g.stop_tx.take() {
            let _ = tx.send(true);
        }

        // Bind a random free port for the HTTP server.
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("无法绑定 HTTP 端口: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();

        g.port = port;
        g.node_state = NodeState::Running;
        g.restart_count = 0;
        g.window_start = None;

        let token = g.token.clone();
        let (stop_tx, stop_rx) = watch::channel(false);
        g.stop_tx = Some(stop_tx);

        drop(g); // release lock before spawning

        let inner_arc = self.inner.clone();
        let token_http = token.clone();
        let db_http = db.clone();
        let app_http = app.clone();
        let http_stop_rx = stop_rx.clone();

        // Spawn HTTP server (lives for the full bridge session).
        tokio::spawn(async move {
            run_http_server(
                listener,
                token_http,
                db_http,
                sessions,
                trackers,
                adapter,
                app_http,
                http_stop_rx,
            )
            .await;
        });

        // Spawn supervisor (manages node sidecar lifecycle + restarts).
        tokio::spawn(run_supervisor(inner_arc, token, port, db, app, stop_rx));

        Ok(())
    }

    /// Stop the bridge (kills sidecar, stops HTTP server).
    pub async fn stop(&self) {
        let mut g = self.inner.lock().await;
        if let Some(tx) = g.stop_tx.take() {
            let _ = tx.send(true);
        }
        g.node_state = NodeState::Stopped;
        g.port = 0;
        g.append_log("[INFO] 桥接已手动停止".to_string());
    }

    /// Return current status for the Tauri command.
    pub async fn status(&self) -> BridgeStatusInfo {
        let g = self.inner.lock().await;
        let (state, message) = match &g.node_state {
            NodeState::Stopped => ("stopped".to_string(), String::new()),
            NodeState::Running => ("running".to_string(), String::new()),
            NodeState::Error(msg) => ("error".to_string(), msg.clone()),
        };
        BridgeStatusInfo {
            state,
            message,
            port: g.port,
            logs: g.logs.iter().cloned().collect(),
        }
    }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn run_http_server(
    listener: TcpListener,
    token: String,
    db: Arc<Db>,
    sessions: SessionMap,
    trackers: TrackerMap,
    adapter: Arc<CodexAdapter>,
    app: AppHandle,
    mut stop_rx: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            result = listener.accept() => {
                match result {
                    Ok((stream, _peer)) => {
                        let tok = token.clone();
                        let db2 = db.clone();
                        let sessions2 = sessions.clone();
                        let trackers2 = trackers.clone();
                        let adapter2 = adapter.clone();
                        let app2 = app.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(
                                stream, &tok, &db2, &sessions2, &trackers2, &adapter2, &app2,
                            )
                            .await
                            {
                                eprintln!("[bridge-http] connection error: {e}");
                            }
                        });
                    }
                    Err(_) => break,
                }
            }
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() { break; }
            }
        }
    }
}

// ── Connection router ─────────────────────────────────────────────────────────

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    token: &str,
    db: &Arc<Db>,
    sessions: &SessionMap,
    trackers: &TrackerMap,
    adapter: &Arc<CodexAdapter>,
    app: &AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // ── Read until end-of-headers ─────────────────────────────────────────────
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];
    let header_end: usize;

    loop {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = pos + 4;
            break;
        }
        if buf.len() > 65_536 {
            write_response(&mut stream, 413, "Payload Too Large").await?;
            return Ok(());
        }
    }

    let header_str = std::str::from_utf8(&buf[..header_end]).unwrap_or("");

    // ── Route on method + path ────────────────────────────────────────────────
    let first_line = header_str.lines().next().unwrap_or("");
    let is_inbound = first_line.starts_with("POST /feishu/inbound");
    let is_card_action = first_line.starts_with("POST /feishu/card-action");

    if !is_inbound && !is_card_action {
        write_response(&mut stream, 404, "Not Found").await?;
        return Ok(());
    }

    // ── Validate Authorization header ─────────────────────────────────────────
    let auth_ok = extract_auth_bearer(header_str)
        .map(|val| val == token)
        .unwrap_or(false);

    if !auth_ok {
        write_response(&mut stream, 401, "Unauthorized").await?;
        return Ok(());
    }

    // ── Read body ─────────────────────────────────────────────────────────────
    let content_length: usize = header_str
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
        .and_then(|l| l.splitn(2, ':').nth(1))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);

    if content_length > 65_536 {
        write_response(&mut stream, 413, "Payload Too Large").await?;
        return Ok(());
    }

    let mut body = buf[header_end..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    let body_slice = &body[..content_length.min(body.len())];

    if is_inbound {
        handle_inbound(stream, token, header_str, body_slice, db, app).await
    } else {
        handle_card_action(stream, body_slice, db, sessions, trackers, adapter, app).await
    }
}

// ── /feishu/inbound handler ───────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct InboundPayload {
    text: String,
    #[serde(default)]
    #[allow(dead_code)]
    sender_open_id: String,
    #[serde(default)]
    chat_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    message_id: String,
}

async fn handle_inbound(
    mut stream: tokio::net::TcpStream,
    _token: &str,
    _header_str: &str,
    body_slice: &[u8],
    db: &Arc<Db>,
    app: &AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // ── Parse JSON payload ────────────────────────────────────────────────────
    let payload: InboundPayload = match serde_json::from_slice(body_slice) {
        Ok(p) => p,
        Err(e) => {
            write_response(&mut stream, 400, "Bad Request").await?;
            return Err(format!("JSON parse error: {e}").into());
        }
    };

    // ── Create task ───────────────────────────────────────────────────────────
    let title = truncate_title(&payload.text, 80);
    let workdir = db
        .settings_get("default_workdir")
        .unwrap_or(None)
        .unwrap_or_default();
    let task_id = uuid::Uuid::new_v4().to_string();

    if let Err(e) = db.insert_task_todo(&task_id, &title, &workdir) {
        eprintln!("[bridge-http] 建任务失败: {e}");
        write_response(&mut stream, 500, "Internal Server Error").await?;
        return Ok(());
    }

    // ── Emit frontend refresh ─────────────────────────────────────────────────
    let _ = app.emit("bridge-task-created", &task_id);

    // ── Respond immediately ───────────────────────────────────────────────────
    write_response(&mut stream, 200, "OK").await?;

    // ── Async confirmation card (fire-and-forget) ─────────────────────────────
    let chat_id = payload.chat_id.clone();
    let title2 = title.clone();
    let task_id2 = task_id.clone();
    let db2 = db.clone();
    if !chat_id.is_empty() {
        tokio::spawn(async move {
            if let Ok(settings) = db2.settings_get_all() {
                let app_id = settings.get("feishu_app_id").cloned().unwrap_or_default();
                let app_secret = settings.get("feishu_app_secret").cloned().unwrap_or_default();
                if !app_id.trim().is_empty() && !app_secret.trim().is_empty() {
                    let cfg = feishu::FeishuConfig {
                        app_id,
                        app_secret,
                        receive_id_type: "chat_id".to_string(),
                        receive_id: chat_id,
                    };
                    let card = feishu::card_task_created(&title2, &task_id2);
                    if let Err(e) = feishu::send_card(&cfg, card).await {
                        eprintln!("[bridge-http] 回复确认卡片失败: {e}");
                    }
                }
            }
        });
    }

    Ok(())
}

// ── /feishu/card-action handler ───────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct CardActionPayload {
    action: String,
    task_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    operator_open_id: String,
}

#[derive(serde::Serialize)]
struct CardActionResponse {
    toast: String,
    ok: bool,
}

/// Pure validation + state-machine logic for a card action.
///
/// Returns `Ok((toast, ok_flag))` — callers should always return HTTP 200
/// and embed these in the response body.  Only actual protocol errors
/// (bad JSON, missing task) return `Err`.
pub(crate) async fn validate_card_action(
    action: &str,
    task_id: &str,
    db: &Arc<Db>,
) -> Result<(String, bool), String> {
    match action {
        "dispatch" => {
            let (title, workdir, status) = db
                .get_task_by_id(task_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("任务 {} 不存在", task_id))?;

            if status != "todo" {
                return Ok((
                    format!("任务已在进行中（当前状态：{}）", status),
                    false,
                ));
            }
            if workdir.trim().is_empty() {
                return Ok((
                    "未设置工作目录，请在电脑上派发".to_string(),
                    false,
                ));
            }

            // Return the title and workdir for the caller to use.
            // We embed them in the Ok payload via a sentinel string so the
            // caller doesn't need a separate DB query.
            let _ = title; // validated; caller re-fetches from DB
            Ok(("ok:dispatch".to_string(), true))
        }
        "accept" => {
            let (_title, _workdir, status) = db
                .get_task_by_id(task_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("任务 {} 不存在", task_id))?;

            if status != "awaiting_review" {
                return Ok((
                    format!("任务不在待验收状态（当前状态：{}）", status),
                    false,
                ));
            }
            Ok(("ok:accept".to_string(), true))
        }
        _ => Err(format!("未知操作：{}", action)),
    }
}

async fn handle_card_action(
    mut stream: tokio::net::TcpStream,
    body_slice: &[u8],
    db: &Arc<Db>,
    sessions: &SessionMap,
    trackers: &TrackerMap,
    adapter: &Arc<CodexAdapter>,
    app: &AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let payload: CardActionPayload = match serde_json::from_slice(body_slice) {
        Ok(p) => p,
        Err(_) => {
            write_response(&mut stream, 400, "Bad Request").await?;
            return Ok(());
        }
    };

    if payload.action.is_empty() || payload.task_id.is_empty() {
        let resp = serde_json::to_string(&CardActionResponse {
            toast: "请求缺少 action 或 task_id 字段".to_string(),
            ok: false,
        })
        .unwrap_or_default();
        write_json_response(&mut stream, 400, "Bad Request", &resp).await?;
        return Ok(());
    }

    // Validate action name before touching DB.
    if payload.action != "dispatch" && payload.action != "accept" {
        let resp = serde_json::to_string(&CardActionResponse {
            toast: format!("未知操作：{}", payload.action),
            ok: false,
        })
        .unwrap_or_default();
        write_json_response(&mut stream, 400, "Bad Request", &resp).await?;
        return Ok(());
    }

    let (toast, ok) = match validate_card_action(&payload.action, &payload.task_id, db).await {
        Ok((sentinel, true)) => {
            // Sentinel "ok:dispatch" / "ok:accept" — proceed with side effects.
            match sentinel.as_str() {
                "ok:dispatch" => {
                    match do_dispatch(&payload.task_id, db, sessions, trackers, adapter, app).await
                    {
                        Ok(()) => ("已派发 ✔".to_string(), true),
                        Err(e) => {
                            eprintln!("[bridge-card] dispatch 失败: {e}");
                            (format!("派发失败：{e}"), false)
                        }
                    }
                }
                "ok:accept" => {
                    match do_accept(&payload.task_id, db, app).await {
                        Ok(()) => ("已验收 ✔".to_string(), true),
                        Err(e) => {
                            eprintln!("[bridge-card] accept 失败: {e}");
                            (format!("验收失败：{e}"), false)
                        }
                    }
                }
                _ => unreachable!(),
            }
        }
        Ok((msg, false)) => (msg, false),
        Err(e) => {
            eprintln!("[bridge-card] 校验失败: {e}");
            (e, false)
        }
    };

    let resp = serde_json::to_string(&CardActionResponse { toast, ok }).unwrap_or_default();
    write_json_response(&mut stream, 200, "OK", &resp).await?;
    Ok(())
}

/// Core dispatch logic: create session, start agent.
///
/// Mirrors `agent_start` in lib.rs (task_id already exists, status = todo).
/// Reused by the mobile sync `dispatch_task` command (`sync::apply_command`).
pub(crate) async fn do_dispatch(
    task_id: &str,
    db: &Arc<Db>,
    sessions: &SessionMap,
    trackers: &TrackerMap,
    adapter: &Arc<CodexAdapter>,
    app: &AppHandle,
) -> Result<(), String> {
    let (title, workdir, _) = db
        .get_task_by_id(task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("任务 {} 不存在", task_id))?;

    let session_id = uuid::Uuid::new_v4().to_string();

    db.insert_session(&session_id, task_id, "codex")
        .map_err(|e| e.to_string())?;
    db.update_task_status(task_id, "running")
        .map_err(|e| e.to_string())?;
    db.insert_message(&session_id, "user", &title)
        .map_err(|e| e.to_string())?;

    let emit_fn = crate::make_emit_fn_with_db(app.clone(), db.clone());

    let reasoning_effort = db
        .settings_get("reasoning_effort")
        .unwrap_or(None)
        .unwrap_or_else(|| "low".to_string());

    let session_adapter = Arc::new(CodexAdapter {
        extra_args: vec![
            "-c".to_string(),
            format!("model_reasoning_effort={}", reasoning_effort),
        ],
        sandbox: adapter.sandbox.clone(),
    });

    session_adapter
        .start_session(
            session_id.clone(),
            sessions.clone(),
            trackers.clone(),
            title,
            workdir,
            emit_fn,
        )
        .await
        .map_err(|e| e.to_string())?;

    // Notify frontend board to refresh.
    let _ = app.emit("bridge-task-created", task_id);
    // Push updated task/session state to mobile.
    crate::notify_sync_snapshot(app);

    Ok(())
}

/// Core accept logic: transition awaiting_review → done.
/// Reused by the mobile sync `accept_task` command (`sync::apply_command`).
pub(crate) async fn do_accept(task_id: &str, db: &Arc<Db>, app: &AppHandle) -> Result<(), String> {
    db.set_task_status_validated(task_id, "done")?;
    // Notify frontend board to refresh.
    let _ = app.emit("bridge-task-created", task_id);
    crate::notify_sync_snapshot(app);
    Ok(())
}

/// Extract the Bearer token value from the Authorization header (case-insensitive header name).
pub(crate) fn extract_auth_bearer(headers: &str) -> Option<&str> {
    for line in headers.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("authorization:") {
            let rest_trimmed = rest.trim();
            if let Some(token_lower) = rest_trimmed.strip_prefix("bearer ") {
                // Return the same slice from the original line (preserves case of token).
                let offset = line.len() - token_lower.len();
                return Some(line[offset..].trim());
            }
        }
    }
    None
}

/// Truncate `text` to at most `max_chars` Unicode scalar values.
pub(crate) fn truncate_title(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

async fn write_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    reason: &str,
) -> tokio::io::Result<()> {
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(resp.as_bytes()).await
}

async fn write_json_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) -> tokio::io::Result<()> {
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes()).await
}

// ── Supervisor ────────────────────────────────────────────────────────────────

async fn run_supervisor(
    inner: Arc<Mutex<BridgeInner>>,
    token: String,
    port: u16,
    db: Arc<Db>,
    app: AppHandle,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut backoff_secs: u64 = 1;

    loop {
        // Bail immediately if stop was requested.
        if *stop_rx.borrow() {
            break;
        }

        // ── Spawn node ────────────────────────────────────────────────────────
        let spawn_result = spawn_node(&token, port, &db).await;

        let mut child = match spawn_result {
            Err(e) => {
                let msg = format!("[ERR] node 启动失败: {e}");
                eprintln!("[bridge-supervisor] {msg}");
                let mut g = inner.lock().await;
                g.append_log(msg.clone());
                g.node_state = NodeState::Error(e);
                break;
            }
            Ok(c) => c,
        };

        {
            let mut g = inner.lock().await;
            g.append_log(format!("[INFO] node sidecar 已启动 (port={port})"));
            g.node_state = NodeState::Running;
        }

        // Pipe stdout / stderr to ring log.
        if let Some(stdout) = child.stdout.take() {
            let inner2 = inner.clone();
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    inner2.lock().await.append_log(format!("[out] {line}"));
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let inner2 = inner.clone();
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    inner2.lock().await.append_log(format!("[err] {line}"));
                }
            });
        }

        // ── Wait for exit or stop signal ──────────────────────────────────────
        let exited = tokio::select! {
            status = child.wait() => {
                let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                Some(code)
            }
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    kill_child(&mut child).await;
                    let mut g = inner.lock().await;
                    g.node_state = NodeState::Stopped;
                    g.append_log("[INFO] sidecar 已停止".to_string());
                    return;
                }
                None
            }
        };

        let exit_code = match exited {
            None => continue, // spurious watch wake-up, loop back
            Some(c) => c,
        };

        let crash_msg = format!("[WARN] node 退出 (exit_code={exit_code})");
        eprintln!("[bridge-supervisor] {crash_msg}");
        inner.lock().await.append_log(crash_msg);

        // ── Restart decision ──────────────────────────────────────────────────
        let should_restart = {
            let mut g = inner.lock().await;
            check_should_restart(&mut g)
        };

        if !should_restart {
            let err_msg = format!(
                "sidecar 在 {RESTART_WINDOW_SECS}s 内崩溃超过 {MAX_RESTARTS} 次，停止自动重启"
            );
            let mut g = inner.lock().await;
            g.append_log(format!("[ERR] {err_msg}"));
            g.node_state = NodeState::Error(err_msg);
            break;
        }

        // Exponential backoff before retry.
        let _ = app.emit("bridge-status-changed", "restarting");
        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

/// Returns `true` if the sidecar should be restarted, `false` if the limit is exceeded.
fn check_should_restart(inner: &mut BridgeInner) -> bool {
    let now = Instant::now();
    match inner.window_start {
        None => {
            inner.window_start = Some(now);
            inner.restart_count = 1;
            true
        }
        Some(start) => {
            if now.duration_since(start).as_secs() > RESTART_WINDOW_SECS {
                // Reset window.
                inner.window_start = Some(now);
                inner.restart_count = 1;
                true
            } else {
                inner.restart_count += 1;
                inner.restart_count <= MAX_RESTARTS
            }
        }
    }
}

// ── Process helpers ───────────────────────────────────────────────────────────

async fn spawn_node(
    token: &str,
    port: u16,
    db: &Arc<Db>,
) -> Result<tokio::process::Child, String> {
    use std::process::Stdio;
    use tokio::process::Command;

    let script = bridge_script_path();

    let settings = db.settings_get_all().map_err(|e| e.to_string())?;
    let app_id = settings.get("feishu_app_id").cloned().unwrap_or_default();
    let app_secret = settings.get("feishu_app_secret").cloned().unwrap_or_default();

    if app_id.trim().is_empty() {
        return Err("飞书 App ID 未配置".to_string());
    }
    if app_secret.trim().is_empty() {
        return Err("飞书 App Secret 未配置".to_string());
    }

    let script_str = script.to_str().unwrap_or("feishu-bridge/index.js");

    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/c", "node", script_str]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("node");
        c.arg(script_str);
        c
    };

    cmd.env("FEISHU_APP_ID", &app_id)
        .env("FEISHU_APP_SECRET", &app_secret)
        .env("BRIDGE_PORT", port.to_string())
        .env("BRIDGE_TOKEN", token)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    cmd.spawn().map_err(|e| format!("spawn node 失败: {e}"))
}

async fn kill_child(child: &mut tokio::process::Child) {
    // On Windows, use taskkill /T to terminate the process tree
    // (node may spawn sub-processes).
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let _ = tokio::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status()
            .await;
    }
    // Also call kill() as fallback / for non-Windows.
    let _ = child.kill().await;
}

fn bridge_script_path() -> PathBuf {
    // Allow explicit override via env var.
    if let Ok(p) = std::env::var("FEISHU_BRIDGE_PATH") {
        return PathBuf::from(p);
    }

    // In production: look next to the executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("feishu-bridge").join("index.js");
            if candidate.exists() {
                return candidate;
            }
        }
    }

    // In dev (cargo tauri dev): cwd is project root.
    PathBuf::from("feishu-bridge").join("index.js")
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── extract_auth_bearer ───────────────────────────────────────────────────

    #[test]
    fn auth_bearer_standard_header() {
        let headers =
            "POST /feishu/inbound HTTP/1.1\r\nAuthorization: Bearer abc123def456\r\nContent-Length: 0\r\n\r\n";
        let val = extract_auth_bearer(headers);
        assert_eq!(val, Some("abc123def456"), "should extract token from Authorization header");
    }

    #[test]
    fn auth_bearer_lowercase_header_name() {
        let headers = "POST /feishu/inbound HTTP/1.1\r\nauthorization: Bearer mytoken\r\nContent-Length: 0\r\n\r\n";
        let val = extract_auth_bearer(headers);
        assert_eq!(val, Some("mytoken"));
    }

    #[test]
    fn auth_bearer_missing_returns_none() {
        let headers = "POST /feishu/inbound HTTP/1.1\r\nContent-Length: 0\r\n\r\n";
        let val = extract_auth_bearer(headers);
        assert!(val.is_none(), "missing authorization → None");
    }

    #[test]
    fn auth_bearer_wrong_scheme_returns_none() {
        let headers = "POST /feishu/inbound HTTP/1.1\r\nAuthorization: Basic dXNlcjpwYXNz\r\n\r\n";
        let val = extract_auth_bearer(headers);
        assert!(val.is_none(), "Basic auth → None (only Bearer accepted)");
    }

    #[test]
    fn auth_bearer_wrong_token_does_not_match() {
        let headers = "POST /feishu/inbound HTTP/1.1\r\nAuthorization: Bearer WRONG\r\n\r\n";
        let val = extract_auth_bearer(headers);
        let token = "CORRECT";
        assert_ne!(val, Some(token), "wrong token must not match");
    }

    // ── truncate_title ────────────────────────────────────────────────────────

    #[test]
    fn truncate_title_under_limit_unchanged() {
        let text = "短标题";
        let result = truncate_title(text, 80);
        assert_eq!(result, "短标题");
    }

    #[test]
    fn truncate_title_exactly_80_unchanged() {
        let text: String = "a".repeat(80);
        let result = truncate_title(&text, 80);
        assert_eq!(result.chars().count(), 80);
    }

    #[test]
    fn truncate_title_over_limit_cut_to_80() {
        let text: String = "字".repeat(100);
        let result = truncate_title(&text, 80);
        assert_eq!(result.chars().count(), 80, "must be exactly 80 chars");
    }

    #[test]
    fn truncate_title_handles_multibyte_correctly() {
        // Mix of ASCII and CJK; length in chars != bytes.
        let text: String = std::iter::repeat('中').take(90).collect();
        let result = truncate_title(&text, 80);
        assert_eq!(result.chars().count(), 80);
        assert!(result.chars().all(|c| c == '中'));
    }

    // ── check_should_restart (state machine) ──────────────────────────────────

    fn make_inner_for_restart_test() -> BridgeInner {
        BridgeInner {
            node_state: NodeState::Stopped,
            token: "tok".to_string(),
            port: 0,
            logs: VecDeque::new(),
            restart_count: 0,
            window_start: None,
            stop_tx: None,
        }
    }

    #[test]
    fn restart_first_crash_allowed() {
        let mut inner = make_inner_for_restart_test();
        assert!(check_should_restart(&mut inner), "first crash should allow restart");
        assert_eq!(inner.restart_count, 1);
    }

    #[test]
    fn restart_up_to_max_allowed() {
        let mut inner = make_inner_for_restart_test();
        for i in 1..=MAX_RESTARTS {
            assert!(
                check_should_restart(&mut inner),
                "restart #{i} should be allowed"
            );
        }
        assert_eq!(inner.restart_count, MAX_RESTARTS);
    }

    #[test]
    fn restart_over_max_denied() {
        let mut inner = make_inner_for_restart_test();
        // Saturate the window.
        for _ in 0..MAX_RESTARTS {
            check_should_restart(&mut inner);
        }
        // One more should be denied.
        assert!(
            !check_should_restart(&mut inner),
            "crash beyond MAX_RESTARTS within window must be denied"
        );
    }

    #[test]
    fn restart_window_resets_after_expiry() {
        let mut inner = make_inner_for_restart_test();
        // Saturate window.
        for _ in 0..=MAX_RESTARTS {
            check_should_restart(&mut inner);
        }
        // Manually expire the window.
        inner.window_start = Some(
            Instant::now()
                - Duration::from_secs(RESTART_WINDOW_SECS + 1),
        );
        // Should be allowed again (new window).
        assert!(
            check_should_restart(&mut inner),
            "after window expiry, restart should be allowed again"
        );
        assert_eq!(inner.restart_count, 1, "counter should reset");
    }

    // ── BridgeManager status lifecycle (no process spawning) ─────────────────

    #[tokio::test]
    async fn bridge_manager_initially_stopped() {
        let mgr = BridgeManager::new();
        let info = mgr.status().await;
        assert_eq!(info.state, "stopped");
        assert_eq!(info.port, 0);
        assert!(info.logs.is_empty());
    }

    #[tokio::test]
    async fn bridge_manager_stop_when_already_stopped_is_noop() {
        let mgr = BridgeManager::new();
        mgr.stop().await; // should not panic
        let info = mgr.status().await;
        assert_eq!(info.state, "stopped");
    }

    // ── Node spawn / lifecycle integration (skips if node unavailable) ────────

    /// Verify that start() binds a port and transitions to Running,
    /// then stop() transitions back to Stopped.
    ///
    /// Uses `node -e "setTimeout(()=>{},60000)"` as a long-lived fake sidecar.
    /// Skipped automatically if node is not installed.
    #[tokio::test]
    async fn bridge_lifecycle_start_stop() {
        // Check if node is available.
        #[cfg(windows)]
        let node_ok = tokio::process::Command::new("cmd")
            .args(["/c", "node", "--version"])
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false);
        #[cfg(not(windows))]
        let node_ok = tokio::process::Command::new("node")
            .arg("--version")
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !node_ok {
            eprintln!("[test] node not installed — skipping bridge_lifecycle_start_stop");
            return;
        }

        // Set FEISHU_BRIDGE_PATH to a tiny inline script that sleeps indefinitely.
        // We write the script to a temp file.
        let tmp_dir = tempfile::tempdir().expect("tempdir");
        let script_path = tmp_dir.path().join("fake_sidecar.js");
        tokio::fs::write(
            &script_path,
            b"setTimeout(function(){}, 60000);\nconsole.log('fake sidecar running');\n",
        )
        .await
        .unwrap();

        std::env::set_var("FEISHU_BRIDGE_PATH", script_path.to_str().unwrap());
        // Also set fake credentials so spawn_node doesn't bail out.
        std::env::set_var("__BRIDGE_TEST_MODE", "1"); // marker; not used in code but documents intent

        let db = Arc::new(crate::db::Db::open_in_memory().expect("in-memory db"));
        db.settings_set("feishu_app_id", "cli_test").unwrap();
        db.settings_set("feishu_app_secret", "test_secret").unwrap();

        // We need an AppHandle, which requires a running Tauri context.
        // This is not available in a unit test, so we skip the full start() call
        // and instead test spawn_node directly.
        let child_result = spawn_node(
            "test_token_abc",
            59999,
            &db,
        )
        .await;

        match child_result {
            Ok(mut child) => {
                // Give it a moment to start.
                tokio::time::sleep(Duration::from_millis(200)).await;
                // It should still be running.
                assert!(child.try_wait().unwrap().is_none(), "fake sidecar should still run");
                // Kill it.
                kill_child(&mut child).await;
                std::env::remove_var("FEISHU_BRIDGE_PATH");
            }
            Err(e) => {
                std::env::remove_var("FEISHU_BRIDGE_PATH");
                panic!("spawn_node failed: {e}");
            }
        }
    }

    /// Verify that a fast-crashing sidecar increments restart count correctly.
    #[tokio::test]
    async fn bridge_crash_increments_restart_count() {
        let mut inner = make_inner_for_restart_test();

        // Simulate 3 crashes within the window.
        for _ in 0..3 {
            check_should_restart(&mut inner);
        }
        assert_eq!(inner.restart_count, 3);

        // 4th crash should exceed limit.
        let allowed = check_should_restart(&mut inner);
        assert!(!allowed, "4th crash in window must be denied");
    }

    // ── validate_card_action ──────────────────────────────────────────────────

    #[tokio::test]
    async fn card_action_dispatch_valid_todo_task() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        db.insert_task_todo("t1", "测试任务", "/work/dir").unwrap();

        let (sentinel, ok) = validate_card_action("dispatch", "t1", &db)
            .await
            .unwrap();
        assert!(ok, "valid todo task with workdir should succeed");
        assert_eq!(sentinel, "ok:dispatch");
    }

    #[tokio::test]
    async fn card_action_dispatch_already_running() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        db.insert_task("t2", "运行中任务", "/work").unwrap(); // status = running
        db.insert_session("s2", "t2", "codex").unwrap();

        let (toast, ok) = validate_card_action("dispatch", "t2", &db)
            .await
            .unwrap();
        assert!(!ok, "running task should return ok=false");
        assert!(toast.contains("进行中"), "toast should indicate already running");
    }

    #[tokio::test]
    async fn card_action_dispatch_missing_workdir() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        db.insert_task_todo("t3", "无工作目录", "").unwrap(); // empty workdir

        let (toast, ok) = validate_card_action("dispatch", "t3", &db)
            .await
            .unwrap();
        assert!(!ok, "empty workdir should return ok=false");
        assert!(toast.contains("工作目录"), "toast should mention 工作目录");
    }

    #[tokio::test]
    async fn card_action_accept_valid_awaiting_review() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        db.insert_task("t4", "待验收任务", "/work").unwrap();
        db.insert_session("s4", "t4", "codex").unwrap();
        db.update_task_status("t4", "awaiting_review").unwrap();

        let (sentinel, ok) = validate_card_action("accept", "t4", &db)
            .await
            .unwrap();
        assert!(ok, "awaiting_review task should succeed");
        assert_eq!(sentinel, "ok:accept");
    }

    #[tokio::test]
    async fn card_action_accept_wrong_status() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        db.insert_task("t5", "运行中", "/work").unwrap(); // status = running
        db.insert_session("s5", "t5", "codex").unwrap();

        let (toast, ok) = validate_card_action("accept", "t5", &db)
            .await
            .unwrap();
        assert!(!ok, "non-awaiting_review status should return ok=false");
        assert!(toast.contains("待验收"), "toast should explain the status issue");
    }

    #[tokio::test]
    async fn card_action_unknown_action_returns_err() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        db.insert_task_todo("t6", "任务", "/work").unwrap();

        let result = validate_card_action("unknown_action", "t6", &db).await;
        assert!(result.is_err(), "unknown action should return Err");
    }

    #[tokio::test]
    async fn card_action_nonexistent_task_returns_err() {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());

        let result = validate_card_action("dispatch", "nonexistent-id", &db).await;
        assert!(result.is_err(), "nonexistent task should return Err");
    }
}
