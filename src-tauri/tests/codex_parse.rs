/// Integration-style parsing tests using the real JSONL fixtures captured from
/// codex-cli 0.134.0. Each test reads the fixture line-by-line, parses via
/// `parse_line_all`, and asserts the event sequence.

use agentboard_lib::agent::codex::parse_line_all;
use agentboard_lib::agent::events::AgentEvent;

const EXEC_FIXTURE: &str = include_str!("fixtures/codex-exec-sample.jsonl");
const RESUME_FIXTURE: &str = include_str!("fixtures/codex-resume-sample.jsonl");

const FAKE_SESSION: &str = "test-session-id";

fn parse_fixture(jsonl: &str) -> Vec<AgentEvent> {
    jsonl
        .lines()
        .filter(|l| !l.trim().is_empty())
        .flat_map(|line| parse_line_all(line, FAKE_SESSION))
        .collect()
}

// ── exec fixture tests ────────────────────────────────────────────────────────

#[test]
fn exec_first_event_is_session_started() {
    let events = parse_fixture(EXEC_FIXTURE);
    assert!(!events.is_empty(), "no events parsed");

    match &events[0] {
        AgentEvent::SessionStarted { session_id, thread_id } => {
            assert_eq!(session_id, FAKE_SESSION);
            assert_eq!(thread_id, "019f2e35-875e-7521-a239-df80774aff3a");
        }
        other => panic!("expected SessionStarted, got {:?}", other),
    }
}

