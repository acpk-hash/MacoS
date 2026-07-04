use serde::{Deserialize, Serialize};

/// Unified agent event emitted to the frontend via Tauri events.
/// Serializes with `tag = "type"` using snake_case variant names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// Session started; provides the thread_id for follow-up / resume.
    SessionStarted {
        session_id: String,
        thread_id: String,
    },
    /// Assistant prose message (whole, not streaming).
    AssistantMessage { text: String },
    /// Chain-of-thought / reasoning text (not observed in codex yet, reserved).
    Reasoning { text: String },
    /// Any tool invocation (generic; file_change / command_execution get richer events).
    ToolCall { name: String, detail: String },
    /// A file was created, updated, or deleted.
    FileEdit { path: String, kind: String },
    /// A shell command ran to completion (or failure).
    CommandRun {
        cmd: String,
        exit_code: i64,
        /// Last 2000 characters of aggregated_output.
        output_tail: String,
    },
    /// Token usage at end of turn.
    Usage {
        input_tokens: u64,
        cached_input_tokens: u64,
        output_tokens: u64,
        reasoning_output_tokens: u64,
    },
    /// The turn is complete; process will exit shortly.
    TurnCompleted {},
    /// An error occurred (stderr or non-zero exit).
    Error { message: String },
}

/// The envelope emitted on the "agent-event" Tauri event channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEventEnvelope {
    pub session_id: String,
    pub event: AgentEvent,
}

// ── Internal raw codex JSONL types (private to parsing) ──────────────────────

#[derive(Debug, Deserialize)]
pub(crate) struct RawEvent {
    #[serde(rename = "type")]
    pub kind: String,
    // thread.started
    pub thread_id: Option<String>,
    // item.started / item.completed
    pub item: Option<RawItem>,
    // turn.completed
    pub usage: Option<RawUsage>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawItem {
    #[serde(rename = "type")]
    pub kind: String,
    // agent_message
    pub text: Option<String>,
    // command_execution
    pub command: Option<String>,
    pub aggregated_output: Option<String>,
    pub exit_code: Option<serde_json::Value>, // int or null
    #[allow(dead_code)] // captured for completeness; status-based filtering done on item.kind
    pub status: Option<String>,
    // file_change
    pub changes: Option<Vec<RawFileChange>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawFileChange {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
}
