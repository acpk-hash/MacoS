//! Local workbench engine (F4a): manages a `pi` (@earendil-works/pi-coding-agent)
//! sidecar in **RPC mode** and bridges its JSON event stream to the frontend.
//!
//! ## Why pi RPC mode (not `pi -p`)
//! `pi --mode rpc` is a long-lived, bidirectional JSON-lines protocol built for
//! embedding: one JSON `RpcCommand` per line on stdin, one JSON event/response
//! per line on stdout, logs on stderr. This avoids the historical `pi -p`
//! one-shot hang (see memory `pi-background-stall-sonnet-fallback`).
//!
//! ## Provider / credential injection (never touches disk or logs)
//! pi resolves models from a `models.json` in its *agent dir*
//! (`$PI_CODING_AGENT_DIR`). We spawn each session against a **temp** agent dir
//! containing a generated `models.json` that defines one provider `agentboard`
//! pointing at the F1-selected provider's `base_url`, with
//! `"apiKey": "$AGENTBOARD_PI_KEY"` — a *reference*, not the key. The real key is
//! injected only as the `AGENTBOARD_PI_KEY` environment variable of the child
//! process. The plaintext key never lands in `models.json`, SQLite, logs, or the
//! frontend.
//!
//! ## Protocol facts (verified live against pi 0.80.3, 2026-07-07)
//! - Start: `node <cli.js> --mode rpc --provider agentboard --model <id> -a`,
//!   cwd = user workdir, env `PI_CODING_AGENT_DIR` + `AGENTBOARD_PI_KEY`.
//! - stdout events observed: `response`(command ack / data), `agent_start`,
//!   `turn_start`, `turn_end`, `agent_end`, `message_start`/`message_end`,
//!   `message_update`{assistantMessageEvent: text_delta/text_end/thinking_delta/
//!   toolcall_*}, `tool_execution_start`{toolName,args}, `tool_execution_end`
//!   {toolName,result,isError}.
//! - Tool args: write `{path,content}`, edit `{path,edits:[{oldText,newText}]}`,
//!   bash `{command,timeout?}`.
//! - `get_session_stats` → data.tokens{input,output,cacheRead,cacheWrite,total},
//!   data.cost, data.contextUsage{tokens,contextWindow,percent}, data.sessionId.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

use crate::db::Db;

const HANDSHAKE_TIMEOUT_SECS: u64 = 20;
/// Env var name referenced by the generated `models.json` (value = the key).
const KEY_ENV: &str = "AGENTBOARD_PI_KEY";

// ── Frontend-facing event model ─────────────────────────────────────────────

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
    /// A tool call has begun (drives the progress bar: "正在编辑 x" / "运行命令").
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
    /// edit tool finished (path + a human-readable edit summary/diff).
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
    /// Any other tool (read/grep/find/ls/…) finished.
    ToolResult {
        tool_call_id: String,
        tool: String,
        output: String,
        is_error: bool,
    },
    /// Token usage snapshot (emitted after each turn + on demand).
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
    /// The pi engine exited or a fatal protocol error occurred.
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

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

/// One live pi RPC session.
struct PiHandle {
    session_id: String,
    /// Sends `RpcCommand` JSON values to the writer task → child stdin.
    cmd_tx: mpsc::UnboundedSender<Value>,
    /// Correlated request → response map (for stats/models/export).
    pending: PendingMap,
    /// Signals the supervisor task to kill the child (taskkill + kill).
    stop_tx: watch::Sender<bool>,
    /// Temp agent dir (holds generated models.json); removed on close.
    agent_dir: PathBuf,
    /// Working directory — reused by `set_model` when restarting the engine.
    cwd: String,
}

/// Manages the single active workbench pi engine.
pub struct PiEngine {
    inner: Arc<Mutex<Option<PiHandle>>>,
}

impl Default for PiEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PiEngine {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    /// Open a workbench session: spawn pi RPC against `dir` using the F1
    /// provider `provider_id` (or the default) and `model`. Closes any existing
    /// session first.
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
        if dir.trim().is_empty() || !std::path::Path::new(&dir).is_dir() {
            return Err(format!("工作目录不存在: {dir}"));
        }

