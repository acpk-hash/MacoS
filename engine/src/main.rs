//! agentboard-engine: AgentBoard's self-hosted codex engine sidecar.
//!
//! Protocol (NDJSON over stdio):
//!   - stdin : one JSON command per line  (see Command)
//!   - stdout: one JSON event  per line   (see OutEvent)
//!   - stderr: human-readable logs only
//!
//! codex-core is embedded in-process here (NOT in the Tauri main process) to
//! keep V8 / the large runtime stack out of the desktop binary. See
//! docs/v0.4-embed-api-map.md for the full API map and rationale.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use codex_core::config::{Config, ConfigOverrides};
use codex_core::{
    resolve_installation_id, thread_store_from_config, CodexThread, ThreadManager,
};
use codex_exec_server::{EnvironmentManager, ExecServerRuntimePaths};
use codex_extension_api::empty_extension_registry;
use codex_login::AuthManager;
use codex_protocol::config_types::SandboxMode;
use codex_protocol::protocol::{AskForApproval, EventMsg, FileChange, Op, SessionSource};
use codex_protocol::user_input::UserInput;

// -- Wire protocol: commands (stdin) -----------------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Command {
    StartThread {
        cwd: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        sandbox: Option<String>,
    },
    UserInput { thread_id: String, text: String },
    Resume {
        cwd: String,
        thread_id: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        sandbox: Option<String>,
    },
    Interrupt { thread_id: String },
    Shutdown,
}

// -- Wire protocol: events (stdout) ------------------------------------------
// Field shapes deliberately mirror src-tauri's AgentEvent serde form.

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutEvent {
    ThreadStarted { thread_id: String },
    SessionStarted { thread_id: String },
    AssistantDelta { thread_id: String, text: String },
    AssistantMessage { thread_id: String, text: String },
    CommandRun {
        thread_id: String,
        cmd: String,
        exit_code: i64,
        output_tail: String,
    },
    FileEdit {
        thread_id: String,
        path: String,
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        diff: Option<String>,
        added: u32,
        removed: u32,
    },
    Usage {
        thread_id: String,
        input_tokens: u64,
        cached_input_tokens: u64,
        output_tokens: u64,
        reasoning_output_tokens: u64,
    },
    TurnCompleted { thread_id: String },
    Error { thread_id: String, message: String },
}

fn emit(tx: &mpsc::UnboundedSender<String>, ev: OutEvent) {
    if let Ok(s) = serde_json::to_string(&ev) {
        let _ = tx.send(s);
    }
}

// -- Engine stack (built lazily on first thread) -----------------------------

struct Built {
    thread_manager: ThreadManager,
    auth_manager: Arc<AuthManager>,
}

async fn build_config(
    codex_exe: &Option<PathBuf>,
    cwd: &str,
    model: Option<String>,
    sandbox: Option<String>,
) -> anyhow::Result<Config> {
    let cwd_path = PathBuf::from(cwd);
    let sandbox_mode = match sandbox.as_deref() {
        Some("danger-full-access") => SandboxMode::DangerFullAccess,
        _ => SandboxMode::WorkspaceWrite,
    };
    let overrides = ConfigOverrides {
        cwd: Some(cwd_path.clone()),
        model,
        approval_policy: Some(AskForApproval::Never),
        sandbox_mode: Some(sandbox_mode),
        additional_writable_roots: vec![cwd_path],
        codex_self_exe: codex_exe.clone(),
        ..Default::default()
    };
    Config::load_with_cli_overrides_and_harness_overrides(vec![], overrides)
        .await
        .map_err(|e| anyhow::anyhow!("load config: {e}"))
}

async fn build_stack(config: &Config) -> anyhow::Result<Built> {
    let auth_manager =
        AuthManager::shared_from_config(config, /*enable_codex_api_key_env*/ false).await;
    let runtime_paths = ExecServerRuntimePaths::from_optional_paths(
        config.codex_self_exe.clone(),
        config.codex_linux_sandbox_exe.clone(),
    )?;
    let env_manager = Arc::new(
        EnvironmentManager::from_codex_home(config.codex_home.clone(), Some(runtime_paths))
            .await
            .map_err(|e| anyhow::anyhow!("EnvironmentManager: {e}"))?,
    );
    let thread_store = thread_store_from_config(config, None);
    let installation_id = resolve_installation_id(&config.codex_home).await?;

    let thread_manager = ThreadManager::new(
        config,
        Arc::clone(&auth_manager),
        SessionSource::Exec,
        env_manager,
        empty_extension_registry(),
        /*analytics*/ None,
        thread_store,
        /*state_db*/ None,
        installation_id,
        /*attestation_provider*/ None,
    );

    Ok(Built { thread_manager, auth_manager })
}

// -- Per-thread event pump ---------------------------------------------------

