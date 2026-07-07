pub mod agent;
pub mod bridge;
pub mod db;
pub mod engine_config;
pub mod feishu;
pub mod mcp;
pub mod relay;
pub mod studio;
pub mod wecom;

use std::sync::Arc;

use std::collections::HashMap;

use tauri::{AppHandle, Emitter, Manager, State};

use agent::{
    codex::{AgentAdapter, CodexAdapter, TrackerMap, new_tracker_map},
    events::{AgentEvent, AgentEventEnvelope},
    new_session_map, SessionMap,
};
use db::{Db, TaskRow, TimelineItem};
use mcp::{McpServer, add_mcp_server, list_mcp_servers, remove_mcp_server, codex_config_path};

// ── Shared state ──────────────────────────────────────────────────────────────

pub(crate) struct AppState {
    sessions: SessionMap,
    trackers: TrackerMap,
    adapter: Arc<CodexAdapter>,
    db: Arc<Db>,
    bridge: bridge::BridgeManager,
    studio: studio::StudioState,
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Start a new Codex agent session.
///
/// - If `task_id` is `None`: creates a new task (status = running) whose id
///   equals the session id — the original behaviour, preserving Chat page
///   session-restore compatibility.
/// - If `task_id` is `Some(id)`: the task already exists in DB (status = todo);
///   creates a new session linked to that task, updates task status to `running`,
///   and returns the new session id.
///
/// Returns the session_id the frontend uses for follow-up / cancel calls.
#[tauri::command]
async fn agent_start(
    prompt: String,
    workdir: String,
    task_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let sessions = state.sessions.clone();
    let trackers = state.trackers.clone();
    let db = state.db.clone();

    // Pre-generate session_id so we can create DB records before events flow.
    let session_id = uuid::Uuid::new_v4().to_string();

    // Persist task + session + user message BEFORE spawning (avoids FK races).
    let title: String = prompt.chars().take(120).collect();

    match task_id {
        None => {
            // No pre-existing task: create task and session with the same id.
            db.insert_task(&session_id, &title, &workdir)
                .map_err(|e| e.to_string())?;
            db.insert_session(&session_id, &session_id, "codex")
                .map_err(|e| e.to_string())?;
        }
        Some(ref tid) => {
            // Pre-existing todo task: create a new session linked to it.
            db.insert_session(&session_id, tid, "codex")
                .map_err(|e| e.to_string())?;
            db.update_task_status(tid, "running")
                .map_err(|e| e.to_string())?;
        }
    }
    db.insert_message(&session_id, "user", &prompt)
        .map_err(|e| e.to_string())?;

    let emit_fn = make_emit_fn_with_db(app, db.clone());

    // Read reasoning_effort from settings (default "low"); apply via -c flag.
    let reasoning_effort = db
        .settings_get("reasoning_effort")
        .unwrap_or(None)
        .unwrap_or_else(|| "low".to_string());
    let adapter = std::sync::Arc::new(CodexAdapter {
        extra_args: vec![
            "-c".to_string(),
            format!("model_reasoning_effort={}", reasoning_effort),
        ],
        sandbox: state.adapter.sandbox.clone(),
    });

    adapter
        .start_session(session_id.clone(), sessions, trackers, prompt, workdir, emit_fn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(session_id)
}

/// Send a follow-up prompt to a running / completed session.
///
/// Hot path: session still in memory → resume directly.
/// Cold path: app was restarted → look up thread_id + workdir from DB and
///            cold-start a new codex `exec resume` process.
#[tauri::command]
async fn agent_followup(
    session_id: String,
    text: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let sessions = state.sessions.clone();
    let trackers = state.trackers.clone();
    let db = state.db.clone();

    // Always persist the user follow-up message.
    db.insert_message(&session_id, "user", &text)
        .map_err(|e| e.to_string())?;
    // Mark task as running again.
    let _ = db.update_task_status(&session_id, "running");

    let emit_fn = make_emit_fn_with_db(app, db.clone());

    // Read reasoning_effort and build adapter with it.
    let reasoning_effort = db
        .settings_get("reasoning_effort")
        .unwrap_or(None)
        .unwrap_or_else(|| "low".to_string());
    let adapter = std::sync::Arc::new(CodexAdapter {
        extra_args: vec![
            "-c".to_string(),
            format!("model_reasoning_effort={}", reasoning_effort),
        ],
        sandbox: state.adapter.sandbox.clone(),
    });

    // Check whether the session handle is still alive in memory.
    let in_memory = {
        let guard = sessions.lock().await;
        guard.contains_key(&session_id)
    };

    if in_memory {
        adapter
            .send_followup(sessions, trackers, session_id, text, emit_fn)
            .await
            .map_err(|e| e.to_string())
    } else {
        // Cold path: retrieve thread_id and workdir from DB.
        let thread_id = db
            .get_thread_id(&session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                format!("no thread_id in DB for session {session_id}; cannot resume")
            })?;
        let workdir = db
            .get_session_workdir(&session_id)
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| ".".to_string());

        adapter
            .resume_with_thread_id(sessions, trackers, session_id, thread_id, workdir, text, emit_fn)
            .await
            .map_err(|e| e.to_string())
    }
}

