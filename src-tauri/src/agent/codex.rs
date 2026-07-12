use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::agent::events::{AgentEvent, AgentEventEnvelope, RawEvent};
use crate::agent::tracker::FileTracker;
use crate::procext::NoWindowExt;

// ── Error type ────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum CodexError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("session not found: {0}")]
    SessionNotFound(String),
    /// Engine-adapter error (e.g. engine binary / codex.exe not found).
    #[error("engine error: {0}")]
    Engine(String),
}

// ── Session handle ────────────────────────────────────────────────────────────

pub struct SessionHandle {
    pub thread_id: Option<String>,
    pub(crate) child: Child,
    /// FileTracker for this session — survives until the session is explicitly
    /// removed so follow-up turns can reuse it.
    pub tracker: Option<Arc<FileTracker>>,
    /// Embedded-engine only: channel to push follow-up user inputs into the
    /// long-lived engine driver task (the engine process stays warm across
    /// turns). `None` for the CLI adapter (which re-spawns per turn).
    pub followup_tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
}

// ── Active session registry ───────────────────────────────────────────────────

pub type SessionMap = Arc<Mutex<HashMap<String, SessionHandle>>>;

pub fn new_session_map() -> SessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Separate map that keeps `FileTracker`s alive even after the child process
/// exits (needed so follow-up turns can reuse the same tracker and `file_revert`
/// commands can reach it from a Tauri command handler).
pub type TrackerMap = Arc<Mutex<HashMap<String, Arc<FileTracker>>>>;

pub fn new_tracker_map() -> TrackerMap {
    Arc::new(Mutex::new(HashMap::new()))
}

// ── Trait ─────────────────────────────────────────────────────────────────────

#[allow(async_fn_in_trait)] // stable async-in-trait is fine for our single impl
pub trait AgentAdapter {
    /// Spawn a new session. The caller pre-generates `session_id` so it can
    /// create DB records before events start flowing.
    async fn start_session(
        &self,
        session_id: String,
        sessions: SessionMap,
        trackers: TrackerMap,
        prompt: String,
        workdir: String,
        emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
    ) -> Result<(), CodexError>;

    /// Send a follow-up prompt to an existing **in-memory** session.
    async fn send_followup(
        &self,
        sessions: SessionMap,
        trackers: TrackerMap,
        session_id: String,
        text: String,
        emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
    ) -> Result<(), CodexError>;

    /// Kill the subprocess for a session.
    async fn cancel(&self, sessions: SessionMap, session_id: String) -> Result<(), CodexError>;
}

// ── CodexAdapter ──────────────────────────────────────────────────────────────

/// Adapter that drives `codex exec --json` as a child process.
///
/// `extra_args` are inserted into the `codex exec` invocation before the prompt,
/// e.g. `["-c", "model_reasoning_effort=low"]`.
///
/// `sandbox` controls the `-s` flag (default: `"workspace-write"`).
/// Use `"danger-full-access"` in environments where the Windows elevated
/// sandbox is not initialised (e.g. CI / integration tests).
pub struct CodexAdapter {
    /// Extra CLI args appended after `--skip-git-repo-check` and before the prompt.
    pub extra_args: Vec<String>,
    /// Codex sandbox level passed as `-s <sandbox>`. Default: `"workspace-write"`.
    pub sandbox: String,
}

impl Default for CodexAdapter {
    fn default() -> Self {
        Self {
            extra_args: vec![],
            sandbox: "workspace-write".to_string(),
        }
    }
}

