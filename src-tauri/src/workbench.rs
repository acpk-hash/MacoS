//! Workbench engine (v0.9): drives the bundled `agentboard-engine` (codex-rs)
//! sidecar as the workbench kernel — the pi sidecar is retired.
//!
//! ## Why the embedded codex engine
//! The engine ships inside the installer (`agentboard-engine.exe`, codex-core
//! in-process), needs no Node runtime, and talks the exact protocol codex
//! itself uses. The old pi RPC path had a history of one-shot hangs and its
//! own model registry; the codex engine reuses the provider system directly.
//!
//! ## Provider / credential injection (never touches disk or logs)
//! codex-core resolves its provider from `$CODEX_HOME/config.toml`. Each
//! session gets a **temp** CODEX_HOME containing a generated `config.toml`
//! that defines one provider `agentboard` (the F1-selected provider's
//! `base_url`, wire_api `responses`) whose key comes from `env_key =
//! "AGENTBOARD_CODEX_KEY"` — an env *reference*. The real key is injected only
//! as an environment variable of the child process; it never lands in
//! config.toml, SQLite, logs, or the frontend.
//!
//! Note: codex ≥0.13x removed `wire_api = "chat"` entirely, so the engine
//! always speaks the Responses API. Verified live against the user's relay
//! (`/v1/responses` accepts plain API-key auth, 2026-07-11).
//!
//! ## Event mapping (engine OutEvent → workbench-event)
//! The frontend keeps its pi-era event shapes; the engine stream is mapped:
//!   - assistant_delta / assistant_message → unchanged
//!   - command_run   → tool_started(bash) + tool_bash
//!   - file_edit add → tool_started(write) + tool_write
//!   - file_edit update → tool_started(edit) + tool_edit (unified diff)
//!   - file_edit delete → tool_started(delete) + tool_result
//!   - usage         → token_stats (accumulated per session)
//!   - turn_completed / error → unchanged
//! `turn_started` is emitted synthetically when a prompt is dispatched.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, watch, Mutex};

use crate::agent::embedded::{locate_codex_exe, EngineEvent};
use crate::db::Db;

/// Engine start_thread → thread_started handshake budget (codex-core builds
/// its stack lazily on the first thread; no network involved).
const HANDSHAKE_TIMEOUT_SECS: u64 = 60;
/// Env var name referenced by the generated `config.toml` (value = the key).
const KEY_ENV: &str = "AGENTBOARD_CODEX_KEY";
/// Context window assumed for the usage bar (gpt-5.x class models).
const CONTEXT_WINDOW: i64 = 400_000;

// ── Frontend-facing event model (pi-era shapes, unchanged) ──────────────────

/// A workbench event forwarded to the frontend on the `workbench-event` channel.
/// Serialized with an internal `type` tag (snake_case).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkbenchEvent {
    /// Streaming assistant text chunk.
    AssistantDelta { text: String },
    /// A finalized assistant text block.
    AssistantMessage { text: String },
    /// Streaming thinking/reasoning chunk.
    Thinking { text: String },
    /// A tool call has begun (drives the progress bar + checklist).
    ToolStarted {
        tool_call_id: String,
        tool: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cmd: Option<String>,
    },
    /// bash tool finished.
    ToolBash {
        tool_call_id: String,
        cmd: String,
        output: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
    },
    /// edit tool finished (path + unified diff).
    ToolEdit {
        tool_call_id: String,
        path: String,
        diff: String,
    },
    /// write tool finished.
    ToolWrite {
        tool_call_id: String,
        path: String,
    },
    /// Any other tool (delete/…) finished.
    ToolResult {
        tool_call_id: String,
        tool: String,
        output: String,
        is_error: bool,
    },
    /// Token usage snapshot (emitted after each usage event).
    TokenStats {
        input: i64,
        output: i64,
        cache_read: i64,
        cache_write: i64,
        total: i64,
        cost: f64,
        context_tokens: i64,
        context_window: i64,
        context_percent: f64,
    },
    /// A turn (agent run) has started.
    TurnStarted,
    /// A turn has completed (agent idle).
    TurnCompleted,
    /// The engine exited or a fatal protocol error occurred.
    Error { message: String },
}

impl WorkbenchEvent {
    /// Short label used as the persisted entry `kind`.
    fn kind(&self) -> &'static str {
        match self {
            WorkbenchEvent::AssistantDelta { .. } => "assistant_delta",
            WorkbenchEvent::AssistantMessage { .. } => "assistant_message",
            WorkbenchEvent::Thinking { .. } => "thinking",
            WorkbenchEvent::ToolStarted { .. } => "tool_started",
            WorkbenchEvent::ToolBash { .. } => "tool_bash",
            WorkbenchEvent::ToolEdit { .. } => "tool_edit",
            WorkbenchEvent::ToolWrite { .. } => "tool_write",
            WorkbenchEvent::ToolResult { .. } => "tool_result",
            WorkbenchEvent::TokenStats { .. } => "token_stats",
            WorkbenchEvent::TurnStarted => "turn_started",
            WorkbenchEvent::TurnCompleted => "turn_completed",
            WorkbenchEvent::Error { .. } => "error",
        }
    }

    /// Whether this event should be persisted to `workbench_entries`.
    /// High-frequency deltas are forwarded live but not stored.
    fn persist(&self) -> bool {
        !matches!(
            self,
            WorkbenchEvent::AssistantDelta { .. }
                | WorkbenchEvent::Thinking { .. }
                | WorkbenchEvent::ToolStarted { .. }
                | WorkbenchEvent::TokenStats { .. }
        )
    }
}

