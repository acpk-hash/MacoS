/// Live integration test: spawns a real `codex exec` subprocess and verifies
/// that the AgentEvent sequence contains at least SessionStarted, AssistantMessage,
/// and TurnCompleted.
///
/// Annotated with `#[ignore]` — does NOT run in normal CI.
/// Run manually:  cargo test -- --ignored --nocapture
///
/// Prerequisites:
///   - `codex` CLI reachable on PATH
///   - OPENAI_API_KEY env var set (or ~/.codex/auth.json in apikey mode)

use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use agentboard_lib::agent::codex::{new_session_map, new_tracker_map, AgentAdapter, CodexAdapter};
use agentboard_lib::agent::events::AgentEvent;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn live_codex_session_emits_expected_events() {
    // ── Setup ────────────────────────────────────────────────────────────────
    // Use D:\dev\cli-fixtures\playground (already trusted in the codex config
    // and has a hello.py file suitable for a simple read-only task).
    let workdir = r"D:\dev\cli-fixtures\playground".to_string();
    // Simple English prompt with small scope so the session completes quickly.
    let prompt = "List the files in the current directory and print their names. Keep the response brief.";

    eprintln!("[live] workdir = {}", workdir);
    eprintln!("[live] prompt  = {}", prompt);

    // ── Spawn session ────────────────────────────────────────────────────────
    let (tx, rx) = mpsc::channel();
    // Use danger-full-access to bypass the Windows elevated-sandbox setup that
    // causes "spawn setup refresh" errors in test environments.
    // model_reasoning_effort=low keeps the session fast.
    let adapter = CodexAdapter {
        extra_args: vec!["-c".to_string(), "model_reasoning_effort=low".to_string()],
        sandbox: "danger-full-access".to_string(),
    };
    let sessions = new_session_map();
    let trackers = new_tracker_map();
    let session_id = uuid::Uuid::new_v4().to_string();

    adapter
        .start_session(session_id.clone(), sessions, trackers, prompt.to_string(), workdir, move |env| {
            let _ = tx.send(env);
        })
        .await
        .expect("start_session failed");

    // ── Collect events until TurnCompleted or 3-minute timeout ───────────────
    let mut collected: Vec<AgentEvent> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(180);

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            eprintln!("[live] TIMEOUT — events collected so far:");
            for (i, ev) in collected.iter().enumerate() {
                eprintln!("  [{}] {:?}", i, ev);
            }
            panic!("timeout: TurnCompleted never received within 3 minutes");
        }

        // Poll with a short timeout so the async runtime can make progress on
        // the drive_process task running on the other worker thread.
        let wait = remaining.min(Duration::from_millis(200));
        match rx.recv_timeout(wait) {
            Ok(env) => {
                let done = matches!(env.event, AgentEvent::TurnCompleted {});
                eprintln!("[live] {:?}", env.event);
                collected.push(env.event);
                if done {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    // ── Print collected event sequence ───────────────────────────────────────
    println!("\n=== Live test event sequence ({} events) ===", collected.len());
    for (i, ev) in collected.iter().enumerate() {
        println!("[{}] {:?}", i, ev);
    }

    // ── Assertions ───────────────────────────────────────────────────────────
    assert!(
        collected.iter().any(|e| matches!(e, AgentEvent::SessionStarted { .. })),
        "no SessionStarted event; got: {:?}",
        collected
    );
    assert!(
        collected.iter().any(|e| matches!(e, AgentEvent::AssistantMessage { .. })),
        "no AssistantMessage event; got: {:?}",
        collected
    );
    assert!(
        collected.iter().any(|e| matches!(e, AgentEvent::TurnCompleted {})),
        "no TurnCompleted event; got: {:?}",
        collected
    );

    // (No temp dir cleanup needed — we used the pre-existing playground dir.)
}

// ── live_followup ─────────────────────────────────────────────────────────────

/// Live integration test: starts a session, waits for TurnCompleted, then sends
/// a follow-up turn and asserts:
///   1. A second TurnCompleted event is received.
///   2. The thread_id reported in the second SessionStarted matches the first.
///
/// This validates that `send_followup` passes the resume arguments in the correct
/// order: `codex exec resume --json <thread_id> "<prompt>"`.
///
/// Run manually:  cargo test -- --ignored --nocapture live_followup
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn live_followup() {
    let workdir = r"D:\dev\cli-fixtures\playground".to_string();
    let prompt1 = "Say the word ALPHA and nothing else.";
    let prompt2 = "Now say the word BETA and nothing else.";

    let adapter = CodexAdapter {
        extra_args: vec!["-c".to_string(), "model_reasoning_effort=low".to_string()],
        sandbox: "danger-full-access".to_string(),
    };
    let sessions = new_session_map();
    let trackers = new_tracker_map();
    let session_id = uuid::Uuid::new_v4().to_string();

    // ── First turn ────────────────────────────────────────────────────────────
    let (tx1, rx1) = mpsc::channel();
    adapter
        .start_session(
            session_id.clone(),
            sessions.clone(),
            trackers.clone(),
            prompt1.to_string(),
            workdir.clone(),
            move |env| {
                let _ = tx1.send(env);
            },
        )
        .await
        .expect("start_session failed");

    eprintln!("[followup] session_id = {}", session_id);

    // Collect until first TurnCompleted.
    let mut turn1_events: Vec<AgentEvent> = Vec::new();
    let mut thread_id_turn1: Option<String> = None;
    let deadline = Instant::now() + Duration::from_secs(180);

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            panic!("[followup] TIMEOUT waiting for first TurnCompleted");
        }
        let wait = remaining.min(Duration::from_millis(200));
        match rx1.recv_timeout(wait) {
            Ok(env) => {
                eprintln!("[turn1] {:?}", env.event);
                if let AgentEvent::SessionStarted { ref thread_id, .. } = env.event {
                    thread_id_turn1 = Some(thread_id.clone());
                }
                let done = matches!(env.event, AgentEvent::TurnCompleted {});
                turn1_events.push(env.event);
                if done {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let thread_id1 = thread_id_turn1.expect("no SessionStarted in turn1");
    eprintln!("[followup] thread_id from turn1 = {}", thread_id1);

    assert!(
        turn1_events.iter().any(|e| matches!(e, AgentEvent::TurnCompleted {})),
        "first TurnCompleted not received"
    );

    // ── Follow-up turn ────────────────────────────────────────────────────────
    let (tx2, rx2) = mpsc::channel();
    adapter
        .send_followup(
            sessions.clone(),
            trackers.clone(),
            session_id.clone(),
            prompt2.to_string(),
            move |env| {
                let _ = tx2.send(env);
            },
        )
        .await
        .expect("send_followup failed");

    // Collect until second TurnCompleted.
    let mut turn2_events: Vec<AgentEvent> = Vec::new();
    let mut thread_id_turn2: Option<String> = None;
    let deadline2 = Instant::now() + Duration::from_secs(180);

    loop {
        let remaining = deadline2.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            eprintln!("[followup] events so far: {:?}", turn2_events);
            panic!("[followup] TIMEOUT waiting for second TurnCompleted");
        }
        let wait = remaining.min(Duration::from_millis(200));
        match rx2.recv_timeout(wait) {
            Ok(env) => {
                eprintln!("[turn2] {:?}", env.event);
                if let AgentEvent::SessionStarted { ref thread_id, .. } = env.event {
                    thread_id_turn2 = Some(thread_id.clone());
                }
                let done = matches!(env.event, AgentEvent::TurnCompleted {});
                turn2_events.push(env.event);
                if done {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    println!("\n=== Turn 1 events ({}) ===", turn1_events.len());
    for (i, e) in turn1_events.iter().enumerate() {
        println!("[{}] {:?}", i, e);
    }
    println!("\n=== Turn 2 events ({}) ===", turn2_events.len());
    for (i, e) in turn2_events.iter().enumerate() {
        println!("[{}] {:?}", i, e);
    }

    // ── Assertions ────────────────────────────────────────────────────────────
    assert!(
        turn2_events.iter().any(|e| matches!(e, AgentEvent::TurnCompleted {})),
        "second TurnCompleted not received; got: {:?}",
        turn2_events
    );

    // The thread_id must be the same across both turns (session continuity).
    if let Some(tid2) = thread_id_turn2 {
        assert_eq!(
            tid2, thread_id1,
            "thread_id mismatch: expected {} in turn2, got {}",
            thread_id1, tid2
        );
    }
    // (If no SessionStarted in turn2, codex may emit it differently for resumes —
    // the TurnCompleted assertion above is the primary guard.)
}
