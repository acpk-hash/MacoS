pub mod agent;
pub mod db;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use agent::{
    codex::{AgentAdapter, CodexAdapter, TrackerMap, new_tracker_map},
    events::{AgentEvent, AgentEventEnvelope},
    new_session_map, SessionMap,
};
use db::{Db, TaskRow, TimelineItem};

// ── Shared state ──────────────────────────────────────────────────────────────

struct AppState {
    sessions: SessionMap,
    trackers: TrackerMap,
    adapter: Arc<CodexAdapter>,
    db: Arc<Db>,
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Start a new Codex agent session.
/// The caller-supplied `prompt` is stored as the task title (truncated to 120 chars).
/// Returns the session_id the frontend uses for follow-up / cancel calls.
#[tauri::command]
async fn agent_start(
    prompt: String,
    workdir: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let sessions = state.sessions.clone();
    let trackers = state.trackers.clone();
    let adapter = state.adapter.clone();
    let db = state.db.clone();

    // Pre-generate session_id so we can create DB records before events flow.
    let session_id = uuid::Uuid::new_v4().to_string();

    // Persist task + session + user message BEFORE spawning (avoids FK races).
    let title: String = prompt.chars().take(120).collect();
    db.insert_task(&session_id, &title, &workdir)
        .map_err(|e| e.to_string())?;
    db.insert_session(&session_id, &session_id, "codex")
        .map_err(|e| e.to_string())?;
    db.insert_message(&session_id, "user", &prompt)
        .map_err(|e| e.to_string())?;

    let emit_fn = make_emit_fn_with_db(app, db);

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
    let adapter = state.adapter.clone();
    let db = state.db.clone();

    // Always persist the user follow-up message.
    db.insert_message(&session_id, "user", &text)
        .map_err(|e| e.to_string())?;
    // Mark task as running again.
    let _ = db.update_task_status(&session_id, "running");

    let emit_fn = make_emit_fn_with_db(app, db.clone());

    // Check whether the session handle is still alive in memory.
    let in_memory = {
        let guard = sessions.lock().await;
        guard.contains_key(&session_id)
    };

    if in_memory {
        // Hot path.
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
#[tauri::command]
async fn file_revert(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let tmap = state.trackers.lock().await;
    if let Some(tracker) = tmap.get(&session_id) {
        tracker.revert(&path).await.map_err(|e| e.to_string())?;
    }
    drop(tmap);
    let _ = state.db.update_file_change_state(&session_id, &path, "reverted");
    Ok(())
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
/// Called by the frontend on startup to populate the session list.
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

/// Open a system directory-picker dialog and return the selected path.
#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file().blocking_pick_folder();
    Ok(path.map(|p| p.to_string()))
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Emit fn factory ───────────────────────────────────────────────────────────

/// Build an emit closure that:
/// 1. Persists the event (and derived records) to the DB.
/// 2. Forwards the envelope to the frontend via Tauri's event system.
fn make_emit_fn_with_db(
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
            AgentEvent::FileEdit { path, kind, diff, added, removed } => {
                let _ = db.upsert_file_change(
                    sid,
                    path,
                    kind,
                    *added as i64,
                    *removed as i64,
                    diff.as_deref(),
                );
            }
            AgentEvent::TurnCompleted {} => {
                let _ = db.update_task_status(sid, "awaiting_review");
                let _ = db.end_session(sid);
            }
            AgentEvent::Error { .. } => {
                let _ = db.update_task_status(sid, "failed");
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
