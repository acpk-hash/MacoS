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

use agentboard_lib::agent::codex::{new_session_map, AgentAdapter, CodexAdapter};
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

    adapter
        .start_session(sessions, prompt.to_string(), workdir, move |env| {
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