fn spawn_pump(thread: Arc<CodexThread>, thread_id: String, tx: mpsc::UnboundedSender<String>) {
    tokio::spawn(async move {
        loop {
            let ev = match thread.next_event().await {
                Ok(ev) => ev,
                Err(e) => {
                    eprintln!("[engine] pump {thread_id} next_event error: {e}");
                    break;
                }
            };
            let tid = thread_id.clone();
            match ev.msg {
                EventMsg::SessionConfigured(_) => {
                    emit(&tx, OutEvent::SessionStarted { thread_id: tid });
                }
                EventMsg::AgentMessageContentDelta(d) => {
                    emit(&tx, OutEvent::AssistantDelta { thread_id: tid, text: d.delta });
                }
                EventMsg::AgentMessage(m) => {
                    emit(&tx, OutEvent::AssistantMessage { thread_id: tid, text: m.message });
                }
                EventMsg::ExecCommandEnd(e) => {
                    emit(&tx, OutEvent::CommandRun {
                        thread_id: tid,
                        cmd: e.command.join(" "),
                        exit_code: e.exit_code as i64,
                        output_tail: tail_2000(&e.aggregated_output),
                    });
                }
                EventMsg::PatchApplyEnd(e) => {
                    for (path, change) in e.changes.into_iter() {
                        let (kind, diff, added, removed) = map_file_change(&change);
                        emit(&tx, OutEvent::FileEdit {
                            thread_id: tid.clone(),
                            path: path.display().to_string(),
                            kind,
                            diff,
                            added,
                            removed,
                        });
                    }
                }
                EventMsg::TokenCount(t) => {
                    if let Some(info) = t.info {
                        let u = info.last_token_usage;
                        emit(&tx, OutEvent::Usage {
                            thread_id: tid,
                            input_tokens: u.input_tokens.max(0) as u64,
                            cached_input_tokens: u.cached_input_tokens.max(0) as u64,
                            output_tokens: u.output_tokens.max(0) as u64,
                            reasoning_output_tokens: u.reasoning_output_tokens.max(0) as u64,
                        });
                    }
                }
                EventMsg::TurnComplete(_) => {
                    emit(&tx, OutEvent::TurnCompleted { thread_id: tid });
                }
                EventMsg::Error(e) => {
                    emit(&tx, OutEvent::Error { thread_id: tid, message: e.message });
                }
                EventMsg::StreamError(e) => {
                    emit(&tx, OutEvent::Error { thread_id: tid, message: format!("{e:?}") });
                }
                EventMsg::TurnAborted(a) => {
                    emit(&tx, OutEvent::Error { thread_id: tid, message: format!("turn aborted: {a:?}") });
                }
                _ => {}
            }
        }
    });
}

fn map_file_change(change: &FileChange) -> (String, Option<String>, u32, u32) {
    match change {
        FileChange::Add { content } => {
            ("add".to_string(), None, content.lines().count() as u32, 0)
        }
        FileChange::Delete { content } => {
            ("delete".to_string(), None, 0, content.lines().count() as u32)
        }
        FileChange::Update { unified_diff, .. } => {
            let (added, removed) = count_diff(unified_diff);
            ("update".to_string(), Some(unified_diff.clone()), added, removed)
        }
    }
}

fn count_diff(diff: &str) -> (u32, u32) {
    let mut added = 0u32;
    let mut removed = 0u32;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        match line.as_bytes().first() {
            Some(b'+') => added += 1,
            Some(b'-') => removed += 1,
            _ => {}
        }
    }
    (added, removed)
}

fn tail_2000(s: &str) -> String {
    if s.len() <= 2000 {
        return s.to_string();
    }
    let start = s.len() - 2000;
    let start = s.char_indices().map(|(i, _)| i).find(|&i| i >= start).unwrap_or(start);
    s[start..].to_string()
}

fn find_rollout_path(codex_home: &std::path::Path, thread_id: &str) -> Option<PathBuf> {
    let mut stack = vec![codex_home.join("sessions")];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.ends_with(".jsonl") && name.contains(thread_id) {
                    return Some(path);
                }
            }
        }
    }
    None
}

// -- Main dispatch loop ------------------------------------------------------

