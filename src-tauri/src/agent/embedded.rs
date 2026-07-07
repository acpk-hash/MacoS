//! EmbeddedAdapter: drives the self-hosted `agentboard-engine` sidecar.
//!
//! The engine hosts codex-core in-process (V8 etc. live there, NOT in the Tauri
//! app). One engine process is spawned per session and kept warm across turns,
//! communicating over NDJSON on stdio. This adapter maps the engine's OutEvent
//! stream back onto the shared `AgentEvent` channel, so the rest of AgentBoard
//! (DB persistence, notifications, frontend) is unchanged.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::mpsc;

use crate::agent::codex::{
    AgentAdapter, CodexError, SessionHandle, SessionMap, TrackerMap,
};
use crate::agent::events::{AgentEvent, AgentEventEnvelope};
use crate::agent::tracker::FileTracker;

// -- Engine wire events (mirror agentboard-engine's OutEvent) -----------------
//
// Only fields this adapter reads are declared; serde ignores the rest (e.g. the
// `thread_id` present on every engine event but needed only on thread_started,
// since one engine process maps 1:1 to a session here).

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum EngineEvent {
    ThreadStarted { thread_id: String },
    SessionStarted {},
    AssistantDelta { text: String },
    AssistantMessage { text: String },
    CommandRun { cmd: String, exit_code: i64, output_tail: String },
    FileEdit {
        path: String,
        kind: String,
        #[serde(default)]
        diff: Option<String>,
        #[serde(default)]
        added: u32,
        #[serde(default)]
        removed: u32,
    },
    Usage {
        input_tokens: u64,
        cached_input_tokens: u64,
        output_tokens: u64,
        reasoning_output_tokens: u64,
    },
    TurnCompleted {},
    Error { message: String },
}

/// Map an engine event to an `AgentEvent`. Returns `None` for events folded
/// into another (session_started is folded into thread_started).
pub(crate) fn map_engine_event(ev: EngineEvent, session_id: &str) -> Option<AgentEvent> {
    match ev {
        EngineEvent::ThreadStarted { thread_id } => Some(AgentEvent::SessionStarted {
            session_id: session_id.to_string(),
            thread_id,
        }),
        EngineEvent::SessionStarted {} => None,
        EngineEvent::AssistantDelta { text } => Some(AgentEvent::AssistantDelta { text }),
        EngineEvent::AssistantMessage { text } => Some(AgentEvent::AssistantMessage { text }),
        EngineEvent::CommandRun { cmd, exit_code, output_tail } => {
            Some(AgentEvent::CommandRun { cmd, exit_code, output_tail })
        }
        EngineEvent::FileEdit { path, kind, diff, added, removed } => Some(AgentEvent::FileEdit {
            path,
            kind,
            diff,
            added,
            removed,
            snapshot_path: None,
        }),
        EngineEvent::Usage {
            input_tokens,
            cached_input_tokens,
            output_tokens,
            reasoning_output_tokens,
        } => Some(AgentEvent::Usage {
            input_tokens,
            cached_input_tokens,
            output_tokens,
            reasoning_output_tokens,
        }),
        EngineEvent::TurnCompleted {} => Some(AgentEvent::TurnCompleted {}),
        EngineEvent::Error { message } => Some(AgentEvent::Error { message }),
    }
}

// -- EmbeddedAdapter ---------------------------------------------------------

/// Adapter that spawns and drives the `agentboard-engine` sidecar.
pub struct EmbeddedAdapter {
    /// Explicit engine binary path (from settings `engine_bin_path`). When
    /// `None`, the dev-default location is used.
    pub engine_bin_path: Option<String>,
    /// Explicit codex.exe path (passed to the engine as `--codex-exe`). When
    /// `None`, it is auto-detected at spawn time.
    pub codex_exe_path: Option<String>,
    /// Sandbox level forwarded to the engine (`workspace-write` | `danger-full-access`).
    pub sandbox: String,
    /// Optional model override; `None` uses the codex config default.
    pub model: Option<String>,
}

impl Default for EmbeddedAdapter {
    fn default() -> Self {
        Self {
            engine_bin_path: None,
            codex_exe_path: None,
            sandbox: "workspace-write".to_string(),
            model: None,
        }
    }
}