        let handle = spawn_pi(db, app, dir.clone(), provider_id.clone(), model.clone()).await?;
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
            .send(json!({ "type": "prompt", "message": text }))
            .map_err(|_| "工作台进程已退出".to_string())
    }

    /// Steer the current running turn (interrupt with a new instruction).
    pub async fn steer(&self, text: String) -> Result<(), String> {
        let g = self.inner.lock().await;
        let h = g.as_ref().ok_or_else(|| "工作台未启动".to_string())?;
        h.cmd_tx
            .send(json!({ "type": "steer", "message": text }))
            .map_err(|_| "工作台进程已退出".to_string())
    }

    /// Abort the current turn.
    pub async fn abort(&self) -> Result<(), String> {
        let g = self.inner.lock().await;
        let h = g.as_ref().ok_or_else(|| "工作台未启动".to_string())?;
        h.cmd_tx
            .send(json!({ "type": "abort" }))
            .map_err(|_| "工作台进程已退出".to_string())
    }

    /// Switch model/provider. Because a provider change implies a different
    /// base_url/key (and pi's model registry is fixed at spawn), this restarts
    /// the engine against the same cwd with a fresh pi session.
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

    /// Round-trip `get_session_stats`, persist + return the latest usage.
    pub async fn stats(&self, db: &Arc<Db>) -> Result<WorkbenchStats, String> {
        let data = self.request("get_session_stats", json!({})).await?;
        let (stats, _pi_session) = parse_stats(&data);
        let _ = db.workbench_stats_upsert(
            &self.session_id().await?,
            stats.input,
            stats.output,
            stats.cache_read,
            stats.cache_write,
            stats.total,
        );
        Ok(stats)
    }

    /// List models available to the pi engine.
    pub async fn models(&self) -> Result<Vec<WorkbenchModel>, String> {
        let data = self.request("get_available_models", json!({})).await?;
        let mut out = Vec::new();
        if let Some(arr) = data.get("models").and_then(|m| m.as_array()) {
            for m in arr {
                let provider = m.get("provider").and_then(|v| v.as_str()).unwrap_or("");
                let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if !id.is_empty() {
                    out.push(WorkbenchModel {
                        provider: provider.to_string(),
                        id: id.to_string(),
                    });
                }
            }
        }
        Ok(out)
    }

    /// Export the session transcript to HTML; records the path in the DB.
    pub async fn export_html(&self, db: &Arc<Db>) -> Result<String, String> {
        let data = self.request("export_html", json!({})).await?;
        let path = data
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if let Ok(sid) = self.session_id().await {
            let _ = db.workbench_session_set_export(&sid, &path);
        }
        Ok(path)
    }

    /// Close the current session (graceful stdin-close + taskkill fallback).
    pub async fn close(&self) {
        let handle = self.inner.lock().await.take();
        if let Some(h) = handle {
            // Signal supervisor to kill; dropping cmd_tx closes stdin gracefully.
            let _ = h.stop_tx.send(true);
            drop(h.cmd_tx);
            // Cleanup temp agent dir (best-effort).
            let dir = h.agent_dir.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
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

    /// Send a correlated command and await its `response.data` (10s timeout).
    async fn request(&self, cmd_type: &str, mut extra: Value) -> Result<Value, String> {
        let (tx, pending, id) = {
            let g = self.inner.lock().await;
            let h = g.as_ref().ok_or_else(|| "工作台未启动".to_string())?;
            let id = uuid::Uuid::new_v4().to_string();
            (h.cmd_tx.clone(), h.pending.clone(), id)
        };
        let (otx, orx) = oneshot::channel();
        pending.lock().await.insert(id.clone(), otx);

        if !extra.is_object() {
            extra = json!({});
        }
        extra["type"] = json!(cmd_type);
        extra["id"] = json!(id);
        tx.send(extra).map_err(|_| "工作台进程已退出".to_string())?;

        match tokio::time::timeout(Duration::from_secs(10), orx).await {
            Ok(Ok(data)) => Ok(data),
            Ok(Err(_)) => Err("工作台响应通道已关闭".to_string()),
            Err(_) => {
                pending.lock().await.remove(&id);
                Err(format!("命令 {cmd_type} 超时"))
            }
        }
    }
}

// ── Spawn + reader plumbing ─────────────────────────────────────────────────

async fn spawn_pi(
    db: Arc<Db>,
    app: AppHandle,
    cwd: String,
    provider_id: String,
    model: String,
) -> Result<PiHandle, String> {
    use std::process::Stdio;
    use tokio::process::Command;

    let (node_program, cli) = resolve_pi_runtime(&db, &app)?;
    let (base_url, key, wire_api) = resolve_provider_creds(&db, &provider_id)?;

    // Build a temp agent dir with a generated models.json (no key on disk).
    let agent_dir = std::env::temp_dir()
        .join("agentboard-pi")
        .join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&agent_dir)
        .await
        .map_err(|e| format!("创建 pi 配置目录失败: {e}"))?;
    let models_json = build_models_json(&base_url, &model, &wire_api);
    tokio::fs::write(agent_dir.join("models.json"), models_json)
        .await
        .map_err(|e| format!("写入 models.json 失败: {e}"))?;

    let mut child = Command::new(&node_program)
        .arg(&cli)
        .args([
            "--mode",
            "rpc",
            "--provider",
            "agentboard",
            "--model",
            &model,
            // Trust the user-selected project dir (avoids a trust stall in RPC).
            "--approve",
        ])
        .current_dir(&cwd)
        .env("PI_CODING_AGENT_DIR", &agent_dir)
        .env(KEY_ENV, &key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("启动 pi 失败（node 未安装？）: {e}"))?;

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
        // Channel closed → drop stdin → pi shuts down gracefully.
    });

    // Handshake: probe get_state and wait for the first stdout line.
    let session_id = uuid::Uuid::new_v4().to_string();
    let _ = cmd_tx.send(json!({ "type": "get_state", "id": "handshake" }));

    let mut reader = BufReader::new(stdout).lines();
    let first = tokio::time::timeout(
        Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
        reader.next_line(),
    )
    .await;

    let first_line = match first {
        Ok(Ok(Some(line))) => line,
        _ => {
            // Timed out or stream closed: kill child, surface stderr tail.
            kill_child_id(child_id).await;
            let _ = child.kill().await;
            let tail = stderr_tail.lock().await.join("\n");
            let _ = tokio::fs::remove_dir_all(&agent_dir).await;
            return Err(if tail.trim().is_empty() {
                format!("pi 启动超时（{HANDSHAKE_TIMEOUT_SECS}s 内无响应）")
            } else {
                format!("pi 启动失败: {tail}")
            });
        }
    };

    // Persist session row now that the handshake succeeded.
    let _ = db.workbench_session_create(&session_id, &cwd, &provider_id, &model);

    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

    // Reader loop: process the handshake line, then stream events.
    {
        let app = app.clone();
        let db = db.clone();
        let sid = session_id.clone();
        let cmd_tx2 = cmd_tx.clone();
        let pending2 = pending.clone();
        tokio::spawn(async move {
            let mut ctx = ReaderCtx {
                app,
                db,
                session_id: sid,
                cmd_tx: cmd_tx2,
                pending: pending2,
                tools: HashMap::new(),
            };
            handle_pi_line(&first_line, &mut ctx).await;
            while let Ok(Some(line)) = reader.next_line().await {
                handle_pi_line(&line, &mut ctx).await;
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
                let ev = WorkbenchEvent::Error {
                    message: format!("pi 进程已退出（code={code}）"),
                };
                let _ = app.emit(
                    "workbench-event",
                    &WorkbenchEventEnvelope {
                        session_id: sid.clone(),
                        event: ev,
                    },
                );
            }
        });
    }

    Ok(PiHandle {
        session_id,
        cmd_tx,
        pending,
        stop_tx,
        agent_dir,
        cwd,
    })
}