/// Envelope sent to the frontend: `{ sessionId, event: { type, … } }`.
#[derive(Debug, Clone, Serialize)]
pub struct WorkbenchEventEnvelope {
    pub session_id: String,
    pub event: WorkbenchEvent,
}

/// Result of `workbench_open`.
#[derive(Debug, Clone, Serialize)]
pub struct WorkbenchOpenResult {
    pub session_id: String,
    pub provider_id: String,
    pub model: String,
}

/// Token stats returned by the `workbench_stats` command.
#[derive(Debug, Clone, Serialize, Default)]
pub struct WorkbenchStats {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub total: i64,
    pub cost: f64,
    pub context_tokens: i64,
    pub context_window: i64,
    pub context_percent: f64,
}

/// One (provider, model) pair from `workbench_models`.
#[derive(Debug, Clone, Serialize)]
pub struct WorkbenchModel {
    pub provider: String,
    pub id: String,
}

// ── Engine handle + manager ─────────────────────────────────────────────────

/// One live codex-engine session.
struct EngineHandle {
    session_id: String,
    /// codex thread id (from the thread_started handshake).
    thread_id: String,
    /// Sends command JSON values to the writer task → child stdin.
    cmd_tx: mpsc::UnboundedSender<Value>,
    /// Signals the supervisor task to kill the child (taskkill + kill).
    stop_tx: watch::Sender<bool>,
    /// Temp CODEX_HOME (generated config.toml, rollouts); removed on close.
    codex_home: PathBuf,
    /// Working directory — reused by `set_model` when restarting the engine.
    cwd: String,
    /// Accumulated token usage for this session.
    stats: Arc<Mutex<WorkbenchStats>>,
    /// App handle for synthetic emits (turn_started on prompt).
    app: AppHandle,
}

/// Manages the single active workbench codex engine.
pub struct WorkbenchEngine {
    inner: Arc<Mutex<Option<EngineHandle>>>,
}

impl Default for WorkbenchEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkbenchEngine {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    /// Open a workbench session: spawn the codex engine against `dir` using
    /// the F1 provider `provider_id` (or the default) and `model`. Closes any
    /// existing session first.
    pub async fn open(
        &self,
        db: Arc<Db>,
        app: AppHandle,
        dir: String,
        provider_id: Option<String>,
        model: String,
    ) -> Result<WorkbenchOpenResult, String> {
        // Close any prior session.
        self.close().await;

        let provider_id = resolve_provider_id(&db, provider_id)?;
        let model = model.trim().to_string();
        if model.is_empty() {
            return Err("请指定模型".to_string());
        }
        if dir.trim().is_empty() {
            return Err("请选择工作目录".to_string());
        }
        let dir = normalize_spawn_path(Path::new(&dir))
            .to_string_lossy()
            .to_string();
        if !Path::new(&dir).is_dir() {
            return Err(format!("工作目录不存在: {dir}"));
        }

        let handle =
            spawn_engine(db, app, dir.clone(), provider_id.clone(), model.clone()).await?;
        let session_id = handle.session_id.clone();
        *self.inner.lock().await = Some(handle);

        Ok(WorkbenchOpenResult {
            session_id,
            provider_id,
            model,
        })
    }

    /// Send a fresh prompt (a new turn).
    pub async fn prompt(&self, db: &Arc<Db>, text: String) -> Result<(), String> {
        let g = self.inner.lock().await;
        let h = g.as_ref().ok_or_else(|| "工作台未启动".to_string())?;
        let _ = db.workbench_entry_insert(
            &h.session_id,
            "user",
            &serde_json::to_string(&json!({ "text": text })).unwrap_or_default(),
        );
        h.cmd_tx
            .send(json!({ "op": "user_input", "thread_id": h.thread_id, "text": text }))
            .map_err(|_| "工作台引擎已退出".to_string())?;
        // The engine has no explicit turn-start event; emit it synthetically so
        // the checklist opens a fresh turn and sediment keeps turn boundaries.
        emit_event(&h.app, db, &h.session_id, WorkbenchEvent::TurnStarted);
        Ok(())
    }

    /// Steer while a turn is running: codex queues mid-turn user input and
    /// applies it to the current run (desktop "queue" semantics).
    pub async fn steer(&self, text: String) -> Result<(), String> {
        let g = self.inner.lock().await;
        let h = g.as_ref().ok_or_else(|| "工作台未启动".to_string())?;
        h.cmd_tx
            .send(json!({ "op": "user_input", "thread_id": h.thread_id, "text": text }))
            .map_err(|_| "工作台引擎已退出".to_string())
    }

    /// Abort the current turn.
    pub async fn abort(&self) -> Result<(), String> {
        let g = self.inner.lock().await;
        let h = g.as_ref().ok_or_else(|| "工作台未启动".to_string())?;
        h.cmd_tx
            .send(json!({ "op": "interrupt", "thread_id": h.thread_id }))
            .map_err(|_| "工作台引擎已退出".to_string())
    }