impl AgentAdapter for CodexAdapter {
    async fn start_session(
        &self,
        session_id: String,
        sessions: SessionMap,
        trackers: TrackerMap,
        prompt: String,
        workdir: String,
        emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
    ) -> Result<(), CodexError> {
        // Build a FileTracker for this session and store it in the tracker map.
        let tracker = Arc::new(FileTracker::new(&session_id, &workdir).await);
        {
            let mut tmap = trackers.lock().await;
            tmap.insert(session_id.clone(), tracker.clone());
        }

        let child = codex_cmd()
            .args(["exec", "--json", "-s", &self.sandbox, "-C", &workdir, "--skip-git-repo-check"])
            .args(&self.extra_args)
            .arg(&prompt)
            .stdin(Stdio::null()) // prevent codex from blocking on interactive stdin
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        drive_process(child, sessions, session_id, Some(tracker), emit).await;

        Ok(())
    }

    async fn send_followup(
        &self,
        sessions: SessionMap,
        trackers: TrackerMap,
        session_id: String,
        text: String,
        emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
    ) -> Result<(), CodexError> {
        // Retrieve the thread_id for this session.
        let thread_id = {
            let guard = sessions.lock().await;
            guard
                .get(&session_id)
                .and_then(|h| h.thread_id.clone())
                .ok_or_else(|| CodexError::SessionNotFound(session_id.clone()))?
        };

        // Re-use the existing tracker for this session (if any).
        let tracker = {
            let tmap = trackers.lock().await;
            tmap.get(&session_id).cloned()
        };

        let child = codex_cmd()
            .args(["exec", "resume", "--json"])
            .args(&self.extra_args)
            .args([&thread_id, &text])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let sid_clone = session_id.clone();
        drive_process(child, sessions, sid_clone, tracker, emit).await;

        Ok(())
    }

    async fn cancel(&self, sessions: SessionMap, session_id: String) -> Result<(), CodexError> {
        let mut guard = sessions.lock().await;
        if let Some(handle) = guard.get_mut(&session_id) {
            let _ = handle.child.kill().await;
            guard.remove(&session_id);
            Ok(())
        } else {
            Err(CodexError::SessionNotFound(session_id))
        }
    }
}

impl CodexAdapter {
    /// Cold-resume a session whose in-memory handle has been lost (e.g. after
    /// app restart). Accepts the `thread_id` and `workdir` retrieved from the
    /// database so no in-memory session lookup is required.
    pub async fn resume_with_thread_id(
        &self,
        sessions: SessionMap,
        trackers: TrackerMap,
        session_id: String,
        thread_id: String,
        workdir: String,
        text: String,
        emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
    ) -> Result<(), CodexError> {
        // Re-use the existing tracker if it's still alive; otherwise create a
        // fresh one from the stored workdir.
        let tracker = {
            let tmap = trackers.lock().await;
            tmap.get(&session_id).cloned()
        };
        let tracker = match tracker {
            Some(t) => t,
            None => {
                let t = Arc::new(FileTracker::new(&session_id, &workdir).await);
                trackers.lock().await.insert(session_id.clone(), t.clone());
                t
            }
        };

        let child = codex_cmd()
            .args(["exec", "resume", "--json"])
            .args(&self.extra_args)
            .args([&thread_id, &text])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        drive_process(child, sessions, session_id, Some(tracker), emit).await;
        Ok(())
    }
}

// ── Process driver ────────────────────────────────────────────────────────────