/// Dev-default engine binary path: `../engine/target/release/agentboard-engine[.exe]`
/// relative to the src-tauri working directory used by `cargo tauri dev`.
fn default_engine_bin() -> PathBuf {
    #[cfg(windows)]
    let name = "agentboard-engine.exe";
    #[cfg(not(windows))]
    let name = "agentboard-engine";
    PathBuf::from("..")
        .join("engine")
        .join("target")
        .join("release")
        .join(name)
}

impl EmbeddedAdapter {
    /// Resolve the engine binary: settings override → dev default. Errors
    /// clearly (not silently) when neither exists.
    fn resolve_engine_bin(&self) -> Result<PathBuf, CodexError> {
        if let Some(p) = &self.engine_bin_path {
            let pb = PathBuf::from(p);
            if pb.exists() {
                return Ok(pb);
            }
            return Err(CodexError::Engine(format!(
                "配置的 engine_bin_path 不存在: {p}"
            )));
        }
        let dev = default_engine_bin();
        if dev.exists() {
            return Ok(dev);
        }
        Err(CodexError::Engine(format!(
            "找不到 agentboard-engine，可执行文件不存在（已尝试 {}）。请先构建 engine (cargo build --release) 或在设置中指定 engine_bin_path。",
            dev.display()
        )))
    }

    /// Resolve codex.exe for the engine's exec-server: settings override →
    /// known install dir → `where/which codex`. Errors clearly when not found.
    async fn resolve_codex_exe(&self) -> Result<String, CodexError> {
        if let Some(p) = &self.codex_exe_path {
            if PathBuf::from(p).exists() {
                return Ok(p.clone());
            }
        }
        // Known install location (Codex desktop app / npm global on Windows).
        #[cfg(windows)]
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local).join("OpenAI").join("Codex").join("bin");
            if let Ok(rd) = std::fs::read_dir(&base) {
                for e in rd.flatten() {
                    let cand = e.path().join("codex.exe");
                    if cand.exists() {
                        return Ok(cand.to_string_lossy().into_owned());
                    }
                }
            }
        }
        // Fall back to PATH lookup.
        #[cfg(windows)]
        let probe = Command::new("where").arg("codex").output().await;
        #[cfg(not(windows))]
        let probe = Command::new("which").arg("codex").output().await;
        if let Ok(out) = probe {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                for line in text.lines() {
                    let line = line.trim();
                    if line.to_ascii_lowercase().ends_with("codex.exe")
                        || (!cfg!(windows) && line.ends_with("codex"))
                    {
                        return Ok(line.to_string());
                    }
                }
                if let Some(first) = text.lines().next() {
                    if !first.trim().is_empty() {
                        return Ok(first.trim().to_string());
                    }
                }
            }
        }
        Err(CodexError::Engine(
            "找不到 codex 可执行文件（引擎的 exec-server 需要它）。请安装 codex 或在设置中指定 codex_exe_path。"
                .to_string(),
        ))
    }
}

// -- Engine process spawn + driver -------------------------------------------

/// Write a single JSON command line to the engine's stdin.
async fn write_line(stdin: &mut ChildStdin, cmd: &serde_json::Value) -> std::io::Result<()> {
    let mut s = serde_json::to_string(cmd).unwrap_or_default();
    s.push('\n');
    stdin.write_all(s.as_bytes()).await?;
    stdin.flush().await
}

impl EmbeddedAdapter {
    /// Spawn an engine process for `session_id`, issue the initial start/resume
    /// command, register the session, and launch the long-lived driver task.
    #[allow(clippy::too_many_arguments)]
    async fn spawn_engine_session(
        &self,
        session_id: String,
        sessions: SessionMap,
        tracker: Arc<FileTracker>,
        workdir: String,
        initial_prompt: String,
        resume_thread_id: Option<String>,
        emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
    ) -> Result<(), CodexError> {
        let engine_bin = self.resolve_engine_bin()?;
        let codex_exe = self.resolve_codex_exe().await?;

        let mut child = Command::new(&engine_bin)
            .args(["--codex-exe", &codex_exe])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| CodexError::Engine(format!("spawn engine 失败: {e}")))?;

