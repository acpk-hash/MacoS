pub mod agent;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use agent::{
    codex::{AgentAdapter, CodexAdapter, TrackerMap, new_tracker_map},
    events::AgentEventEnvelope,
    new_session_map, SessionMap,
};

// ── Shared state ──────────────────────────────────────────────────────────────

struct AppState {
    sessions: SessionMap,
    trackers: TrackerMap,
    adapter: Arc<CodexAdapter>,
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Start a new Codex agent session.
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

    let emit_fn = make_emit_fn(app);

    adapter
        .start_session(sessions, trackers, prompt, workdir, emit_fn)
        .await
        .map_err(|e| e.to_string())
}

/// Send a follow-up prompt to a running / completed session (resumes via thread_id).
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

    let emit_fn = make_emit_fn(app);

    adapter
        .send_followup(sessions, trackers, session_id, text, emit_fn)
        .await
        .map_err(|e| e.to_string())
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
#[tauri::command]
async fn file_revert(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let tmap = state.trackers.lock().await;
    if let Some(tracker) = tmap.get(&session_id) {
        tracker
            .revert(&path)
            .await
            .map_err(|e| e.to_string())
    } else {
        Err(format!("no tracker for session {session_id}"))
    }
}

/// Mark a file as approved (accounting only; does not touch the file).
#[tauri::command]
async fn file_approve(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let tmap = state.trackers.lock().await;
    if let Some(tracker) = tmap.get(&session_id) {
        tracker.approve(&path);
        Ok(())
    } else {
        Err(format!("no tracker for session {session_id}"))
    }
}

/// Open a system directory-picker dialog and return the selected path.
/// Requires `tauri-plugin-dialog` and the `dialog:allow-open` capability.
#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .blocking_pick_folder();
    Ok(path.map(|p| p.to_string()))
}

// ── Example ping (kept for IPC smoke test) ────────────────────────────────────

#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            sessions: new_session_map(),
            trackers: new_tracker_map(),
            adapter: Arc::new(CodexAdapter::default()),
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            agent_start,
            agent_followup,
            agent_cancel,
            file_revert,
            file_approve,
            pick_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Helper ────────────────────────────────────────────────────────────────────

fn make_emit_fn(app: AppHandle) -> impl Fn(AgentEventEnvelope) + Send + Sync + 'static {
    move |envelope: AgentEventEnvelope| {
        // Best-effort emit; ignore errors (window may be closing).
        let _ = app.emit("agent-event", &envelope);
    }
}