    /// Switch model/provider. The provider/model live in the generated
    /// CODEX_HOME, so this restarts the engine against the same cwd.
    pub async fn set_model(
        &self,
        db: Arc<Db>,
        app: AppHandle,
        provider_id: Option<String>,
        model: String,
    ) -> Result<WorkbenchOpenResult, String> {
        let cwd = {
            let g = self.inner.lock().await;
            g.as_ref().map(|h| h.cwd.clone())
        }
        .ok_or_else(|| "工作台未启动".to_string())?;
        self.open(db, app, cwd, provider_id, model).await
    }

    /// Latest accumulated usage (persisted continuously by the reader task).
    pub async fn stats(&self, _db: &Arc<Db>) -> Result<WorkbenchStats, String> {
        let stats = {
            let g = self.inner.lock().await;
            let h = g.as_ref().ok_or_else(|| "工作台未启动".to_string())?;
            h.stats.clone()
        };
        let snapshot = stats.lock().await.clone();
        Ok(snapshot)
    }

    /// Export the session transcript to a standalone dark-theme HTML file.
    pub async fn export_html(&self, db: &Arc<Db>) -> Result<String, String> {
        let sid = self.session_id().await?;
        let rows = db.workbench_entries(&sid).map_err(|e| e.to_string())?;
        let html = render_export_html(&sid, &rows);
        let path = std::env::temp_dir().join(format!("agentboard-workbench-{sid}.html"));
        tokio::fs::write(&path, html)
            .await
            .map_err(|e| format!("写出 HTML 失败: {e}"))?;
        let path = path.to_string_lossy().to_string();
        let _ = db.workbench_session_set_export(&sid, &path);
        Ok(path)
    }

    /// Close the current session (graceful stdin-close + taskkill fallback).
    pub async fn close(&self) {
        let handle = self.inner.lock().await.take();
        if let Some(h) = handle {
            // Signal supervisor to kill; dropping cmd_tx closes stdin gracefully.
            let _ = h.stop_tx.send(true);
            drop(h.cmd_tx);
            // Cleanup temp CODEX_HOME (best-effort).
            let dir = h.codex_home.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let _ = tokio::fs::remove_dir_all(&dir).await;
            });
        }
    }

    async fn session_id(&self) -> Result<String, String> {
        self.inner
            .lock()
            .await
            .as_ref()
            .map(|h| h.session_id.clone())
            .ok_or_else(|| "工作台未启动".to_string())
    }
}

// ── Spawn + reader plumbing ─────────────────────────────────────────────────

async fn spawn_engine(
    db: Arc<Db>,
    app: AppHandle,
    cwd: String,
    provider_id: String,
    model: String,
) -> Result<EngineHandle, String> {
    use std::process::Stdio;
    use tokio::process::Command;

    let engine_bin = resolve_engine_bin(&db, Some(&app))?;
    let codex_exe = resolve_codex_exe(&db, Some(&app)).await?;
    let (base_url, key, _wire_api) = resolve_provider_creds(&db, &provider_id)?;
    let cwd = normalize_spawn_path(Path::new(&cwd))
        .to_string_lossy()
        .to_string();

    // Build a temp CODEX_HOME with a generated config.toml (no key on disk).
    let codex_home = std::env::temp_dir()
        .join("agentboard-wb")
        .join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&codex_home)
        .await
        .map_err(|e| format!("创建引擎配置目录失败: {e}"))?;
    tokio::fs::write(
        codex_home.join("config.toml"),
        build_config_toml(&base_url, &model),
    )
    .await
    .map_err(|e| format!("写入引擎配置失败: {e}"))?;

    let mut child = Command::new(&engine_bin)
        .args(["--codex-exe", &codex_exe])
        .current_dir(&cwd)
        .env("CODEX_HOME", &codex_home)
        .env(KEY_ENV, &key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            format!(
                "启动工作台引擎失败: {e}（engine={}, cwd={cwd}）",
                engine_bin.display()
            )
        })?;

    let child_id = child.id();
    let mut stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // Ring buffer of recent stderr lines (for handshake failure diagnostics).
    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let mut t = tail.lock().await;
                t.push(l);
                if t.len() > 20 {
                    t.remove(0);
                }
            }
        });
    }

    // Writer task: serialize command values as JSON lines to stdin.
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        while let Some(v) = cmd_rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
        // Channel closed → drop stdin → engine shuts down gracefully.
    });

    // Kick off the thread. The workbench trusts the user-picked folder the
    // same way the pi engine ran with `--approve` (full access, no prompts).
    let _ = cmd_tx.send(json!({
        "op": "start_thread",
        "cwd": cwd,
        "model": model,
        "sandbox": "danger-full-access",
    }));

    // Handshake: wait for thread_started (or a config/auth error).
    let mut reader = BufReader::new(stdout).lines();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(HANDSHAKE_TIMEOUT_SECS);
    let thread_id = loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let next = tokio::time::timeout(remaining, reader.next_line()).await;
        let line = match next {
            Ok(Ok(Some(line))) => line,
            _ => {
                kill_child_id(child_id).await;
                let _ = child.kill().await;
                let tail = stderr_tail.lock().await.join("\n");
                let _ = tokio::fs::remove_dir_all(&codex_home).await;
                return Err(if tail.trim().is_empty() {
                    format!("工作台引擎启动超时（{HANDSHAKE_TIMEOUT_SECS}s 内无响应）")
                } else {
                    format!("工作台引擎启动失败: {tail}")
                });
            }
        };
        match serde_json::from_str::<EngineEvent>(line.trim()) {
            Ok(EngineEvent::ThreadStarted { thread_id }) => break thread_id,
            Ok(EngineEvent::Error { message }) => {
                kill_child_id(child_id).await;
                let _ = child.kill().await;
                let _ = tokio::fs::remove_dir_all(&codex_home).await;
                return Err(format!("工作台引擎启动失败: {message}"));
            }
            _ => continue, // tolerate other events / noise during startup
        }
    };

    // Persist session row now that the handshake succeeded.
    let session_id = uuid::Uuid::new_v4().to_string();
    let _ = db.workbench_session_create(&session_id, &cwd, &provider_id, &model);
    let _ = db.workbench_session_set_pi_session(&session_id, &thread_id);

    let stats = Arc::new(Mutex::new(WorkbenchStats {
        context_window: CONTEXT_WINDOW,
        ..Default::default()
    }));

    // Reader loop: map engine events to workbench events.
    {
        let app = app.clone();
        let db = db.clone();
        let sid = session_id.clone();
        let stats = stats.clone();
        tokio::spawn(async move {
            let mut ctx = ReaderCtx {
                app,
                db,
                session_id: sid,
                stats,
            };
            while let Ok(Some(line)) = reader.next_line().await {
                handle_engine_line(&line, &mut ctx).await;
            }
        });
    }

    // Supervisor: wait for exit or an explicit stop signal.
    let (stop_tx, mut stop_rx) = watch::channel(false);
    {
        let app = app.clone();
        let sid = session_id.clone();
        let db = db.clone();
        tokio::spawn(async move {
            let exited = tokio::select! {
                status = child.wait() => Some(status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1)),
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        kill_child_id(child_id).await;
                        let _ = child.kill().await;
                        None
                    } else { None }
                }
            };
            let _ = db.workbench_session_end(&sid);
            if let Some(code) = exited {
                emit_event(
                    &app,
                    &db,
                    &sid,
                    WorkbenchEvent::Error {
                        message: format!("工作台引擎已退出（code={code}）"),
                    },
                );
            }
        });
    }

    Ok(EngineHandle {
        session_id,
        thread_id,
        cmd_tx,
        stop_tx,
        codex_home,
        cwd,
        stats,
        app,
    })
}