        let mut stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let init_cmd = match &resume_thread_id {
            None => serde_json::json!({
                "op": "start_thread",
                "cwd": workdir,
                "model": self.model,
                "sandbox": self.sandbox,
            }),
            Some(tid) => serde_json::json!({
                "op": "resume",
                "cwd": workdir,
                "thread_id": tid,
                "model": self.model,
                "sandbox": self.sandbox,
            }),
        };
        write_line(&mut stdin, &init_cmd)
            .await
            .map_err(|e| CodexError::Engine(format!("写引擎初始命令失败: {e}")))?;

        let (followup_tx, followup_rx) = mpsc::unbounded_channel::<String>();

        {
            let mut guard = sessions.lock().await;
            guard.insert(
                session_id.clone(),
                SessionHandle {
                    thread_id: None,
                    child,
                    tracker: Some(tracker.clone()),
                    followup_tx: Some(followup_tx),
                },
            );
        }

        spawn_driver(
            stdin, stdout, stderr, session_id, sessions,
            Some(tracker), initial_prompt, followup_rx, emit,
        );
        Ok(())
    }
}

/// The per-session engine driver: reads engine stdout -> maps -> emits, sends
/// the initial user_input once thread_started arrives, and forwards follow-up
/// inputs. On engine exit it cleans up the session and reports a crash error.
#[allow(clippy::too_many_arguments)]
fn spawn_driver(
    mut stdin: ChildStdin,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    session_id: String,
    sessions: SessionMap,
    tracker: Option<Arc<FileTracker>>,
    initial_prompt: String,
    mut followup_rx: mpsc::UnboundedReceiver<String>,
    emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
) {
    let emit = Arc::new(emit);

    // Collect engine stderr for crash diagnostics.
    let stderr_buf = Arc::new(tokio::sync::Mutex::new(String::new()));
    {
        let sb = stderr_buf.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                eprintln!("[engine-stderr] {l}");
                let mut g = sb.lock().await;
                if !g.is_empty() {
                    g.push('\n');
                }
                g.push_str(&l);
            }
        });
    }

    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut thread_id: Option<String> = None;
        let mut sent_initial = false;

        loop {
            tokio::select! {
                maybe = lines.next_line() => {
                    let line = match maybe {
                        Ok(Some(l)) => l,
                        Ok(None) => break,
                        Err(_) => break,
                    };
                    let trimmed = line.trim();
                    if trimmed.is_empty() { continue; }
                    let ev: EngineEvent = match serde_json::from_str(trimmed) {
                        Ok(e) => e,
                        Err(_) => continue,
                    };

                    if let EngineEvent::ThreadStarted { thread_id: tid } = &ev {
                        thread_id = Some(tid.clone());
                        {
                            let mut g = sessions.lock().await;
                            if let Some(h) = g.get_mut(&session_id) {
                                h.thread_id = Some(tid.clone());
                            }
                        }
                        if !sent_initial {
                            let cmd = serde_json::json!({
                                "op": "user_input", "thread_id": tid, "text": initial_prompt
                            });
                            let _ = write_line(&mut stdin, &cmd).await;
                            sent_initial = true;
                        }
                    }

                    if let Some(agent_ev) = map_engine_event(ev, &session_id) {
                        if let AgentEvent::FileEdit { ref path, ref kind, .. } = agent_ev {
                            if let Some(t) = &tracker {
                                let t2 = t.clone();
                                let p = path.clone();
                                let k = kind.clone();
                                let sidc = session_id.clone();
                                let emitc = emit.clone();
                                tokio::spawn(async move {
                                    let enriched = t2.enrich_file_edit(&p, &k).await;
                                    emitc(AgentEventEnvelope { session_id: sidc, event: enriched });
                                });
                                continue;
                            }
                        }
                        emit(AgentEventEnvelope { session_id: session_id.clone(), event: agent_ev });
                    }
                }
                Some(text) = followup_rx.recv() => {
                    if let Some(tid) = &thread_id {
                        let cmd = serde_json::json!({
                            "op": "user_input", "thread_id": tid, "text": text
                        });
                        let _ = write_line(&mut stdin, &cmd).await;
                    } else {
                        emit(AgentEventEnvelope {
                            session_id: session_id.clone(),
                            event: AgentEvent::Error { message: "引擎尚未就绪，无法发送后续消息".to_string() },
                        });
                    }
                }
            }
        }

        let mut guard = sessions.lock().await;
        if let Some(mut handle) = guard.remove(&session_id) {
            if let Ok(status) = handle.child.wait().await {
                let sb = stderr_buf.lock().await;
                if !status.success() && !sb.is_empty() {
                    emit(AgentEventEnvelope {
                        session_id: session_id.clone(),
                        event: AgentEvent::Error { message: format!("引擎异常退出: {}", *sb) },
                    });
                }
            }
        }
    });
}