/// Per-session reader state.
struct ReaderCtx {
    app: AppHandle,
    db: Arc<Db>,
    session_id: String,
    cmd_tx: mpsc::UnboundedSender<Value>,
    pending: PendingMap,
    /// toolCallId → (toolName, args) recorded at tool_execution_start.
    tools: HashMap<String, (String, Value)>,
}

impl ReaderCtx {
    fn emit(&self, event: WorkbenchEvent) {
        if event.persist() {
            if let Ok(payload) = serde_json::to_string(&event) {
                let _ = self
                    .db
                    .workbench_entry_insert(&self.session_id, event.kind(), &payload);
            }
        }
        let _ = self.app.emit(
            "workbench-event",
            &WorkbenchEventEnvelope {
                session_id: self.session_id.clone(),
                event,
            },
        );
    }
}

/// Map one raw pi stdout JSON line to zero-or-more `WorkbenchEvent`s.
async fn handle_pi_line(line: &str, ctx: &mut ReaderCtx) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let ev: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return, // tolerate non-JSON noise
    };
    let ty = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match ty {
        "response" => handle_response(&ev, ctx).await,
        "agent_start" => ctx.emit(WorkbenchEvent::TurnStarted),
        "agent_end" => {
            // `willRetry` means the turn isn't really done yet.
            let will_retry = ev
                .get("willRetry")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !will_retry {
                ctx.emit(WorkbenchEvent::TurnCompleted);
                // Refresh token usage after every completed turn.
                let _ = ctx
                    .cmd_tx
                    .send(json!({ "type": "get_session_stats", "id": "auto-stats" }));
            }
        }
        "message_update" => {
            if let Some(ame) = ev.get("assistantMessageEvent") {
                match ame.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "text_delta" => {
                        if let Some(d) = ame.get("delta").and_then(|v| v.as_str()) {
                            ctx.emit(WorkbenchEvent::AssistantDelta { text: d.to_string() });
                        }
                    }
                    "text_end" => {
                        if let Some(c) = ame.get("content").and_then(|v| v.as_str()) {
                            ctx.emit(WorkbenchEvent::AssistantMessage { text: c.to_string() });
                        }
                    }
                    "thinking_delta" => {
                        if let Some(d) = ame.get("delta").and_then(|v| v.as_str()) {
                            ctx.emit(WorkbenchEvent::Thinking { text: d.to_string() });
                        }
                    }
                    _ => {}
                }
            }
        }
        "tool_execution_start" => {
            let id = ev
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name = ev
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let args = ev.get("args").cloned().unwrap_or(Value::Null);
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let cmd = args
                .get("command")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            ctx.tools.insert(id.clone(), (name.clone(), args));
            ctx.emit(WorkbenchEvent::ToolStarted {
                tool_call_id: id,
                tool: name,
                path,
                cmd,
            });
        }
        "tool_execution_end" => {
            let id = ev
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name = ev
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let is_error = ev.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
            let output = extract_tool_output(ev.get("result"));
            let (_, args) = ctx
                .tools
                .remove(&id)
                .unwrap_or_else(|| (name.clone(), Value::Null));

            match name.as_str() {
                "bash" => {
                    let cmd = args
                        .get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let exit_code = ev
                        .get("result")
                        .and_then(|r| r.get("details"))
                        .and_then(|d| d.get("exitCode").or_else(|| d.get("exit_code")))
                        .and_then(|v| v.as_i64());
                    ctx.emit(WorkbenchEvent::ToolBash {
                        tool_call_id: id,
                        cmd,
                        output,
                        exit_code,
                    });
                }
                "write" => {
                    let path = args
                        .get("path")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    ctx.emit(WorkbenchEvent::ToolWrite {
                        tool_call_id: id,
                        path,
                    });
                }
                "edit" => {
                    let path = args
                        .get("path")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    ctx.emit(WorkbenchEvent::ToolEdit {
                        tool_call_id: id,
                        path,
                        diff: summarize_edits(&args),
                    });
                }
                _ => {
                    ctx.emit(WorkbenchEvent::ToolResult {
                        tool_call_id: id,
                        tool: name,
                        output,
                        is_error,
                    });
                }
            }
        }
        "extension_error" => {
            let msg = ev
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("extension error")
                .to_string();
            ctx.emit(WorkbenchEvent::Error { message: msg });
        }
        _ => {}
    }
}