/// Registers the child in the session map and spawns a background task that
/// reads JSONL from stdout, maps each line to AgentEvents via `parse_line_all`,
/// and calls `emit` for every resulting event.
///
/// `tracker` (when `Some`) is used to enrich `FileEdit` events with diff data.
/// Enrichment is spawned as a separate tokio task so it doesn't block the JSONL
/// reader; the enriched event is emitted once the diff is computed.
async fn drive_process(
    mut child: Child,
    sessions: SessionMap,
    session_id: String,
    tracker: Option<Arc<FileTracker>>,
    emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
) {
    // Split stdout/stderr before moving the child into the session map.
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // Store handle; thread_id will be filled when thread.started arrives.
    {
        let mut guard = sessions.lock().await;
        guard.insert(
            session_id.clone(),
            SessionHandle {
                thread_id: None,
                child,
                tracker: tracker.clone(),
                followup_tx: None,
            },
        );
    }

    let sid = session_id.clone();
    let sessions_task = sessions.clone();
    let emit = Arc::new(emit);
    let emit_err = emit.clone();

    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut stderr_lines = BufReader::new(stderr).lines();

        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            // Use parse_line_all so every event on a line (e.g. Usage + TurnCompleted
            // from turn.completed, or multiple FileEdit from file_change) is emitted.
            for event in parse_line_all(trimmed, &sid) {
                // If we got session_started, stash the thread_id.
                if let AgentEvent::SessionStarted { ref thread_id, .. } = event {
                    let mut guard = sessions_task.lock().await;
                    if let Some(handle) = guard.get_mut(&sid) {
                        handle.thread_id = Some(thread_id.clone());
                    }
                }

                // For FileEdit events, enrich asynchronously with diff data.
                if let AgentEvent::FileEdit { ref path, ref kind, .. } = event {
                    if let Some(ref t) = tracker {
                        let t_clone = t.clone();
                        let path_c = path.clone();
                        let kind_c = kind.clone();
                        let sid_c = sid.clone();
                        let emit_c = emit.clone();
                        tokio::spawn(async move {
                            let enriched = t_clone.enrich_file_edit(&path_c, &kind_c).await;
                            emit_c(AgentEventEnvelope {
                                session_id: sid_c,
                                event: enriched,
                            });
                        });
                        continue; // skip the raw (unenriched) emit below
                    }
                }

                emit(AgentEventEnvelope {
                    session_id: sid.clone(),
                    event,
                });
            }
        }

        // Collect stderr in case of failure.
        let mut stderr_buf = String::new();
        while let Ok(Some(line)) = stderr_lines.next_line().await {
            if !stderr_buf.is_empty() {
                stderr_buf.push('\n');
            }
            stderr_buf.push_str(&line);
        }

        // Wait for process to exit; emit error on non-zero.
        let mut guard = sessions_task.lock().await;
        if let Some(handle) = guard.get_mut(&sid) {
            if let Ok(status) = handle.child.wait().await {
                if !status.success() && !stderr_buf.is_empty() {
                    emit_err(AgentEventEnvelope {
                        session_id: sid.clone(),
                        event: AgentEvent::Error {
                            message: stderr_buf,
                        },
                    });
                }
            }
        }
        // Remove session after it exits.
        guard.remove(&sid);
    });
}

// ── JSONL → AgentEvent parser ─────────────────────────────────────────────────