#[test]
fn exec_contains_assistant_message() {
    let events = parse_fixture(EXEC_FIXTURE);
    let msgs: Vec<_> = events
        .iter()
        .filter_map(|e| {
            if let AgentEvent::AssistantMessage { text } = e {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect();

    assert!(!msgs.is_empty(), "no AssistantMessage events");
    // First message mentions inspecting the workspace.
    assert!(
        msgs[0].contains("inspect"),
        "unexpected first message: {}",
        msgs[0]
    );
}

#[test]
fn exec_contains_file_edit_with_correct_path() {
    let events = parse_fixture(EXEC_FIXTURE);
    let file_edits: Vec<_> = events
        .iter()
        .filter_map(|e| {
            if let AgentEvent::FileEdit { path, kind } = e {
                Some((path.as_str(), kind.as_str()))
            } else {
                None
            }
        })
        .collect();

    assert!(!file_edits.is_empty(), "no FileEdit events");
    let (path, kind) = file_edits
        .iter()
        .find(|(_, k)| !k.starts_with("started:"))
        .expect("no completed FileEdit");
    assert!(
        path.contains("hello.py"),
        "unexpected path: {}",
        path
    );
    assert_eq!(*kind, "update");
}

#[test]
fn exec_contains_command_run_with_exit_code() {
    let events = parse_fixture(EXEC_FIXTURE);
    let cmds: Vec<_> = events
        .iter()
        .filter_map(|e| {
            if let AgentEvent::CommandRun { cmd, exit_code, .. } = e {
                Some((cmd.as_str(), *exit_code))
            } else {
                None
            }
        })
        .collect();

    assert!(!cmds.is_empty(), "no CommandRun events");

    // There should be at least one successful command (exit_code == 0).
    assert!(
        cmds.iter().any(|(_, code)| *code == 0),
        "no successful command found: {:?}",
        cmds
    );

    // There should be at least one failed command (exit_code == -1, sandbox error).
    assert!(
        cmds.iter().any(|(_, code)| *code == -1),
        "no failed command found: {:?}",
        cmds
    );
}

#[test]
fn exec_output_tail_truncated_to_2000() {
    // Build a synthetic command_run line with >2000 chars of output.
    let long_output = "x".repeat(3000);
    let line = format!(
        r#"{{"type":"item.completed","item":{{"id":"item_99","type":"command_execution","command":"echo","aggregated_output":"{long_output}","exit_code":0,"status":"completed"}}}}"#
    );
    let events = parse_line_all(&line, FAKE_SESSION);
    match events.first().expect("no event") {
        AgentEvent::CommandRun { output_tail, .. } => {
            assert!(
                output_tail.len() <= 2000,
                "output_tail too long: {}",
                output_tail.len()
            );
        }
        other => panic!("expected CommandRun, got {:?}", other),
    }
}

#[test]
fn exec_usage_values_match_fixture() {
    let events = parse_fixture(EXEC_FIXTURE);
    let usage = events
        .iter()
        .find_map(|e| {
            if let AgentEvent::Usage {
                input_tokens,
                cached_input_tokens,
                output_tokens,
                reasoning_output_tokens,
            } = e
            {
                Some((*input_tokens, *cached_input_tokens, *output_tokens, *reasoning_output_tokens))
            } else {
                None
            }
        })
        .expect("no Usage event");

    assert_eq!(usage.0, 67596, "input_tokens mismatch");
    assert_eq!(usage.1, 54144, "cached_input_tokens mismatch");
    assert_eq!(usage.2, 501, "output_tokens mismatch");
    assert_eq!(usage.3, 35, "reasoning_output_tokens mismatch");
}

#[test]
fn exec_ends_with_turn_completed() {
    let events = parse_fixture(EXEC_FIXTURE);
    let last = events.last().expect("no events");
    assert!(
        matches!(last, AgentEvent::TurnCompleted {}),
        "last event was not TurnCompleted, got {:?}",
        last
    );
}

// ── resume fixture tests ──────────────────────────────────────────────────────

#[test]
fn resume_thread_id_matches_original() {
    let events = parse_fixture(RESUME_FIXTURE);
    match &events[0] {
        AgentEvent::SessionStarted { thread_id, .. } => {
            // Same thread_id as the exec fixture — confirms session continuity.
            assert_eq!(thread_id, "019f2e35-875e-7521-a239-df80774aff3a");
        }
        other => panic!("expected SessionStarted, got {:?}", other),
    }
}

#[test]
fn resume_usage_values_match_fixture() {
    let events = parse_fixture(RESUME_FIXTURE);
    let usage = events
        .iter()
        .find_map(|e| {
            if let AgentEvent::Usage {
                input_tokens,
                output_tokens,
                ..
            } = e
            {
                Some((*input_tokens, *output_tokens))
            } else {
                None
            }
        })
        .expect("no Usage event in resume fixture");

    assert_eq!(usage.0, 110229, "input_tokens mismatch");
    assert_eq!(usage.1, 922, "output_tokens mismatch");
}

#[test]
fn resume_ends_with_turn_completed() {
    let events = parse_fixture(RESUME_FIXTURE);
    let last = events.last().expect("no events");
    assert!(
        matches!(last, AgentEvent::TurnCompleted {}),
        "last event was not TurnCompleted, got {:?}",
        last
    );
}

// ── item.started filtering (no "started:" prefixed events) ───────────────────

#[test]
fn exec_no_started_prefixed_file_edit_events() {
    let events = parse_fixture(EXEC_FIXTURE);
    let started_edits: Vec<_> = events
        .iter()
        .filter_map(|e| {
            if let AgentEvent::FileEdit { kind, .. } = e {
                if kind.starts_with("started:") { Some(kind.as_str()) } else { None }
            } else {
                None
            }
        })
        .collect();
    assert!(
        started_edits.is_empty(),
        "unexpected 'started:' prefixed FileEdit events: {:?}",
        started_edits
    );
}

#[test]
fn exec_file_edit_count_equals_completed_items_only() {
    // The exec fixture has exactly 1 item.completed file_change (item_6).
    // The item.started for item_6 must not produce any FileEdit event.
    let events = parse_fixture(EXEC_FIXTURE);
    let file_edit_count = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::FileEdit { .. }))
        .count();
    assert_eq!(file_edit_count, 1, "expected exactly 1 FileEdit event (from item.completed only)");
}

// ── fallback / unknown line tests ─────────────────────────────────────────────

#[test]
fn unknown_json_type_emits_tool_call_unknown() {
    let line = r#"{"type":"some.future.event","data":"whatever"}"#;
    let events = parse_line_all(line, FAKE_SESSION);
    assert_eq!(events.len(), 1);
    match &events[0] {
        AgentEvent::ToolCall { name, .. } => assert_eq!(name, "unknown"),
        other => panic!("expected ToolCall, got {:?}", other),
    }
}

#[test]
fn non_json_line_emits_tool_call_unknown() {
    let line = "this is not json at all";
    let events = parse_line_all(line, FAKE_SESSION);
    assert_eq!(events.len(), 1);
    match &events[0] {
        AgentEvent::ToolCall { name, detail } => {
            assert_eq!(name, "unknown");
            assert!(detail.contains("this is not json"));
        }
        other => panic!("expected ToolCall, got {:?}", other),
    }
}