async fn handle_response(ev: &Value, ctx: &mut ReaderCtx) {
    let command = ev.get("command").and_then(|v| v.as_str()).unwrap_or("");
    let success = ev.get("success").and_then(|v| v.as_bool()).unwrap_or(true);
    let id = ev.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());

    if !success {
        let msg = ev
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误")
            .to_string();
        ctx.emit(WorkbenchEvent::Error {
            message: format!("{command}: {msg}"),
        });
        // Still resolve any pending waiter so callers don't hang.
        if let Some(id) = id {
            if let Some(tx) = ctx.pending.lock().await.remove(&id) {
                let _ = tx.send(ev.get("data").cloned().unwrap_or(Value::Null));
            }
        }
        return;
    }

    // get_session_stats (auto or manual): always persist + emit TokenStats.
    if command == "get_session_stats" {
        if let Some(data) = ev.get("data") {
            let (stats, pi_session) = parse_stats(data);
            let _ = ctx.db.workbench_stats_upsert(
                &ctx.session_id,
                stats.input,
                stats.output,
                stats.cache_read,
                stats.cache_write,
                stats.total,
            );
            if let Some(ps) = pi_session {
                let _ = ctx.db.workbench_session_set_pi_session(&ctx.session_id, &ps);
            }
            ctx.emit(WorkbenchEvent::TokenStats {
                input: stats.input,
                output: stats.output,
                cache_read: stats.cache_read,
                cache_write: stats.cache_write,
                total: stats.total,
                cost: stats.cost,
                context_tokens: stats.context_tokens,
                context_window: stats.context_window,
                context_percent: stats.context_percent,
            });
        }
    }

    // Resolve a correlated request waiter, if any.
    if let Some(id) = id {
        if let Some(tx) = ctx.pending.lock().await.remove(&id) {
            let _ = tx.send(ev.get("data").cloned().unwrap_or(Value::Null));
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Parse a `get_session_stats` `data` object into `WorkbenchStats` + pi session id.
fn parse_stats(data: &Value) -> (WorkbenchStats, Option<String>) {
    let tokens = data.get("tokens");
    let g = |k: &str| -> i64 {
        tokens
            .and_then(|t| t.get(k))
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
    };
    let ctxu = data.get("contextUsage");
    let stats = WorkbenchStats {
        input: g("input"),
        output: g("output"),
        cache_read: g("cacheRead"),
        cache_write: g("cacheWrite"),
        total: g("total"),
        cost: data.get("cost").and_then(|v| v.as_f64()).unwrap_or(0.0),
        context_tokens: ctxu
            .and_then(|c| c.get("tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        context_window: ctxu
            .and_then(|c| c.get("contextWindow"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        context_percent: ctxu
            .and_then(|c| c.get("percent"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
    };
    let pi_session = data
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    (stats, pi_session)
}

/// Join the text parts of a tool result's `content` array.
fn extract_tool_output(result: Option<&Value>) -> String {
    let Some(result) = result else {
        return String::new();
    };
    if let Some(arr) = result.get("content").and_then(|c| c.as_array()) {
        let mut out = String::new();
        for item in arr {
            if item.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
        }
        return out;
    }
    String::new()
}

/// Build a compact human-readable summary of an edit tool's `edits` array.
fn summarize_edits(args: &Value) -> String {
    let Some(edits) = args.get("edits").and_then(|e| e.as_array()) else {
        return String::new();
    };
    let mut out = String::new();
    for (i, e) in edits.iter().enumerate() {
        let old = e.get("oldText").and_then(|v| v.as_str()).unwrap_or("");
        let new = e.get("newText").and_then(|v| v.as_str()).unwrap_or("");
        if i > 0 {
            out.push_str("\n\n");
        }
        for l in old.lines() {
            out.push_str("- ");
            out.push_str(l);
            out.push('\n');
        }
        for l in new.lines() {
            out.push_str("+ ");
            out.push_str(l);
            out.push('\n');
        }
    }
    out
}

/// Normalize a provider base_url to the form pi expects (`…/v1`).
fn normalize_base_url(base_url: &str) -> String {
    let b = base_url.trim().trim_end_matches('/');
    let root = b.strip_suffix("/v1").unwrap_or(b);
    format!("{root}/v1")
}

/// Map F1 `wire_api` to a pi `api` id.
fn map_api(wire_api: &str) -> &'static str {
    if wire_api == "responses" {
        "openai-responses"
    } else {
        "openai-completions"
    }
}

/// Generate the `models.json` contents. The API key is a `$ENV` *reference*.
fn build_models_json(base_url: &str, model: &str, wire_api: &str) -> String {
    let cfg = json!({
        "providers": {
            "agentboard": {
                "name": "AgentBoard",
                "baseUrl": normalize_base_url(base_url),
                "api": map_api(wire_api),
                "apiKey": format!("${KEY_ENV}"),
                "models": [{
                    "id": model,
                    "name": model,
                    "reasoning": true,
                    "input": ["text", "image"],
                    "contextWindow": 400000,
                    "maxTokens": 128000,
                    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
                }]
            }
        }
    });
    serde_json::to_string_pretty(&cfg).unwrap_or_else(|_| "{}".to_string())
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

/// Resolve the (node program, pi cli.js) pair used to spawn the workbench engine.
///
/// Order:
/// 1. **Bundled engine** shipped inside the installer at resource
///    `engine-pi/` (`engine-pi/node.exe` + `engine-pi/pi/dist/cli.js`). This is
///    the self-contained runtime — the user needs no local Node or global pi.
/// 2. `pi_cli_path` setting → run with the system `node` on PATH.
/// 3. Global npm install of pi → run with the system `node` on PATH.
///
/// The bundled node is only used together with the bundled cli; the fallbacks
/// use the bare `node` program (resolved via PATH by the OS).
fn resolve_pi_runtime(db: &Db, app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    // 1) Bundled self-contained engine (installed app).
    if let Some((node, cli)) = bundled_pi_runtime(app) {
        return Ok((node, cli));
    }

    // 2) Explicit setting → system node.
    if let Ok(Some(p)) = db.settings_get("pi_cli_path") {
        let p = p.trim();
        if !p.is_empty() {
            let pb = PathBuf::from(p);
            if pb.exists() {
                return Ok((PathBuf::from("node"), pb));
            }
            return Err(format!("设置的 pi_cli_path 不存在: {p}"));
        }
    }

    // 3) Global npm install → system node.
    for cand in global_pi_candidates() {
        if cand.exists() {
            return Ok((PathBuf::from("node"), cand));
        }
    }
    Err("未找到内置引擎，也未安装 pi。请重新安装应用，或运行：npm i -g @earendil-works/pi-coding-agent".to_string())
}

/// Locate the bundled `engine-pi` runtime under the Tauri resource dir.
///
/// Returns `Some((node.exe, cli.js))` only when **both** the bundled node and
/// the bundled cli exist, so a partial/absent bundle transparently falls back
/// to the local install path. `None` in dev / tests (no resource dir).
fn bundled_pi_runtime(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    #[cfg(windows)]
    let node_name = "engine-pi/node.exe";
    #[cfg(not(windows))]
    let node_name = "engine-pi/node";
    let node = app.path().resolve(node_name, BaseDirectory::Resource).ok()?;
    let cli = app
        .path()
        .resolve("engine-pi/pi/dist/cli.js", BaseDirectory::Resource)
        .ok()?;
    if node.exists() && cli.exists() {
        Some((node, cli))
    } else {
        None
    }
}

/// Candidate global-npm locations for `dist/cli.js`.
fn global_pi_candidates() -> Vec<PathBuf> {
    let rel = ["@earendil-works", "pi-coding-agent", "dist", "cli.js"];
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let mut p = PathBuf::from(appdata).join("npm").join("node_modules");
            for r in rel {
                p = p.join(r);
            }
            out.push(p);
        }
    }
    #[cfg(not(windows))]
    {
        for base in ["/usr/local/lib/node_modules", "/usr/lib/node_modules"] {
            let mut p = PathBuf::from(base);
            for r in rel {
                p = p.join(r);
            }
            out.push(p);
        }
        if let Ok(home) = std::env::var("HOME") {
            let mut p = PathBuf::from(home).join(".npm-global").join("lib").join("node_modules");
            for r in rel {
                p = p.join(r);
            }
            out.push(p);
        }
    }
    out
}

/// Best-effort Windows taskkill of the pi process tree.
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

// ── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_base_url_variants() {
        assert_eq!(normalize_base_url("https://x.com"), "https://x.com/v1");
        assert_eq!(normalize_base_url("https://x.com/"), "https://x.com/v1");
        assert_eq!(normalize_base_url("https://x.com/v1"), "https://x.com/v1");
        assert_eq!(normalize_base_url("https://x.com/v1/"), "https://x.com/v1");
    }

    #[test]
    fn map_api_maps_wire_api() {
        assert_eq!(map_api("responses"), "openai-responses");
        assert_eq!(map_api("chat"), "openai-completions");
        assert_eq!(map_api("anything-else"), "openai-completions");
    }

    #[test]
    fn build_models_json_references_env_key_not_plaintext() {
        let j = build_models_json("https://relay.example.com", "gpt-5.5", "responses");
        assert!(j.contains("\"baseUrl\""));
        assert!(j.contains("relay.example.com/v1"));
        assert!(j.contains("openai-responses"));
        assert!(j.contains("gpt-5.5"));
        // The key must be an env reference, never a literal secret.
        assert!(j.contains(&format!("${KEY_ENV}")));
        assert!(!j.to_lowercase().contains("sk-"));
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
        assert!(!WorkbenchEvent::Thinking { text: "x".into() }.persist());
        assert!(WorkbenchEvent::AssistantMessage { text: "x".into() }.persist());
        assert!(WorkbenchEvent::ToolWrite {
            tool_call_id: "c".into(),
            path: "p".into()
        }
        .persist());
        assert_eq!(WorkbenchEvent::TurnCompleted.kind(), "turn_completed");
    }

    #[test]
    fn parse_stats_extracts_tokens_and_context() {
        let data = json!({
            "sessionId": "sid-123",
            "tokens": { "input": 100, "output": 20, "cacheRead": 5, "cacheWrite": 2, "total": 127 },
            "cost": 0.0,
            "contextUsage": { "tokens": 127, "contextWindow": 400000, "percent": 0.03 }
        });
        let (s, pi) = parse_stats(&data);
        assert_eq!(s.input, 100);
        assert_eq!(s.output, 20);
        assert_eq!(s.cache_read, 5);
        assert_eq!(s.cache_write, 2);
        assert_eq!(s.total, 127);
        assert_eq!(s.context_window, 400000);
        assert_eq!(pi.as_deref(), Some("sid-123"));
    }

    #[test]
    fn extract_tool_output_joins_text_parts() {
        let result = json!({
            "content": [
                { "type": "text", "text": "line1" },
                { "type": "text", "text": "line2" }
            ]
        });
        assert_eq!(extract_tool_output(Some(&result)), "line1\nline2");
        assert_eq!(extract_tool_output(None), "");
    }

    #[test]
    fn summarize_edits_renders_diff_markers() {
        let args = json!({
            "path": "a.rs",
            "edits": [ { "oldText": "foo", "newText": "bar" } ]
        });
        let d = summarize_edits(&args);
        assert!(d.contains("- foo"));
        assert!(d.contains("+ bar"));
    }

    /// LIVE: drives the real pi engine through one turn that creates hello.txt,
    /// exercising the exact spawn command / models.json / env injection that
    /// `spawn_pi` uses (minus the Tauri `AppHandle`, which can't be built in a
    /// unit test). Verifies the tool-execution event stream, the file output,
    /// and a `get_session_stats` round-trip.
    ///
    /// Requires a configured default provider with a key + a global pi install.
    /// Run with:
    /// `cargo test -p agentboard --lib pi_engine::tests::live_pi_creates_file -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_pi_creates_file() {
        use crate::db::Db;
        use std::process::Stdio;
        use tokio::process::Command;

        let db = Db::open().expect("open db");
        // Mirror production startup so the default provider exists.
        crate::providers::ensure_seeded(&db);
        let provider_id = resolve_provider_id(&db, None).expect("default provider");
        let (base_url, key, wire_api) =
            resolve_provider_creds(&db, &provider_id).expect("provider creds");
        // AppHandle can't be built in a unit test, so resolve the cli directly
        // from the global npm install (the production bundled path is exercised
        // by real workbench_open runs, not this test).
        let cli = global_pi_candidates()
            .into_iter()
            .find(|c| c.exists())
            .expect("global pi install");
        let model = std::env::var("WB_LIVE_MODEL").unwrap_or_else(|_| "gpt-5.5".to_string());
        println!("[live] provider={provider_id} model={model} cli={}", cli.display());

        // Temp agent dir + models.json (key stays in env only).
        let agent_dir = std::env::temp_dir().join(format!("wb-agent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("models.json"),
            build_models_json(&base_url, &model, &wire_api),
        )
        .unwrap();
        let work = std::env::temp_dir().join(format!("wb-work-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&work).unwrap();

        let mut child = Command::new("node")
            .arg(&cli)
            .args(["--mode", "rpc", "--provider", "agentboard", "--model", &model, "--approve"])
            .current_dir(&work)
            .env("PI_CODING_AGENT_DIR", &agent_dir)
            .env(KEY_ENV, &key)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn pi");

        let mut stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

        stdin
            .write_all(
                b"{\"type\":\"prompt\",\"message\":\"Create a file named hello.txt in the current directory with exactly the content: hello world. Then stop.\"}\n",
            )
            .await
            .unwrap();
        stdin.flush().await.unwrap();

        let mut seen: Vec<String> = Vec::new();
        let mut saw_tool = false;
        let mut sent_stats = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let line = match tokio::time::timeout(remaining, lines.next_line()).await {
                Ok(Ok(Some(l))) => l,
                _ => break,
            };
            let ev: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let ty = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let label = if ty == "message_update" {
                format!(
                    "message_update/{}",
                    ev.get("assistantMessageEvent")
                        .and_then(|a| a.get("type"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                )
            } else {
                ty.to_string()
            };
            if !seen.contains(&label) {
                seen.push(label.clone());
                println!("[live-ev] {label}");
            }
            if ty == "tool_execution_end" {
                saw_tool = true;
                println!("[live-tool] {}", serde_json::to_string(&ev).unwrap());
            }
            if ty == "agent_end" && !sent_stats {
                sent_stats = true;
                stdin
                    .write_all(b"{\"type\":\"get_session_stats\",\"id\":\"s1\"}\n")
                    .await
                    .unwrap();
                stdin.flush().await.unwrap();
            }
            if ty == "response"
                && ev.get("command").and_then(|v| v.as_str()) == Some("get_session_stats")
            {
                let (stats, pi) = parse_stats(ev.get("data").unwrap());
                println!("[live-stats] total={} input={} output={} pi_session={:?}", stats.total, stats.input, stats.output, pi);
                break;
            }
        }

        let target = work.join("hello.txt");
        let created = target.exists();
        println!("[live] hello.txt exists={created} seen_events={seen:?}");
        let _ = stdin.shutdown().await;
        kill_child_id(child.id()).await;
        let _ = child.kill().await;
        let _ = tokio::fs::remove_dir_all(&agent_dir).await;
        let _ = tokio::fs::remove_dir_all(&work).await;

        assert!(saw_tool, "should observe a tool_execution_end event");
        assert!(created, "pi should create hello.txt in the workdir");
    }
}