/// Parse a single JSONL line and return ALL resulting events.
///
/// Key behaviours:
/// - `item.started` events are **filtered out** entirely; the frontend only
///   needs `item.completed` data.
/// - `item.completed` with `file_change` emits **one `FileEdit` per entry** in
///   `changes[]` (fixes the previous single-change bug).
/// - `turn.completed` emits both `Usage` (when present) and `TurnCompleted`.
pub fn parse_line_all(line: &str, session_id: &str) -> Vec<AgentEvent> {
    let raw: RawEvent = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            return vec![AgentEvent::ToolCall {
                name: "unknown".to_string(),
                detail: line.to_string(),
            }];
        }
    };

    match raw.kind.as_str() {
        "thread.started" => {
            let thread_id = raw.thread_id.unwrap_or_default();
            vec![AgentEvent::SessionStarted {
                session_id: session_id.to_string(),
                thread_id,
            }]
        }

        "turn.started" => vec![], // no useful payload for frontend

        // item.started: always filtered out — frontend only needs completed data.
        // (Previously file_change item.started was forwarded with a "started:" kind
        // prefix; that was noisy and is now dropped here.)
        "item.started" => vec![],

        "item.completed" => {
            let item = match raw.item {
                Some(i) => i,
                None => return vec![],
            };
            match item.kind.as_str() {
                "agent_message" => vec![AgentEvent::AssistantMessage {
                    text: item.text.unwrap_or_default(),
                }],

                "command_execution" => {
                    let cmd = item.command.unwrap_or_default();
                    let output = item.aggregated_output.unwrap_or_default();
                    let output_tail = tail_2000(&output);
                    let exit_code = extract_exit_code(item.exit_code);
                    vec![AgentEvent::CommandRun {
                        cmd,
                        exit_code,
                        output_tail,
                    }]
                }

                "file_change" => {
                    // Emit one FileEdit per changed path (fixes single-change-only bug).
                    // diff/added/removed are initially empty; drive_process enriches them
                    // asynchronously via the FileTracker before re-emitting.
                    let changes = item.changes.unwrap_or_default();
                    changes
                        .into_iter()
                        .map(|c| AgentEvent::FileEdit {
                            path: c.path,
                            kind: c.kind,
                            diff: None,
                            added: 0,
                            removed: 0,
                            snapshot_path: None,
                        })
                        .collect()
                }

                other => vec![AgentEvent::ToolCall {
                    name: other.to_string(),
                    detail: line_truncated(line),
                }],
            }
        }

        "turn.completed" => {
            // Emit Usage (when present) followed by TurnCompleted.
            let mut events = Vec::new();
            if let Some(usage) = raw.usage {
                events.push(AgentEvent::Usage {
                    input_tokens: usage.input_tokens,
                    cached_input_tokens: usage.cached_input_tokens,
                    output_tokens: usage.output_tokens,
                    reasoning_output_tokens: usage.reasoning_output_tokens,
                });
            }
            events.push(AgentEvent::TurnCompleted {});
            events
        }

        _ => {
            // Unknown top-level type — emit as tool_call fallback.
            vec![AgentEvent::ToolCall {
                name: "unknown".to_string(),
                detail: line_truncated(line),
            }]
        }
    }
}

/// Parse a single JSONL line into the first AgentEvent it produces.
/// Prefer `parse_line_all` when multiple events per line are expected
/// (e.g. `turn.completed` → Usage + TurnCompleted).
pub fn parse_line(line: &str, session_id: &str) -> Option<AgentEvent> {
    parse_line_all(line, session_id).into_iter().next()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Return a `Command` that will invoke the `codex` CLI.
///
/// On Windows, `.cmd` wrappers cannot be spawned directly by `CreateProcess`;
/// they must be run through `cmd.exe /c`. On other platforms, `codex` is
/// invoked directly.
fn codex_cmd() -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "codex"]);
        cmd.no_window();
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("codex");
        cmd.no_window();
        cmd
    }
}

fn tail_2000(s: &str) -> String {
    if s.len() <= 2000 {
        s.to_string()
    } else {
        // Find a char boundary near the end.
        let start = s.len() - 2000;
        let start = s
            .char_indices()
            .map(|(i, _)| i)
            .filter(|&i| i >= start)
            .next()
            .unwrap_or(start);
        s[start..].to_string()
    }
}

fn extract_exit_code(v: Option<serde_json::Value>) -> i64 {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(-1),
        _ => -1,
    }
}