async fn run(codex_exe: Option<PathBuf>) -> anyhow::Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if out.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = out.write_all(b"\n").await;
            let _ = out.flush().await;
        }
    });

    eprintln!("[engine] started; codex_exe={codex_exe:?}");

    let mut built: Option<Built> = None;
    let mut threads: HashMap<String, Arc<CodexThread>> = HashMap::new();

    let mut lines = BufReader::new(tokio::io::stdin()).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let cmd: Command = match serde_json::from_str(trimmed) {
            Ok(c) => c,
            Err(e) => {
                emit(&tx, OutEvent::Error { thread_id: String::new(), message: format!("bad command json: {e}") });
                continue;
            }
        };

        match cmd {
            Command::StartThread { cwd, model, sandbox } => {
                let config = match build_config(&codex_exe, &cwd, model, sandbox).await {
                    Ok(c) => c,
                    Err(e) => {
                        emit(&tx, OutEvent::Error { thread_id: String::new(), message: e.to_string() });
                        continue;
                    }
                };
                if built.is_none() {
                    match build_stack(&config).await {
                        Ok(b) => built = Some(b),
                        Err(e) => {
                            emit(&tx, OutEvent::Error { thread_id: String::new(), message: format!("build stack: {e}") });
                            continue;
                        }
                    }
                }
                let b = built.as_ref().unwrap();
                match b.thread_manager.start_thread(config).await {
                    Ok(nt) => {
                        let tid = nt.thread_id.to_string();
                        threads.insert(tid.clone(), nt.thread.clone());
                        spawn_pump(nt.thread, tid.clone(), tx.clone());
                        emit(&tx, OutEvent::ThreadStarted { thread_id: tid });
                    }
                    Err(e) => emit(&tx, OutEvent::Error { thread_id: String::new(), message: format!("start_thread: {e}") }),
                }
            }

            Command::Resume { cwd, thread_id, model, sandbox } => {
                let config = match build_config(&codex_exe, &cwd, model, sandbox).await {
                    Ok(c) => c,
                    Err(e) => {
                        emit(&tx, OutEvent::Error { thread_id: thread_id.clone(), message: e.to_string() });
                        continue;
                    }
                };
                if built.is_none() {
                    match build_stack(&config).await {
                        Ok(b) => built = Some(b),
                        Err(e) => {
                            emit(&tx, OutEvent::Error { thread_id: thread_id.clone(), message: format!("build stack: {e}") });
                            continue;
                        }
                    }
                }
                let rollout = match find_rollout_path(&config.codex_home, &thread_id) {
                    Some(p) => p,
                    None => {
                        emit(&tx, OutEvent::Error { thread_id: thread_id.clone(), message: format!("no rollout for {thread_id}") });
                        continue;
                    }
                };
                let b = built.as_ref().unwrap();
                let auth = b.auth_manager.clone();
                match b.thread_manager.resume_thread_from_rollout(config, rollout, auth, None).await {
                    Ok(nt) => {
                        let tid = nt.thread_id.to_string();
                        threads.insert(tid.clone(), nt.thread.clone());
                        spawn_pump(nt.thread, tid.clone(), tx.clone());
                        emit(&tx, OutEvent::ThreadStarted { thread_id: tid });
                    }
                    Err(e) => emit(&tx, OutEvent::Error { thread_id, message: format!("resume: {e}") }),
                }
            }

            Command::UserInput { thread_id, text } => match threads.get(&thread_id) {
                Some(thread) => {
                    let res = thread
                        .submit(Op::UserInput {
                            items: vec![UserInput::Text { text, text_elements: Vec::new() }],
                            environments: None,
                            final_output_json_schema: None,
                            responsesapi_client_metadata: None,
                            thread_settings: Default::default(),
                        })
                        .await;
                    if let Err(e) = res {
                        emit(&tx, OutEvent::Error { thread_id, message: format!("user_input submit: {e}") });
                    }
                }
                None => emit(&tx, OutEvent::Error { thread_id: thread_id.clone(), message: format!("unknown thread {thread_id}") }),
            },

            Command::Interrupt { thread_id } => {
                if let Some(thread) = threads.get(&thread_id) {
                    let _ = thread.submit(Op::Interrupt).await;
                } else {
                    emit(&tx, OutEvent::Error { thread_id: thread_id.clone(), message: format!("unknown thread {thread_id}") });
                }
            }

            Command::Shutdown => {
                eprintln!("[engine] shutdown requested");
                for (_tid, thread) in threads.drain() {
                    let _ = thread.shutdown_and_wait().await;
                }
                break;
            }
        }
    }

    eprintln!("[engine] stdin closed / shutdown; exiting");
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let mut codex_exe: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--codex-exe" {
            codex_exe = args.next().map(PathBuf::from);
        }
    }
    if codex_exe.is_none() {
        if let Ok(p) = std::env::var("CODEX_SELF_EXE") {
            codex_exe = Some(PathBuf::from(p));
        }
    }

    // codex-core blows Windows' 1 MB default main-thread stack during v8 init;
    // drive the runtime from a big-stack thread (docs section 2).
    let child = std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_stack_size(64 * 1024 * 1024)
                .build()
                .expect("build tokio runtime");
            rt.block_on(run(codex_exe))
        })
        .expect("spawn engine thread");
    child.join().expect("engine thread panicked")
}