// -- AgentAdapter impl -------------------------------------------------------

impl AgentAdapter for EmbeddedAdapter {
    async fn start_session(
        &self,
        session_id: String,
        sessions: SessionMap,
        trackers: TrackerMap,
        prompt: String,
        workdir: String,
        emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
    ) -> Result<(), CodexError> {
        let tracker = Arc::new(FileTracker::new(&session_id, &workdir).await);
        {
            let mut tmap = trackers.lock().await;
            tmap.insert(session_id.clone(), tracker.clone());
        }
        self.spawn_engine_session(session_id, sessions, tracker, workdir, prompt, None, emit)
            .await
    }

    async fn send_followup(
        &self,
        sessions: SessionMap,
        _trackers: TrackerMap,
        session_id: String,
        text: String,
        _emit: impl Fn(AgentEventEnvelope) + Send + Sync + 'static,
    ) -> Result<(), CodexError> {
        // Warm path: the engine process is still alive; push the follow-up into
        // its driver task, which relays it to the resident codex thread.
        let tx = {
            let guard = sessions.lock().await;
            guard.get(&session_id).and_then(|h| h.followup_tx.clone())
        };
        match tx {
            Some(tx) => tx
                .send(text)
                .map_err(|_| CodexError::SessionNotFound(session_id)),
            None => Err(CodexError::SessionNotFound(session_id)),
        }
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

impl EmbeddedAdapter {
    /// Cold-resume a session whose engine process is gone (e.g. app restart):
    /// spawn a fresh engine, `resume` the rollout by thread_id, then send text.
    #[allow(clippy::too_many_arguments)]
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
        self.spawn_engine_session(session_id, sessions, tracker, workdir, text, Some(thread_id), emit)
            .await
    }
}

// -- Unit tests --------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::codex::{new_session_map, new_tracker_map};

    const SID: &str = "sess-1";

    fn parse(line: &str) -> EngineEvent {
        serde_json::from_str(line).expect("deserialize EngineEvent")
    }