/// Persist (when applicable) + emit one workbench event.
fn emit_event(app: &AppHandle, db: &Arc<Db>, session_id: &str, event: WorkbenchEvent) {
    if event.persist() {
        if let Ok(payload) = serde_json::to_string(&event) {
            let _ = db.workbench_entry_insert(session_id, event.kind(), &payload);
        }
    }
    let _ = app.emit(
        "workbench-event",
        &WorkbenchEventEnvelope {
            session_id: session_id.to_string(),
            event,
        },
    );
}

/// Per-session reader state.
struct ReaderCtx {
    app: AppHandle,
    db: Arc<Db>,
    session_id: String,
    stats: Arc<Mutex<WorkbenchStats>>,
}

impl ReaderCtx {
    fn emit(&self, event: WorkbenchEvent) {
        emit_event(&self.app, &self.db, &self.session_id, event);
    }
}

/// Map one raw engine stdout JSON line to zero-or-more workbench events.
async fn handle_engine_line(line: &str, ctx: &mut ReaderCtx) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let ev: EngineEvent = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return, // tolerate non-JSON noise
    };
    // Usage mutates accumulated stats (and persists) before emitting.
    if let EngineEvent::Usage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        ..
    } = ev
    {
        let out = {
            let mut s = ctx.stats.lock().await;
            let out = accumulate_usage(&mut s, input_tokens, cached_input_tokens, output_tokens);
            let _ = ctx.db.workbench_stats_upsert(
                &ctx.session_id,
                s.input,
                s.output,
                s.cache_read,
                s.cache_write,
                s.total,
            );
            out
        };
        ctx.emit(out);
        return;
    }
    for out in map_engine_event(ev) {
        ctx.emit(out);
    }
}