fn line_truncated(line: &str) -> String {
    if line.len() > 500 {
        format!("{}…", &line[..500])
    } else {
        line.to_string()
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "test-session";

    // ── item.started filtering ────────────────────────────────────────────────

    #[test]
    fn item_started_file_change_emits_no_events() {
        let line = r#"{"type":"item.started","item":{"id":"item_6","type":"file_change","changes":[{"path":"/tmp/foo.py","kind":"update"}],"status":"in_progress"}}"#;
        let events = parse_line_all(line, SID);
        assert!(
            events.is_empty(),
            "expected no events for item.started file_change, got: {:?}",
            events
        );
    }

    #[test]
    fn item_started_command_execution_emits_no_events() {
        let line = r#"{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"echo hi","aggregated_output":"","exit_code":null,"status":"in_progress"}}"#;
        let events = parse_line_all(line, SID);
        assert!(
            events.is_empty(),
            "expected no events for item.started command_execution, got: {:?}",
            events
        );
    }

    // ── multi-change file_change ──────────────────────────────────────────────

    #[test]
    fn item_completed_file_change_multi_emits_all_changes() {
        let line = r#"{"type":"item.completed","item":{"id":"item_6","type":"file_change","changes":[{"path":"/tmp/foo.py","kind":"update"},{"path":"/tmp/bar.rs","kind":"create"}],"status":"completed"}}"#;
        let events = parse_line_all(line, SID);
        assert_eq!(
            events.len(),
            2,
            "expected 2 FileEdit events, got: {:?}",
            events
        );
        match (&events[0], &events[1]) {
            (
                AgentEvent::FileEdit { path: p0, kind: k0, .. },
                AgentEvent::FileEdit { path: p1, kind: k1, .. },
            ) => {
                assert!(p0.contains("foo.py"), "wrong path[0]: {}", p0);
                assert_eq!(k0, "update");
                assert!(p1.contains("bar.rs"), "wrong path[1]: {}", p1);
                assert_eq!(k1, "create");
            }
            _ => panic!("unexpected events: {:?}", events),
        }
    }

    #[test]
    fn item_completed_file_change_single_emits_one() {
        let line = r#"{"type":"item.completed","item":{"id":"item_6","type":"file_change","changes":[{"path":"/tmp/only.py","kind":"update"}],"status":"completed"}}"#;
        let events = parse_line_all(line, SID);
        assert_eq!(events.len(), 1, "expected 1 FileEdit, got: {:?}", events);
        match &events[0] {
            AgentEvent::FileEdit { path, kind, .. } => {
                assert!(path.contains("only.py"));
                assert_eq!(kind, "update");
            }
            other => panic!("expected FileEdit, got {:?}", other),
        }
    }

    // ── turn.completed emits both Usage and TurnCompleted ────────────────────

    #[test]
    fn turn_completed_emits_usage_then_turn_completed() {
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":20,"reasoning_output_tokens":5}}"#;
        let events = parse_line_all(line, SID);
        assert_eq!(events.len(), 2, "expected 2 events, got: {:?}", events);
        match &events[0] {
            AgentEvent::Usage {
                input_tokens,
                cached_input_tokens,
                output_tokens,
                reasoning_output_tokens,
            } => {
                assert_eq!(*input_tokens, 100);
                assert_eq!(*cached_input_tokens, 50);
                assert_eq!(*output_tokens, 20);
                assert_eq!(*reasoning_output_tokens, 5);
            }
            other => panic!("expected Usage, got {:?}", other),
        }
        assert!(
            matches!(events[1], AgentEvent::TurnCompleted {}),
            "expected TurnCompleted, got {:?}",
            events[1]
        );
    }

    #[test]
    fn turn_completed_without_usage_emits_only_turn_completed() {
        let line = r#"{"type":"turn.completed"}"#;
        let events = parse_line_all(line, SID);
        assert_eq!(events.len(), 1, "expected 1 event, got: {:?}", events);
        assert!(matches!(events[0], AgentEvent::TurnCompleted {}));
    }

    // ── parse_line returns first event only ───────────────────────────────────

    #[test]
    fn parse_line_returns_first_of_turn_completed() {
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}"#;
        let ev = parse_line(line, SID);
        assert!(
            matches!(ev, Some(AgentEvent::Usage { .. })),
            "expected Some(Usage), got {:?}",
            ev
        );
    }

    #[test]
    fn parse_line_returns_none_for_item_started() {
        let line = r#"{"type":"item.started","item":{"id":"x","type":"file_change","changes":[{"path":"/a","kind":"update"}],"status":"in_progress"}}"#;
        let ev = parse_line(line, SID);
        assert!(ev.is_none(), "expected None for item.started, got {:?}", ev);
    }
}