    #[test]
    fn thread_started_maps_to_session_started() {
        let ev = parse(r#"{"type":"thread_started","thread_id":"th-123"}"#);
        match map_engine_event(ev, SID) {
            Some(AgentEvent::SessionStarted { session_id, thread_id }) => {
                assert_eq!(session_id, SID);
                assert_eq!(thread_id, "th-123");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn session_started_is_folded_to_none() {
        let ev = parse(r#"{"type":"session_started","thread_id":"th-123"}"#);
        assert!(map_engine_event(ev, SID).is_none());
    }

    #[test]
    fn assistant_delta_and_message_map() {
        let d = parse(r#"{"type":"assistant_delta","thread_id":"t","text":"hel"}"#);
        assert!(matches!(map_engine_event(d, SID), Some(AgentEvent::AssistantDelta { text }) if text == "hel"));
        let m = parse(r#"{"type":"assistant_message","thread_id":"t","text":"hello"}"#);
        assert!(matches!(map_engine_event(m, SID), Some(AgentEvent::AssistantMessage { text }) if text == "hello"));
    }

    #[test]
    fn command_run_maps_all_fields() {
        let ev = parse(r#"{"type":"command_run","thread_id":"t","cmd":"ls -la","exit_code":0,"output_tail":"a\nb"}"#);
        match map_engine_event(ev, SID) {
            Some(AgentEvent::CommandRun { cmd, exit_code, output_tail }) => {
                assert_eq!(cmd, "ls -la");
                assert_eq!(exit_code, 0);
                assert_eq!(output_tail, "a\nb");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn file_edit_maps_with_diff_and_counts() {
        let ev = parse(r#"{"type":"file_edit","thread_id":"t","path":"/x/y.rs","kind":"update","diff":"@@\n+a\n-b","added":1,"removed":1}"#);
        match map_engine_event(ev, SID) {
            Some(AgentEvent::FileEdit { path, kind, diff, added, removed, snapshot_path }) => {
                assert_eq!(path, "/x/y.rs");
                assert_eq!(kind, "update");
                assert_eq!(diff.as_deref(), Some("@@\n+a\n-b"));
                assert_eq!(added, 1);
                assert_eq!(removed, 1);
                assert!(snapshot_path.is_none());
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn file_edit_add_without_diff() {
        // `diff` omitted (engine skips it for adds) must default to None.
        let ev = parse(r#"{"type":"file_edit","thread_id":"t","path":"/n","kind":"add","added":3,"removed":0}"#);
        match map_engine_event(ev, SID) {
            Some(AgentEvent::FileEdit { kind, diff, added, .. }) => {
                assert_eq!(kind, "add");
                assert!(diff.is_none());
                assert_eq!(added, 3);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn usage_maps_all_fields() {
        let ev = parse(r#"{"type":"usage","thread_id":"t","input_tokens":10,"cached_input_tokens":5,"output_tokens":3,"reasoning_output_tokens":1}"#);
        match map_engine_event(ev, SID) {
            Some(AgentEvent::Usage { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }) => {
                assert_eq!((input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens), (10, 5, 3, 1));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn turn_completed_and_error_map() {
        assert!(matches!(
            map_engine_event(parse(r#"{"type":"turn_completed","thread_id":"t"}"#), SID),
            Some(AgentEvent::TurnCompleted {})
        ));
        assert!(matches!(
            map_engine_event(parse(r#"{"type":"error","thread_id":"t","message":"boom"}"#), SID),
            Some(AgentEvent::Error { message }) if message == "boom"
        ));
    }

    #[test]
    fn resolve_engine_bin_missing_override_errors() {
        let adapter = EmbeddedAdapter {
            engine_bin_path: Some("Z:/does/not/exist/agentboard-engine.exe".to_string()),
            ..Default::default()
        };
        let err = adapter.resolve_engine_bin().unwrap_err();
        assert!(matches!(err, CodexError::Engine(_)), "expected Engine error, got {err:?}");
    }

    #[test]
    fn resolve_engine_bin_existing_override_ok() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let adapter = EmbeddedAdapter {
            engine_bin_path: Some(tmp.path().to_str().unwrap().to_string()),
            ..Default::default()
        };
        let resolved = adapter.resolve_engine_bin().expect("should resolve existing file");
        assert_eq!(resolved, tmp.path());
    }

    /// LIVE: spawns the real engine (release build) and runs one turn that
    /// creates a file. Requires `cargo build --release` in ../engine and a
    /// working codex install + ~/.codex auth. Run with:
    ///   cargo test --release live_embedded_creates_file -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_embedded_creates_file() {
        use std::time::Duration;

        let tmp = tempfile::tempdir().unwrap();
        let workdir = tmp.path().to_str().unwrap().to_string();
        let sessions = new_session_map();
        let trackers = new_tracker_map();
        let (tx, mut rx) = mpsc::unbounded_channel::<AgentEvent>();

        let adapter = EmbeddedAdapter {
            sandbox: "danger-full-access".to_string(),
            ..Default::default()
        };
        let sid = "live-embedded".to_string();
        let emit = move |env: AgentEventEnvelope| {
            let _ = tx.send(env.event);
        };

        adapter
            .start_session(
                sid.clone(),
                sessions.clone(),
                trackers.clone(),
                "Create a file named hello_embedded.txt containing 'embedded works'".to_string(),
                workdir.clone(),
                emit,
            )
            .await
            .expect("start_session should spawn engine");

        let mut completed = false;
        loop {
            match tokio::time::timeout(Duration::from_secs(240), rx.recv()).await {
                Ok(Some(AgentEvent::TurnCompleted {})) => {
                    completed = true;
                    break;
                }
                Ok(Some(AgentEvent::Error { message })) => panic!("engine error: {message}"),
                Ok(Some(ev)) => eprintln!("[live] {ev:?}"),
                Ok(None) => break,
                Err(_) => break,
            }
        }

        assert!(completed, "turn did not complete within timeout");
        let created = tmp.path().join("hello_embedded.txt");
        assert!(created.exists(), "hello_embedded.txt was not created");
    }
}
