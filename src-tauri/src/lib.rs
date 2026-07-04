pub mod agent;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use agent::{
    codex::{AgentAdapter, CodexAdapter},
    events::AgentEventEnvelope,
    new_session_map, SessionMap,
};

// ── Shared state ──────────────────────────────────────────────────────────────

struct AppState {
    sessions: SessionMap,
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
    let adapter = state.adapter.clone();

    let emit_fn = make_emit_fn(app);

    adapter
        .start_session(sessions, prompt, workdir, emit_fn)
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
    let adapter = state.adapter.clone();

    let emit_fn = make_emit_fn(app);

    adapter
        .send_followup(sessions, session_id, text, emit_fn)
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

// ── Example ping (kept for IPC smoke test) ────────────────────────────────────

#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            sessions: new_session_map(),
            adapter: Arc::new(CodexAdapter),
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            agent_start,
            agent_followup,
            agent_cancel,
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