/// Pure mapping: one engine event → the workbench events it produces.
/// (Usage is handled separately because it mutates accumulated stats.)
pub(crate) fn map_engine_event(ev: EngineEvent) -> Vec<WorkbenchEvent> {
    match ev {
        EngineEvent::ThreadStarted { .. } | EngineEvent::SessionStarted {} => vec![],
        EngineEvent::AssistantDelta { text } => vec![WorkbenchEvent::AssistantDelta { text }],
        EngineEvent::AssistantMessage { text } => {
            vec![WorkbenchEvent::AssistantMessage { text }]
        }
        EngineEvent::CommandRun {
            cmd,
            exit_code,
            output_tail,
        } => {
            let id = uuid::Uuid::new_v4().to_string();
            vec![
                WorkbenchEvent::ToolStarted {
                    tool_call_id: id.clone(),
                    tool: "bash".to_string(),
                    path: None,
                    cmd: Some(cmd.clone()),
                },
                WorkbenchEvent::ToolBash {
                    tool_call_id: id,
                    cmd,
                    output: output_tail,
                    exit_code: Some(exit_code),
                },
            ]
        }
        EngineEvent::FileEdit {
            path, kind, diff, ..
        } => {
            let id = uuid::Uuid::new_v4().to_string();
            match kind.as_str() {
                "add" => vec![
                    WorkbenchEvent::ToolStarted {
                        tool_call_id: id.clone(),
                        tool: "write".to_string(),
                        path: Some(path.clone()),
                        cmd: None,
                    },
                    WorkbenchEvent::ToolWrite {
                        tool_call_id: id,
                        path,
                    },
                ],
                "delete" => vec![
                    WorkbenchEvent::ToolStarted {
                        tool_call_id: id.clone(),
                        tool: "delete".to_string(),
                        path: Some(path.clone()),
                        cmd: None,
                    },
                    WorkbenchEvent::ToolResult {
                        tool_call_id: id,
                        tool: "delete".to_string(),
                        output: path,
                        is_error: false,
                    },
                ],
                _ => vec![
                    WorkbenchEvent::ToolStarted {
                        tool_call_id: id.clone(),
                        tool: "edit".to_string(),
                        path: Some(path.clone()),
                        cmd: None,
                    },
                    WorkbenchEvent::ToolEdit {
                        tool_call_id: id,
                        path,
                        diff: diff.unwrap_or_default(),
                    },
                ],
            }
        }
        // Usage never reaches this mapping — the reader intercepts it and
        // routes it through accumulate_usage() (stats mutation + persist).
        EngineEvent::Usage { .. } => vec![],
        EngineEvent::TurnCompleted {} => vec![WorkbenchEvent::TurnCompleted],
        EngineEvent::Error { message } => vec![WorkbenchEvent::Error { message }],
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Accumulate one engine usage event into the session stats; returns the
/// TokenStats event to emit.
fn accumulate_usage(
    stats: &mut WorkbenchStats,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
) -> WorkbenchEvent {
    stats.input += input_tokens as i64;
    stats.cache_read += cached_input_tokens as i64;
    stats.output += output_tokens as i64;
    stats.total = stats.input + stats.output;
    // Latest turn's input ≈ current context size.
    stats.context_tokens = (input_tokens + output_tokens) as i64;
    stats.context_window = CONTEXT_WINDOW;
    stats.context_percent = if CONTEXT_WINDOW > 0 {
        (stats.context_tokens as f64 / CONTEXT_WINDOW as f64) * 100.0
    } else {
        0.0
    };
    WorkbenchEvent::TokenStats {
        input: stats.input,
        output: stats.output,
        cache_read: stats.cache_read,
        cache_write: stats.cache_write,
        total: stats.total,
        cost: stats.cost,
        context_tokens: stats.context_tokens,
        context_window: stats.context_window,
        context_percent: stats.context_percent,
    }
}

/// Generate the temp-CODEX_HOME `config.toml`. The API key is an `env_key`
/// *reference* — the plaintext never lands on disk.
fn build_config_toml(base_url: &str, model: &str) -> String {
    format!(
        r#"model = "{model}"
model_provider = "agentboard"
disable_response_storage = true

[model_providers.agentboard]
name = "AgentBoard"
base_url = "{base}"
wire_api = "responses"
env_key = "{key_env}"
"#,
        model = model.replace('"', ""),
        base = normalize_base_url(base_url),
        key_env = KEY_ENV,
    )
}

/// Normalize a provider base_url to the `…/v1` form codex expects.
fn normalize_base_url(base_url: &str) -> String {
    let b = base_url.trim().trim_end_matches('/');
    let root = b.strip_suffix("/v1").unwrap_or(b);
    format!("{root}/v1")
}

/// Resolve the effective provider id (explicit → default setting).
fn resolve_provider_id(db: &Db, provider_id: Option<String>) -> Result<String, String> {
    if let Some(p) = provider_id.filter(|p| !p.trim().is_empty()) {
        return Ok(p);
    }
    db.settings_get("default_provider_id")
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "未选择服务商，且没有默认服务商".to_string())
}

/// Resolve `(base_url, api_key, wire_api)` for a provider (key from OS store).
fn resolve_provider_creds(db: &Db, provider_id: &str) -> Result<(String, String, String), String> {
    let row = db
        .provider_get(provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("服务商不存在: {provider_id}"))?;
    let key = crate::providers::key_get(provider_id)?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| "该服务商未设置 API Key".to_string())?;
    Ok((row.base_url, key, row.wire_api))
}

/// Resolve the engine binary: settings override → bundled resource path
/// (installed app) → dev default. Errors clearly when none exist.
fn resolve_engine_bin(db: &Db, app: Option<&AppHandle>) -> Result<PathBuf, String> {
    if let Ok(Some(p)) = db.settings_get("engine_bin_path") {
        let p = p.trim().to_string();
        if !p.is_empty() {
            let pb = PathBuf::from(&p);
            if pb.exists() {
                return Ok(pb);
            }
            return Err(format!("配置的 engine_bin_path 不存在: {p}"));
        }
    }
    #[cfg(windows)]
    let name = "agentboard-engine.exe";
    #[cfg(not(windows))]
    let name = "agentboard-engine";
    if let Some(app) = app {
        if let Ok(res) = app.path().resolve(name, BaseDirectory::Resource) {
            if res.exists() {
                return Ok(res);
            }
        }
    }
    let dev = PathBuf::from("..")
        .join("engine")
        .join("target")
        .join("release")
        .join(name);
    if dev.exists() {
        return Ok(dev);
    }
    Err("找不到 agentboard-engine，请重新安装应用或在设置中指定 engine_bin_path".to_string())
}

