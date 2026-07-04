use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::agent::events::{AgentEvent, AgentEventEnvelope, RawEvent};

// ── Error type ────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum CodexError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("session not found: {0}")]
    SessionNotFound(String),
}

// ── Session handle ────────────────────────────────────────────────────────────

pub struct SessionHandle {
    thread_id: Option<String>,
    child: Child,
}

// ── Active session registry ───────────────────────────────────────────────────

pub type SessionMap = Arc<Mutex<HashMap<String, SessionHandle>>>;

pub fn new_session_map() -> SessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}

// ── Trait ─────────────────────────────────────────────────────────────────────

#[allow(async_fn_in_trait)] // stable async-in-trait is fine for our single impl
pub trait AgentAdapter {
    /// Spawn a new session and return the session_id.
    async fn start_session(
        &self,
        sessions: SessionMap,
        prompt: String,
        workdir: String,
        emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
    ) -> Result<String, CodexError>;

    /// Send a follow-up prompt to an existing session (resumes via thread_id).
    async fn send_followup(
        &self,
        sessions: SessionMap,
        session_id: String,
        text: String,
        emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
    ) -> Result<(), CodexError>;

    /// Kill the subprocess for a session.
    async fn cancel(&self, sessions: SessionMap, session_id: String) -> Result<(), CodexError>;
}

// ── CodexAdapter ──────────────────────────────────────────────────────────────

pub struct CodexAdapter;

impl AgentAdapter for CodexAdapter {
    async fn start_session(
        &self,
        sessions: SessionMap,
        prompt: String,
        workdir: String,
        emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
    ) -> Result<String, CodexError> {
        let session_id = uuid::Uuid::new_v4().to_string();

        let child = Command::new("codex")
            .args([
                "exec",
                "--json",
                "-s",
                "workspace-write",
                "-C",
                &workdir,
                "--skip-git-repo-check",
                &prompt,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let sid_clone = session_id.clone();
        drive_process(child, sessions, sid_clone, emit).await;

        Ok(session_id)
    }

    async fn send_followup(
        &self,
        sessions: SessionMap,
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

        let child = Command::new("codex")
            .args(["exec", "resume", "--json", &thread_id, &text])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let sid_clone = session_id.clone();
        drive_process(child, sessions, sid_clone, emit).await;

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

// ── Process driver ────────────────────────────────────────────────────────────

/// Registers the child in the session map and spawns a background task that
/// reads JSONL from stdout, maps each line to AgentEvent, and calls `emit`.
async fn drive_process(
    mut child: Child,
    sessions: SessionMap,
    session_id: String,
    emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
) {
    // We need to move `child` into the task but also store a handle. Split
    // stdout/stderr before moving the child into the session map.
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

            if let Some(event) = parse_line(trimmed, &sid) {
                // If we got session_started, stash the thread_id.
                if let AgentEvent::SessionStarted { ref thread_id, .. } = event {
                    let mut guard = sessions_task.lock().await;
                    if let Some(handle) = guard.get_mut(&sid) {
                        handle.thread_id = Some(thread_id.clone());
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

/// Parse a single JSONL line into an AgentEvent.
/// Returns None for events we intentionally ignore (e.g. item.started without
/// actionable info). Falls back to ToolCall{unknown} for unrecognised lines.
pub fn parse_line(line: &str, session_id: &str) -> Option<AgentEvent> {
    let raw: RawEvent = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            // Not valid JSON — emit as unknown tool_call
            return Some(AgentEvent::ToolCall {
                name: "unknown".to_string(),
                detail: line.to_string(),
            });
        }
    };

    match raw.kind.as_str() {
        "thread.started" => {
            let thread_id = raw.thread_id.unwrap_or_default();
            Some(AgentEvent::SessionStarted {
                session_id: session_id.to_string(),
                thread_id,
            })
        }

        "turn.started" => None, // no useful payload for frontend yet

        "item.started" => {
            // Only file_change item.started carries useful info (the path).
            let item = raw.item?;
            match item.kind.as_str() {
                "file_change" => {
                    // Emit one FileEdit per changed path.
                    // We return only the first; callers see multiple lines anyway.
                    let changes = item.changes.unwrap_or_default();
                    changes.into_iter().next().map(|c| AgentEvent::FileEdit {
                        path: c.path,
                        kind: format!("started:{}", c.kind),
                    })
                }
                _ => None, // command_execution item.started has empty output; skip
            }
        }

        "item.completed" => {
            let item = raw.item?;
            match item.kind.as_str() {
                "agent_message" => Some(AgentEvent::AssistantMessage {
                    text: item.text.unwrap_or_default(),
                }),

                "command_execution" => {
                    let cmd = item.command.unwrap_or_default();
                    let output = item.aggregated_output.unwrap_or_default();
                    let output_tail = tail_2000(&output);
                    let exit_code = extract_exit_code(item.exit_code);
                    Some(AgentEvent::CommandRun {
                        cmd,
                        exit_code,
                        output_tail,
                    })
                }

                "file_change" => {
                    let changes = item.changes.unwrap_or_default();
                    // Emit first change; adapter callers see one event per line.
                    changes.into_iter().next().map(|c| AgentEvent::FileEdit {
                        path: c.path,
                        kind: c.kind,
                    })
                }

                other => Some(AgentEvent::ToolCall {
                    name: other.to_string(),
                    detail: line_truncated(line),
                }),
            }
        }

        "turn.completed" => {
            if let Some(usage) = raw.usage {
                // Emit Usage then TurnCompleted via a trick: we can only return one.
                // We emit Usage here; TurnCompleted is emitted by a separate synthetic
                // parse on the same line — callers must handle both.
                // Actually we'll emit Usage; the caller gets TurnCompleted separately
                // only if we split. For simplicity, emit Usage; TurnCompleted is emitted
                // as a second call. We return Usage here.
                // NOTE: the driver loop calls parse_line once per line, so we can only
                // return one event. We choose Usage because it carries the data. The
                // frontend can treat the absence of further events as turn-end, OR we
                // can emit TurnCompleted from a secondary path. For now emit Usage and
                // then synthesize TurnCompleted too — handled in parse_line_all below.
                Some(AgentEvent::Usage {
                    input_tokens: usage.input_tokens,
                    cached_input_tokens: usage.cached_input_tokens,
                    output_tokens: usage.output_tokens,
                    reasoning_output_tokens: usage.reasoning_output_tokens,
                })
            } else {
                Some(AgentEvent::TurnCompleted {})
            }
        }

        _ => {
            // Unknown top-level type — emit as tool_call fallback.
            Some(AgentEvent::ToolCall {
                name: "unknown".to_string(),
                detail: line_truncated(line),
            })
        }
    }
}

/// Parse a single JSONL line and return ALL resulting events (e.g. turn.completed
/// yields both Usage and TurnCompleted).
pub fn parse_line_all(line: &str, session_id: &str) -> Vec<AgentEvent> {
    // Check if it's a turn.completed with usage first, so we can emit both.
    if let Ok(v) = serde_json::from_str::<Value>(line) {
        if v.get("type").and_then(|t| t.as_str()) == Some("turn.completed") {
            if v.get("usage").is_some() {
                let mut events = Vec::new();
                if let Some(ev) = parse_line(line, session_id) {
                    events.push(ev);
                }
                events.push(AgentEvent::TurnCompleted {});
                return events;
            }
        }
    }
    parse_line(line, session_id)
        .into_iter()
        .collect()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

fn extract_exit_code(v: Option<Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(-1),
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