/// Kill the subprocess for a session.
#[tauri::command]
async fn agent_cancel(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.sessions.clone();
    let adapter = state.adapter.clone();

    adapter
        .cancel(sessions, session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Revert a file to its pre-session state (git checkout or snapshot restore).
/// Also updates the file-change state in the DB to `"reverted"`.
///
/// Hot path: in-memory `FileTracker` handles the revert.
/// Cold path (after app restart): reads `snapshot_path` from DB and restores
///   the file directly; if git mode, falls back to `git checkout`; if neither
///   is available, returns a descriptive error (never silently fails).
#[tauri::command]
async fn file_revert(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Clone the tracker Arc so we can release the map lock before awaiting.
    let tracker_opt = {
        let tmap = state.trackers.lock().await;
        tmap.get(&session_id).cloned()
    };

    if let Some(tracker) = tracker_opt {
        tracker.revert(&path).await.map_err(|e| e.to_string())?;
    } else {
        // Cold path: tracker not in memory (app restarted).
        cold_revert(&state.db, &session_id, &path).await?;
    }

    let _ = state.db.update_file_change_state(&session_id, &path, "reverted");
    Ok(())
}

/// Cold revert: no in-memory tracker available.
///
/// 1. If `snapshot_path` is in DB → restore file from snapshot file.
///    Error if the snapshot file itself is missing.
/// 2. If no snapshot in DB, git mode, kind = "create" → delete the file
///    (the file was created by the agent and has no HEAD version to restore).
/// 3. If no snapshot in DB, git mode, other kind → `git checkout -- <path>`.
/// 4. Otherwise → return descriptive error; never silently fails.
async fn cold_revert(db: &Db, session_id: &str, path: &str) -> Result<(), String> {
    let snap_path_str = db
        .get_snapshot_path(session_id, path)
        .map_err(|e| e.to_string())?;

    if let Some(snap) = snap_path_str {
        // Non-git snapshot mode: restore from the snapshot file.
        let snap_content = tokio::fs::read_to_string(&snap).await.map_err(|_| {
            format!(
                "快照文件丢失，无法回滚 {}（快照路径: {}）",
                path, snap
            )
        })?;
        let abs_path = std::path::PathBuf::from(path);
        if let Some(parent) = abs_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        tokio::fs::write(&abs_path, snap_content)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    // No snapshot in DB: check file kind so we can handle "create" specially.
    let kind = db
        .get_file_change_kind(session_id, path)
        .map_err(|e| e.to_string())?;

    // Get workdir for git operations.
    let workdir = db
        .get_session_workdir(session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "找不到会话工作目录，无法回滚".to_string())?;

    let workdir_path = std::path::PathBuf::from(&workdir);
    if agent::tracker::check_is_git(&workdir_path).await {
        // For newly created files there is no HEAD version — delete to revert
        // (aligns cold path with the hot path in FileTracker::git_revert).
        if kind.as_deref() == Some("create") {
            let abs_path = std::path::PathBuf::from(path);
            if abs_path.exists() {
                tokio::fs::remove_file(&abs_path)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            return Ok(());
        }

        // Existing tracked file: restore from HEAD.
        let out = tokio::process::Command::new("git")
            .args(["checkout", "--", path])
            .current_dir(&workdir_path)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            return Err(if stderr.is_empty() {
                "git checkout 失败".to_string()
            } else {
                stderr
            });
        }
        Ok(())
    } else {
        Err(format!(
            "无法回滚 {}：应用重启后快照已丢失，且工作目录不是 git 仓库",
            path
        ))
    }
}

/// Mark a file as approved (accounting only; does not touch the file).
/// Also updates the file-change state in the DB to `"approved"`.
#[tauri::command]
async fn file_approve(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let tmap = state.trackers.lock().await;
    if let Some(tracker) = tmap.get(&session_id) {
        tracker.approve(&path);
    }
    drop(tmap);
    let _ = state.db.update_file_change_state(&session_id, &path, "approved");
    Ok(())
}

/// Return all tasks ordered by `updated_at DESC` (max 100).
/// Called by the frontend on startup to populate the session list and board.
#[tauri::command]
async fn list_tasks(state: State<'_, AppState>) -> Result<Vec<TaskRow>, String> {
    state.db.list_tasks().map_err(|e| e.to_string())
}

/// Return the merged message + file-change timeline for a session, sorted by ts.
/// Called when the user selects a historical session to restore it.
#[tauri::command]
async fn get_session_timeline(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<TimelineItem>, String> {
    state
        .db
        .get_session_timeline(&session_id)
        .map_err(|e| e.to_string())
}

/// Create a new task in `todo` status without starting an agent session.
/// Used by the Board's "新任务" input.  Returns the new task id.
#[tauri::command]
async fn task_create(
    title: String,
    workdir: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    state
        .db
        .insert_task_todo(&id, &title, &workdir)
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Delete a task and cascade-delete all its sessions, messages, events, and
/// file_changes.  Only todo tasks should be deleted from the UI.
#[tauri::command]
async fn task_delete(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.delete_task(&task_id).map_err(|e| e.to_string())
}

/// Update the title of a todo task.
#[tauri::command]
async fn task_update_title(
    task_id: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .db
        .update_task_title(&task_id, &title)
        .map_err(|e| e.to_string())
}

/// Manually transition a task's status following the validated state machine.
///
/// Allowed transitions:
/// - `awaiting_review` → `done` (human confirms the work via Board drag-drop)
///
/// All other transitions are rejected with a descriptive error.
#[tauri::command]
async fn task_set_status(
    task_id: String,
    status: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.set_task_status_validated(&task_id, &status)
}

/// Open a system directory-picker dialog and return the selected path.
#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file().blocking_pick_folder();
    Ok(path.map(|p| p.to_string()))
}

/// Return all settings as a JSON object (key → value).
#[tauri::command]
async fn settings_get_all(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    state.db.settings_get_all().map_err(|e| e.to_string())
}

/// Upsert a single setting.
#[tauri::command]
async fn settings_set(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.settings_set(&key, &value).map_err(|e| e.to_string())
}

// ── Engine API configuration ──────────────────────────────────────────────────

/// Read the engine configuration from config.toml + auth.json.
///
/// Returns provider settings and a key mask; the plaintext API key is never
/// returned to the frontend.
#[tauri::command]
async fn engine_config_get() -> Result<engine_config::EngineConfigInfo, String> {
    let config_path = mcp::codex_config_path();
    let auth_path = engine_config::auth_json_path();
    engine_config::engine_config_get(&config_path, &auth_path)
}

/// Persist engine configuration to config.toml and (optionally) auth.json.
///
/// Security guarantees:
/// - API key is NOT stored in SQLite (only written to auth.json on disk).
/// - API key is NOT logged anywhere (neither Rust nor frontend should log it).
/// - API key is NOT returned to the frontend (use `engine_config_get` for mask).
#[tauri::command]
async fn engine_config_set(cfg: engine_config::EngineConfigInput) -> Result<(), String> {
    let config_path = mcp::codex_config_path();
    let auth_path = engine_config::auth_json_path();
    engine_config::engine_config_set(&config_path, &auth_path, cfg)
}

/// Run a one-shot `codex exec` connectivity test.
///
/// Runs with `model_reasoning_effort=low` in a throwaway temp directory.
/// Times out after 30 seconds.
#[tauri::command]
async fn engine_config_test() -> Result<engine_config::TestResult, String> {
    engine_config::engine_config_test().await
}

// ── Engine detection ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
struct EngineStatus {
    name: String,
    available: bool,
    version: Option<String>,
}

/// Probe a CLI tool by running it with `--version`.
///
/// On Windows, wraps with `cmd /c` so `.cmd` shims resolve.
/// The `cmd_binary` / `cmd_args` parameters are split out for testability:
/// tests can inject `"echo"` + `["1.2.3"]` to exercise the parsing logic
/// without a real CLI installed.
async fn probe_engine_with(name: &str, cmd_binary: &str, args: &[&str]) -> EngineStatus {
    let output = tokio::process::Command::new(cmd_binary)
        .args(args)
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            EngineStatus {
                name: name.to_string(),
                available: true,
                version: if v.is_empty() { None } else { Some(v) },
            }
        }
        _ => EngineStatus {
            name: name.to_string(),
            available: false,
            version: None,
        },
    }
}

/// Detect installed engines (codex, claude). Returns a list of EngineStatus.
#[tauri::command]
async fn detect_engines() -> Result<Vec<EngineStatus>, String> {
    // On Windows, CLI wrappers end in .cmd and require cmd.exe.
    #[cfg(windows)]
    let (codex_status, claude_status) = tokio::join!(
        probe_engine_with("codex", "cmd", &["/c", "codex", "--version"]),
        probe_engine_with("claude", "cmd", &["/c", "claude", "--version"]),
    );

    #[cfg(not(windows))]
    let (codex_status, claude_status) = tokio::join!(
        probe_engine_with("codex", "codex", &["--version"]),
        probe_engine_with("claude", "claude", &["--version"]),
    );

    Ok(vec![codex_status, claude_status])
}

// ── MCP management ────────────────────────────────────────────────────────────

/// List MCP servers configured in the Codex config.toml.
#[tauri::command]
async fn mcp_list() -> Result<Vec<McpServer>, String> {
    let path = codex_config_path();
    list_mcp_servers(&path)
}

/// Add (or replace) an MCP server in the Codex config.toml.
/// Backs up `config.toml` to `config.toml.bak` before writing.
#[tauri::command]
async fn mcp_add(
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<(), String> {
    let server = McpServer { name, command, args, env };
    let path = codex_config_path();
    add_mcp_server(&path, &server)
}

/// Remove an MCP server from the Codex config.toml by name.
/// Backs up `config.toml` to `config.toml.bak` before writing.
#[tauri::command]
async fn mcp_remove(name: String) -> Result<(), String> {
    let path = codex_config_path();
    remove_mcp_server(&path, &name)
}

/// Send a test Feishu card to verify the notification configuration.
/// Returns a human-readable success or error message (error text is transparent).
#[tauri::command]
async fn feishu_test(state: State<'_, AppState>) -> Result<String, String> {
    let settings = state.db.settings_get_all().map_err(|e| e.to_string())?;
    let config = feishu::load_config(&settings).ok_or_else(|| {
        "飞书通知未启用或配置不完整（请填写 App ID、App Secret 和接收者 ID）".to_string()
    })?;
    feishu::send_card(&config, feishu::card_test())
        .await
        .map_err(|e| e)?;
    Ok("测试卡片发送成功".to_string())
}

/// Return the recent Feishu push log entries (newest first, max 50).
#[tauri::command]
fn feishu_recent_logs() -> Vec<String> {
    feishu::recent_logs()
}

/// Send a test WeChat Work textcard to verify the notification configuration.
/// Returns a human-readable success or error message (error text is transparent).
#[tauri::command]
async fn wecom_test(state: State<'_, AppState>) -> Result<String, String> {
    let settings = state.db.settings_get_all().map_err(|e| e.to_string())?;
    let config = wecom::load_config(&settings).ok_or_else(|| {
        "企业微信通知未启用或配置不完整（请填写企业ID、应用Secret 和 AgentId）".to_string()
    })?;
    wecom::send(&config, wecom::msg_test(&config))
        .await
        .map_err(|e| e)?;
    Ok("测试消息发送成功".to_string())
}

/// Return the recent WeChat Work push log entries (newest first, max 50).
#[tauri::command]
fn wecom_recent_logs() -> Vec<String> {
    wecom::recent_logs()
}

// ── Feishu bridge commands ────────────────────────────────────────────────────

/// Start the Feishu inbound bridge (HTTP listener + Node sidecar).
/// Safe to call when already running — it will restart.
#[tauri::command]
async fn bridge_start(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    state
        .bridge
        .start(
            state.db.clone(),
            state.sessions.clone(),
            state.trackers.clone(),
            state.adapter.clone(),
            app,
        )
        .await
}

/// Stop the Feishu inbound bridge.
#[tauri::command]
async fn bridge_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.bridge.stop().await;
    Ok(())
}

/// Return bridge status (state, port, recent logs).
#[tauri::command]
async fn bridge_status(state: State<'_, AppState>) -> Result<bridge::BridgeStatusInfo, String> {
    Ok(state.bridge.status().await)
}

/// Detect whether `node` is installed.  Returns the version string or `null`.
#[tauri::command]
async fn bridge_node_version() -> Option<String> {
    #[cfg(windows)]
    let out = tokio::process::Command::new("cmd")
        .args(["/c", "node", "--version"])
        .output()
        .await;
    #[cfg(not(windows))]
    let out = tokio::process::Command::new("node")
        .arg("--version")
        .output()
        .await;

    out.ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Smoke-test ping.
#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = Arc::new(Db::open().expect("failed to open agentboard database"));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            sessions: new_session_map(),
            trackers: new_tracker_map(),
            adapter: Arc::new(CodexAdapter::default()),
            db,
            bridge: bridge::BridgeManager::new(),
            studio: studio::StudioState::new(),
        })
        .setup(|app| {
            // Auto-start bridge if feishu_enabled && bridge_autostart both "true".
            let handle = app.handle().clone();
            let db_clone = app.state::<AppState>().db.clone();

            tauri::async_runtime::spawn(async move {
                let settings = db_clone.settings_get_all().unwrap_or_default();
                let feishu_enabled =
                    settings.get("feishu_enabled").map(|s| s == "true").unwrap_or(false);
                let autostart =
                    settings.get("bridge_autostart").map(|s| s == "true").unwrap_or(false);
                if feishu_enabled && autostart {
                    let state = handle.state::<AppState>();
                    if let Err(e) = state
                        .bridge
                        .start(
                            db_clone,
                            state.sessions.clone(),
                            state.trackers.clone(),
                            state.adapter.clone(),
                            handle.clone(),
                        )
                        .await
                    {
                        eprintln!("[bridge] 自动启动失败: {e}");
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            agent_start,
            agent_followup,
            agent_cancel,
            file_revert,
            file_approve,
            pick_directory,
            list_tasks,
            get_session_timeline,
            task_create,
            task_delete,
            task_update_title,
            task_set_status,
            settings_get_all,
            settings_set,
            detect_engines,
            engine_config_get,
            engine_config_set,
            engine_config_test,
            mcp_list,
            mcp_add,
            mcp_remove,
            feishu_test,
            feishu_recent_logs,
            wecom_test,
            wecom_recent_logs,
            bridge_start,
            bridge_stop,
            bridge_status,
            bridge_node_version,
            studio::studio_models,
            studio::studio_capabilities,
            studio::chat_sessions_list,
            studio::chat_sessions_create,
            studio::chat_sessions_rename,
            studio::chat_sessions_delete,
            studio::chat_messages_list,
            studio::chat_send,
            studio::chat_stop,
            studio::image_generate,
            studio::media_list,
            studio::media_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Emit fn factory ───────────────────────────────────────────────────────────

/// Build an emit closure that:
/// 1. Persists the event (and derived records) to the DB.
/// 2. Forwards the envelope to the frontend via Tauri's event system.
pub(crate) fn make_emit_fn_with_db(
    app: AppHandle,
    db: Arc<Db>,
) -> impl Fn(AgentEventEnvelope) + Send + Sync + 'static {
    move |envelope: AgentEventEnvelope| {
        let sid = &envelope.session_id;

        // Write raw event JSON to events table (best-effort; ignore errors).
        if let Ok(payload) = serde_json::to_string(&envelope.event) {
            let _ = db.insert_event(sid, event_type_label(&envelope.event), &payload);
        }

        // Handle events that require additional DB side-effects.
        match &envelope.event {
            AgentEvent::SessionStarted { thread_id, .. } => {
                let _ = db.update_session_thread_id(sid, thread_id);
            }
            AgentEvent::AssistantMessage { text } => {
                let _ = db.insert_message(sid, "assistant", text);
            }
            AgentEvent::FileEdit { path, kind, diff, added, removed, snapshot_path } => {
                let _ = db.upsert_file_change(
                    sid,
                    path,
                    kind,
                    *added as i64,
                    *removed as i64,
                    diff.as_deref(),
                    snapshot_path.as_deref(),
                );
            }
            AgentEvent::TurnCompleted {} => {
                let _ = db.update_task_status(sid, "awaiting_review");
                let _ = db.end_session(sid);

                // Gather notification data once; each channel gates independently.
                if let Ok(settings) = db.settings_get_all() {
                    let title_wd = db.get_task_info_for_session(sid).unwrap_or(None);
                    let started_at = db.get_session_started_at(sid).unwrap_or(None);
                    let file_count = db.get_session_file_count(sid).unwrap_or(0);
                    let tokens = db.get_last_usage_tokens(sid).unwrap_or(None);
                    // Resolve the task_id so the accept button can target it.
                    let task_id = db.get_task_id_for_session(sid)
                        .unwrap_or(None)
                        .unwrap_or_else(|| sid.to_string());

                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    let elapsed_secs = started_at
                        .map(|s| ((now_ms - s).max(0) as u64) / 1000)
                        .unwrap_or(0);

                    let (title, workdir) = title_wd
                        .unwrap_or_else(|| (sid.to_string(), "?".to_string()));
                    let (input_tok, _, output_tok, _) = tokens.unwrap_or((0, 0, 0, 0));

                    // Feishu notification (fire-and-forget, never blocks the pipeline)
                    if let Some(cfg) = feishu::load_config(&settings) {
                        let card = feishu::card_completed(
                            &title,
                            &workdir,
                            elapsed_secs,
                            file_count,
                            input_tok,
                            output_tok,
                            &task_id,
                        );
                        feishu::spawn_send(cfg, card, format!("完成: {}", title));
                    }

                    // WeChat Work notification (fire-and-forget, independent gate)
                    if let Some(cfg) = wecom::load_config(&settings) {
                        let body = wecom::msg_completed(
                            &cfg,
                            &title,
                            &workdir,
                            elapsed_secs,
                            file_count,
                            input_tok,
                            output_tok,
                        );
                        wecom::spawn_send(cfg, body, format!("完成: {}", title));
                    }
                }
            }
            AgentEvent::Error { message } => {
                let _ = db.update_task_status(sid, "failed");

                if let Ok(settings) = db.settings_get_all() {
                    let title = db
                        .get_task_info_for_session(sid)
                        .unwrap_or(None)
                        .map(|(t, _)| t)
                        .unwrap_or_else(|| sid.to_string());

                    // Feishu notification (fire-and-forget)
                    if let Some(cfg) = feishu::load_config(&settings) {
                        let card = feishu::card_failed(&title, message);
                        feishu::spawn_send(cfg, card, format!("失败: {}", title));
                    }

                    // WeChat Work notification (fire-and-forget, independent gate)
                    if let Some(cfg) = wecom::load_config(&settings) {
                        let body = wecom::msg_failed(&cfg, &title, message);
                        wecom::spawn_send(cfg, body, format!("失败: {}", title));
                    }
                }
            }
            _ => {}
        }

        // Emit to frontend.
        let _ = app.emit("agent-event", &envelope);
    }
}

fn event_type_label(event: &AgentEvent) -> &'static str {
    match event {
        AgentEvent::SessionStarted { .. } => "session_started",
        AgentEvent::AssistantMessage { .. } => "assistant_message",
        AgentEvent::Reasoning { .. } => "reasoning",
        AgentEvent::ToolCall { .. } => "tool_call",
        AgentEvent::FileEdit { .. } => "file_edit",
        AgentEvent::CommandRun { .. } => "command_run",
        AgentEvent::Usage { .. } => "usage",
        AgentEvent::TurnCompleted {} => "turn_completed",
        AgentEvent::Error { .. } => "error",
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use tokio::process::Command as TokioCommand;

    // ── cold_revert: git new file (kind = "create") ───────────────────────────

    /// Verify the cold-revert path deletes a newly created file (kind="create")
    /// in a git-mode repo without trying to run `git checkout`.
    #[tokio::test]
    async fn cold_revert_git_new_file_deletes_file() {
        let tmp = TempDir::new().unwrap();
        let workdir = tmp.path();

        // Initialise a bare git repo (no commits needed for check_is_git).
        let git_init = TokioCommand::new("git")
            .args(["init"])
            .current_dir(workdir)
            .output()
            .await;

        // Skip this test if git is not installed.
        let git_ok = git_init.map(|o| o.status.success()).unwrap_or(false);
        if !git_ok {
            eprintln!("git not available — skipping cold_revert_git_new_file_deletes_file");
            return;
        }

        // Create an untracked file (simulating agent "create").
        let file_path = workdir.join("created_by_agent.txt");
        tokio::fs::write(&file_path, "new content\n").await.unwrap();
        assert!(file_path.exists());

        // Set up an in-memory DB with the "create" kind recorded.
        let db = crate::db::Db::open_in_memory().unwrap();
        db.insert_task("cr_t", "T", workdir.to_str().unwrap()).unwrap();
        db.insert_session("cr_s", "cr_t", "codex").unwrap();
        db.upsert_file_change(
            "cr_s",
            file_path.to_str().unwrap(),
            "create",
            5, 0, None, None,
        )
        .unwrap();

        // Cold revert: no snapshot, kind="create", workdir is a git repo.
        cold_revert(&db, "cr_s", file_path.to_str().unwrap())
            .await
            .expect("cold_revert should succeed");

        assert!(
            !file_path.exists(),
            "cold_revert should delete the newly created file"
        );
    }

    // ── probe_engine_with: mock command injection ─────────────────────────────

    /// Verifies that probe_engine_with returns available=true and captures stdout
    /// when given a command that succeeds. Uses `echo` as a mock "engine".
    #[tokio::test]
    async fn probe_engine_with_mock_available() {
        // `echo 0.1.0` exits 0 and outputs "0.1.0" — usable as a mock CLI.
        #[cfg(windows)]
        let result = probe_engine_with("mock", "cmd", &["/c", "echo", "0.1.0"]).await;
        #[cfg(not(windows))]
        let result = probe_engine_with("mock", "echo", &["0.1.0"]).await;

        assert!(result.available, "mock engine should report available");
        let v = result.version.expect("version should be Some");
        assert!(v.contains("0.1.0"), "version should contain '0.1.0', got: {}", v);
    }

    /// Verifies that probe_engine_with returns available=false for a nonexistent command.
    #[tokio::test]
    async fn probe_engine_with_mock_unavailable() {
        let result =
            probe_engine_with("missing", "this_binary_does_not_exist_xyz_123", &[]).await;
        assert!(!result.available, "nonexistent binary should report unavailable");
        assert!(result.version.is_none());
    }
}