/// Resolve codex.exe for the engine's exec-server: settings override →
/// bundled resource (`engine-codex/codex.exe`) → shared locator (desktop
/// install / npm vendor / PATH).
async fn resolve_codex_exe(db: &Db, app: Option<&AppHandle>) -> Result<String, String> {
    let explicit = db
        .settings_get("codex_exe_path")
        .unwrap_or(None)
        .filter(|s| !s.trim().is_empty());
    if let Some(p) = &explicit {
        if PathBuf::from(p).exists() {
            return Ok(p.clone());
        }
    }
    if let Some(app) = app {
        if let Ok(res) = app
            .path()
            .resolve("engine-codex/codex.exe", BaseDirectory::Resource)
        {
            if res.exists() {
                return Ok(normalize_spawn_path(&res).to_string_lossy().to_string());
            }
        }
    }
    locate_codex_exe(None).await
}

/// Normalize a path handed to child processes / config files into a plain
/// Windows absolute path (verbatim prefix stripped, forward slashes fixed,
/// bare drive completed). Non-Windows: unchanged.
fn normalize_spawn_path(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        let s = s.trim();
        let mut s = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            s.to_string()
        };
        s = s.replace('/', "\\");
        let b = s.as_bytes();
        if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            s.push('\\');
        }
        PathBuf::from(s)
    }
    #[cfg(not(windows))]
    {
        p.to_path_buf()
    }
}

/// Best-effort Windows taskkill of the engine process tree.
async fn kill_child_id(child_id: Option<u32>) {
    #[cfg(windows)]
    if let Some(pid) = child_id {
        let _ = tokio::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output()
            .await;
    }
    #[cfg(not(windows))]
    let _ = child_id;
}

// ── HTML export ─────────────────────────────────────────────────────────────

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Render the persisted entry stream as a standalone dark-theme HTML page.
fn render_export_html(session_id: &str, rows: &[crate::db::WorkbenchEntryRow]) -> String {
    let mut body = String::new();
    for row in rows {
        let payload: Value = serde_json::from_str(&row.payload_json).unwrap_or(Value::Null);
        let text = |k: &str| payload.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let block = match row.kind.as_str() {
            "user" => format!(
                r#"<div class="entry user"><div class="tag">用户</div><pre>{}</pre></div>"#,
                html_escape(&text("text"))
            ),
            "assistant_message" => format!(
                r#"<div class="entry assistant"><div class="tag">助手</div><pre>{}</pre></div>"#,
                html_escape(&text("text"))
            ),
            "tool_bash" => format!(
                r#"<div class="entry tool"><div class="tag">命令 {}</div><pre>{}</pre></div>"#,
                html_escape(&text("cmd")),
                html_escape(&text("output"))
            ),
            "tool_edit" => format!(
                r#"<div class="entry tool"><div class="tag">编辑 {}</div><pre>{}</pre></div>"#,
                html_escape(&text("path")),
                html_escape(&text("diff"))
            ),
            "tool_write" => format!(
                r#"<div class="entry tool"><div class="tag">写入 {}</div></div>"#,
                html_escape(&text("path"))
            ),
            "error" => format!(
                r#"<div class="entry error"><div class="tag">错误</div><pre>{}</pre></div>"#,
                html_escape(&text("message"))
            ),
            _ => continue,
        };
        body.push_str(&block);
        body.push('\n');
    }
    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>AgentBoard 工作台会话 {sid}</title>
<style>
body {{ background:#111418; color:#d7dae0; font-family:Consolas,'Microsoft YaHei',monospace; max-width:960px; margin:2rem auto; padding:0 1rem; }}
.entry {{ border:1px solid #22262c; border-radius:8px; margin:0.8rem 0; padding:0.6rem 0.9rem; background:#171a1f; }}
.entry.user {{ border-color:#2a3f5f; }}
.entry.error {{ border-color:#5f2a2a; }}
.tag {{ color:#7f8ea3; font-size:12px; margin-bottom:0.35rem; }}
pre {{ white-space:pre-wrap; word-break:break-word; margin:0; }}
</style></head><body>
<h2>AgentBoard 工作台会话</h2>
<div class="tag">session: {sid}</div>
{body}
</body></html>
"#,
        sid = html_escape(session_id),
        body = body
    )
}

// ── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> EngineEvent {
        serde_json::from_str(line).expect("deserialize EngineEvent")
    }

    #[cfg(windows)]
    #[test]
    fn normalize_spawn_path_fixes_bare_drive_slashes_and_verbatim() {
        let n = |s: &str| {
            normalize_spawn_path(Path::new(s))
                .to_string_lossy()
                .to_string()
        };
        assert_eq!(n("D:"), r"D:\");
        assert_eq!(n("D:/some/dir"), r"D:\some\dir");
        assert_eq!(n(r"D:\some\dir"), r"D:\some\dir");
        assert_eq!(n(r"\\?\D:\some\dir"), r"D:\some\dir");
        assert_eq!(n(r"\\?\UNC\srv\share\d"), r"\\srv\share\d");
    }

    #[test]
    fn normalize_base_url_variants() {
        assert_eq!(normalize_base_url("https://x.com"), "https://x.com/v1");
        assert_eq!(normalize_base_url("https://x.com/"), "https://x.com/v1");
        assert_eq!(normalize_base_url("https://x.com/v1"), "https://x.com/v1");
        assert_eq!(normalize_base_url("https://x.com/v1/"), "https://x.com/v1");
    }

    #[test]
    fn config_toml_references_env_key_not_plaintext() {
        let t = build_config_toml("https://relay.example.com", "gpt-5.5");
        assert!(t.contains(r#"model = "gpt-5.5""#));
        assert!(t.contains(r#"base_url = "https://relay.example.com/v1""#));
        // codex ≥0.13x only supports the responses wire.
        assert!(t.contains(r#"wire_api = "responses""#));
        // The key must be an env reference, never a literal secret.
        assert!(t.contains(&format!(r#"env_key = "{KEY_ENV}""#)));
        assert!(!t.to_lowercase().contains("sk-"));
    }

    #[test]
    fn command_run_maps_to_started_plus_bash() {
        let ev = parse(
            r#"{"type":"command_run","thread_id":"t","cmd":"ls -la","exit_code":0,"output_tail":"a\nb"}"#,
        );
        let out = map_engine_event(ev);
        assert_eq!(out.len(), 2);
        match (&out[0], &out[1]) {
            (
                WorkbenchEvent::ToolStarted { tool, cmd, tool_call_id: id0, .. },
                WorkbenchEvent::ToolBash { cmd: cmd2, output, exit_code, tool_call_id: id1 },
            ) => {
                assert_eq!(tool, "bash");
                assert_eq!(cmd.as_deref(), Some("ls -la"));
                assert_eq!(cmd2, "ls -la");
                assert_eq!(output, "a\nb");
                assert_eq!(*exit_code, Some(0));
                assert_eq!(id0, id1, "started/end share the tool_call_id");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn file_edit_add_maps_to_write() {
        let ev = parse(
            r#"{"type":"file_edit","thread_id":"t","path":"D:\\w\\hello.txt","kind":"add","added":1,"removed":0}"#,
        );
        let out = map_engine_event(ev);
        assert_eq!(out.len(), 2);
        assert!(matches!(&out[0], WorkbenchEvent::ToolStarted { tool, .. } if tool == "write"));
        assert!(
            matches!(&out[1], WorkbenchEvent::ToolWrite { path, .. } if path == r"D:\w\hello.txt")
        );
    }

    #[test]
    fn file_edit_update_maps_to_edit_with_diff() {
        let ev = parse(
            r#"{"type":"file_edit","thread_id":"t","path":"/x.rs","kind":"update","diff":"@@\n+a\n-b","added":1,"removed":1}"#,
        );
        let out = map_engine_event(ev);
        assert!(matches!(&out[0], WorkbenchEvent::ToolStarted { tool, .. } if tool == "edit"));
        match &out[1] {
            WorkbenchEvent::ToolEdit { path, diff, .. } => {
                assert_eq!(path, "/x.rs");
                assert_eq!(diff, "@@\n+a\n-b");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn file_edit_delete_maps_to_result() {
        let ev = parse(
            r#"{"type":"file_edit","thread_id":"t","path":"/gone.txt","kind":"delete","added":0,"removed":3}"#,
        );
        let out = map_engine_event(ev);
        assert!(
            matches!(&out[1], WorkbenchEvent::ToolResult { tool, output, is_error, .. }
                if tool == "delete" && output == "/gone.txt" && !is_error)
        );
    }

    #[test]
    fn assistant_turn_error_events_map_directly() {
        assert!(matches!(
            map_engine_event(parse(r#"{"type":"assistant_delta","thread_id":"t","text":"he"}"#))
                .as_slice(),
            [WorkbenchEvent::AssistantDelta { text }] if text == "he"
        ));
        assert!(matches!(
            map_engine_event(parse(r#"{"type":"turn_completed","thread_id":"t"}"#)).as_slice(),
            [WorkbenchEvent::TurnCompleted]
        ));
        assert!(matches!(
            map_engine_event(parse(r#"{"type":"error","thread_id":"t","message":"boom"}"#))
                .as_slice(),
            [WorkbenchEvent::Error { message }] if message == "boom"
        ));
        // Startup events are folded away.
        assert!(map_engine_event(parse(r#"{"type":"thread_started","thread_id":"t"}"#)).is_empty());
    }

    #[test]
    fn accumulate_usage_tracks_totals_and_context() {
        let mut s = WorkbenchStats::default();
        let ev = accumulate_usage(&mut s, 9777, 1920, 52);
        assert_eq!(s.input, 9777);
        assert_eq!(s.cache_read, 1920);
        assert_eq!(s.output, 52);
        assert_eq!(s.total, 9829);
        match ev {
            WorkbenchEvent::TokenStats { total, context_tokens, context_window, .. } => {
                assert_eq!(total, 9829);
                assert_eq!(context_tokens, 9829);
                assert_eq!(context_window, CONTEXT_WINDOW);
            }
            other => panic!("unexpected: {other:?}"),
        }
        // Second turn accumulates.
        accumulate_usage(&mut s, 9866, 9600, 6);
        assert_eq!(s.input, 9777 + 9866);
        assert_eq!(s.output, 58);
        assert_eq!(s.total, s.input + s.output);
    }

    #[test]
    fn event_serializes_with_type_tag() {
        let ev = WorkbenchEvent::ToolBash {
            tool_call_id: "c1".into(),
            cmd: "ls".into(),
            output: "a\nb".into(),
            exit_code: Some(0),
        };
        let v: Value = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "tool_bash");
        assert_eq!(v["cmd"], "ls");
        assert_eq!(v["exit_code"], 0);
    }

    #[test]
    fn event_persist_flags() {
        assert!(!WorkbenchEvent::AssistantDelta { text: "x".into() }.persist());
        assert!(!WorkbenchEvent::ToolStarted {
            tool_call_id: "c".into(),
            tool: "bash".into(),
            path: None,
            cmd: None
        }
        .persist());
        assert!(WorkbenchEvent::AssistantMessage { text: "x".into() }.persist());
        assert!(WorkbenchEvent::ToolWrite {
            tool_call_id: "c".into(),
            path: "p".into()
        }
        .persist());
        assert_eq!(WorkbenchEvent::TurnCompleted.kind(), "turn_completed");
    }

    #[test]
    fn export_html_renders_and_escapes() {
        let rows = vec![
            crate::db::WorkbenchEntryRow {
                kind: "user".into(),
                payload_json: r#"{"text":"写个 <b> 标签"}"#.into(),
                ts: 1,
            },
            crate::db::WorkbenchEntryRow {
                kind: "tool_bash".into(),
                payload_json: r#"{"cmd":"echo hi","output":"hi"}"#.into(),
                ts: 2,
            },
        ];
        let html = render_export_html("sid-1", &rows);
        assert!(html.contains("&lt;b&gt;"), "html must be escaped");
        assert!(html.contains("echo hi"));
        assert!(html.contains("sid-1"));
    }

    /// LIVE: drives the real codex engine through the exact product path —
    /// dev engine binary (same file that gets bundled), temp CODEX_HOME with
    /// the generated config.toml, the real default provider's key from the OS
    /// credential store, model gpt-5.5 — and verifies one turn creates
    /// hello.txt with the mapped workbench event sequence.
    ///
    /// Run with:
    /// `cargo test -p agentboard --lib workbench::tests::live_codex_workbench_creates_file -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_codex_workbench_creates_file() {
        use std::process::Stdio;
        use tokio::process::Command;

        let db = Db::open().expect("open db");
        let provider_id = resolve_provider_id(&db, None).expect("default provider");
        let (base_url, key, _wire) =
            resolve_provider_creds(&db, &provider_id).expect("provider creds");
        let engine_bin = resolve_engine_bin(&db, None).expect("engine bin (build ../engine first)");
        let codex_exe = locate_codex_exe(None).await.expect("codex exe");
        let model = "gpt-5.5".to_string();
        println!("[live] provider={provider_id} model={model} engine={}", engine_bin.display());
        println!("[live] codex_exe={codex_exe}");

        let codex_home = std::env::temp_dir().join(format!("wb-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&codex_home).unwrap();
        std::fs::write(codex_home.join("config.toml"), build_config_toml(&base_url, &model))
            .unwrap();
        let work = std::env::temp_dir().join(format!("wb-live-work-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&work).unwrap();

        let mut child = Command::new(&engine_bin)
            .args(["--codex-exe", &codex_exe])
            .current_dir(&work)
            .env("CODEX_HOME", &codex_home)
            .env(KEY_ENV, &key)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn engine");

        let mut stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

        let start = json!({
            "op": "start_thread",
            "cwd": work.to_string_lossy(),
            "model": model,
            "sandbox": "danger-full-access",
        });
        stdin
            .write_all(format!("{start}\n").as_bytes())
            .await
            .unwrap();
        stdin.flush().await.unwrap();

        let mut seen: Vec<String> = Vec::new();
        let mut saw_write = false;
        let mut completed = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let line = match tokio::time::timeout(remaining, lines.next_line()).await {
                Ok(Ok(Some(l))) => l,
                _ => break,
            };
            let ev: EngineEvent = match serde_json::from_str(line.trim()) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let EngineEvent::ThreadStarted { thread_id } = &ev {
                let cmd = json!({
                    "op": "user_input", "thread_id": thread_id,
                    "text": "Create a file named hello.txt in the current directory with exactly the content: hello. Then stop."
                });
                stdin.write_all(format!("{cmd}\n").as_bytes()).await.unwrap();
                stdin.flush().await.unwrap();
                seen.push("thread_started".into());
                continue;
            }
            for out in map_engine_event(ev) {
                let kind = out.kind().to_string();
                if kind != "assistant_delta" {
                    println!("[live-ev] {}", serde_json::to_string(&out).unwrap());
                }
                if kind == "tool_write" {
                    saw_write = true;
                }
                if kind == "turn_completed" {
                    completed = true;
                }
                seen.push(kind);
            }
            if completed {
                break;
            }
        }

        let target = work.join("hello.txt");
        let created = target.exists();
        let content = std::fs::read_to_string(&target).unwrap_or_default();
        println!("[live] hello.txt exists={created} content={content:?}");
        println!("[live] event kinds: {seen:?}");
        let _ = stdin.shutdown().await;
        kill_child_id(child.id()).await;
        let _ = child.kill().await;
        let _ = std::fs::remove_dir_all(&codex_home);
        let _ = std::fs::remove_dir_all(&work);

        assert!(completed, "turn must complete");
        assert!(saw_write, "must observe a mapped tool_write event");
        assert!(created, "engine must create hello.txt");
        assert!(content.trim() == "hello", "content must be hello: {content:?}");
    }
}
