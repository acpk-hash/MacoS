use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, watch, Mutex};

use crate::agent::embedded::{locate_codex_exe, EngineEvent};
use crate::db::Db;
use crate::procext::NoWindowExt;

const HANDSHAKE_TIMEOUT_SECS: u64 = 60;
const KEY_ENV: &str = "AGENTBOARD_CODEX_KEY";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubagentStatus {
    Running,
    Done,
    Error,
    Stopped,
}

pub struct SubagentHandle {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub model: String,
    pub status: SubagentStatus,
    pub started_at: i64,
    pub child_id: Option<u32>,
    pub stop_tx: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct SubagentManager {
    pub inner: Arc<Mutex<HashMap<String, SubagentHandle>>>,
}

impl Default for SubagentManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SubagentSummary {
    pub id: String,
    pub title: String,
    pub status: SubagentStatus,
    pub started_at: i64,
    pub cwd: String,
    pub model: String,
}

#[tauri::command]
pub async fn subagent_spawn(
    app: AppHandle,
    state: State<'_, SubagentManager>,
    prompt: String,
    cwd: String,
    model: String,
) -> Result<String, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("子任务 prompt 不能为空".to_string());
    }
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("请指定模型".to_string());
    }
    if cwd.trim().is_empty() {
        return Err("请选择工作目录".to_string());
    }
    let cwd = normalize_spawn_path(Path::new(&cwd))
        .to_string_lossy()
        .to_string();
    if !Path::new(&cwd).is_dir() {
        return Err(format!("工作目录不存在: {cwd}"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let title: String = prompt.chars().take(40).collect();
    let started_at = now_ms();
    let (stop_tx, stop_rx) = watch::channel(false);

    {
        let mut g = state.inner.lock().await;
        g.insert(
            id.clone(),
            SubagentHandle {
                id: id.clone(),
                title,
                cwd: cwd.clone(),
                model: model.clone(),
                status: SubagentStatus::Running,
                started_at,
                child_id: None,
                stop_tx,
            },
        );
    }

    let manager = state.inner.clone();
    let run_id = id.clone();
    tauri::async_runtime::spawn(async move {
        run_subagent(app, manager, run_id, prompt, cwd, model, stop_rx).await;
    });

    Ok(id)
}

#[tauri::command]
pub async fn subagent_stop(state: State<'_, SubagentManager>, id: String) -> Result<(), String> {
    let (stop_tx, child_id) = {
        let mut g = state.inner.lock().await;
        let h = g
            .get_mut(&id)
            .ok_or_else(|| format!("子 agent 不存在: {id}"))?;
        h.status = SubagentStatus::Stopped;
        (h.stop_tx.clone(), h.child_id)
    };
    let _ = stop_tx.send(true);
    kill_child_id(child_id).await;
    Ok(())
}

#[tauri::command]
pub async fn subagent_list(
    state: State<'_, SubagentManager>,
) -> Result<Vec<SubagentSummary>, String> {
    let g = state.inner.lock().await;
    let mut out: Vec<_> = g
        .values()
        .map(|h| SubagentSummary {
            id: h.id.clone(),
            title: h.title.clone(),
            status: h.status.clone(),
            started_at: h.started_at,
            cwd: h.cwd.clone(),
            model: h.model.clone(),
        })
        .collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.started_at));
    Ok(out)
}

async fn run_subagent(
    app: AppHandle,
    manager: Arc<Mutex<HashMap<String, SubagentHandle>>>,
    id: String,
    prompt: String,
    cwd: String,
    model: String,
    mut stop_rx: watch::Receiver<bool>,
) {
    if let Err(message) = run_subagent_inner(
        app.clone(),
        manager.clone(),
        id.clone(),
        prompt,
        cwd,
        model,
        &mut stop_rx,
    )
    .await
    {
        set_status_if_running(&manager, &id, SubagentStatus::Error).await;
        emit_subagent(&app, &id, "error", json!({ "message": message }));
    }
}

async fn run_subagent_inner(
    app: AppHandle,
    manager: Arc<Mutex<HashMap<String, SubagentHandle>>>,
    id: String,
    prompt: String,
    cwd: String,
    model: String,
    stop_rx: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    use tokio::process::Command;

    let db = Db::open().map_err(|e| e.to_string())?;
    let provider_id = resolve_provider_id(&db)?;
    let engine_bin = resolve_engine_bin(&db, Some(&app))?;
    let codex_exe = resolve_codex_exe(&db, Some(&app)).await?;
    let (base_url, key, _wire_api) = resolve_provider_creds(&db, &provider_id)?;

    let codex_home = std::env::temp_dir()
        .join("agentboard-subagents")
        .join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&codex_home)
        .await
        .map_err(|e| format!("创建子 agent 配置目录失败: {e}"))?;
    tokio::fs::write(
        codex_home.join("config.toml"),
        build_config_toml(&base_url, &model),
    )
    .await
    .map_err(|e| format!("写入子 agent 配置失败: {e}"))?;
    tokio::fs::write(codex_home.join("AGENTS.md"), OUTPUT_STYLE_AGENTS_MD)
        .await
        .map_err(|e| format!("写入子 agent 输出风格指引失败: {e}"))?;

    let mut child = Command::new(&engine_bin)
        .args(["--codex-exe", &codex_exe])
        .current_dir(&cwd)
        .env("CODEX_HOME", &codex_home)
        .env(KEY_ENV, &key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_window()
        .spawn()
        .map_err(|e| {
            format!(
                "启动子 agent 引擎失败: {e}（engine={}, cwd={cwd}）",
                engine_bin.display()
            )
        })?;

    let child_id = child.id();
    {
        let mut g = manager.lock().await;
        if let Some(h) = g.get_mut(&id) {
            h.child_id = child_id;
        }
    }

    let mut stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let mut t = tail.lock().await;
                t.push(l);
                if t.len() > 40 {
                    t.remove(0);
                }
            }
        });
    }

    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        while let Some(v) = cmd_rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
    });

    let _ = cmd_tx.send(json!({
        "op": "start_thread",
        "cwd": cwd,
        "model": model,
        "sandbox": "danger-full-access",
    }));

    let mut reader = BufReader::new(stdout).lines();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(HANDSHAKE_TIMEOUT_SECS);
    let thread_id = loop {
        if *stop_rx.borrow() {
            kill_child_id(child_id).await;
            let _ = child.kill().await;
            let _ = tokio::fs::remove_dir_all(&codex_home).await;
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            kill_child_id(child_id).await;
            let _ = child.kill().await;
            let tail = stderr_tail.lock().await.join("\n");
            let _ = tokio::fs::remove_dir_all(&codex_home).await;
            return Err(if tail.trim().is_empty() {
                format!("子 agent 引擎启动超时（{HANDSHAKE_TIMEOUT_SECS}s 内无响应）")
            } else {
                format!("子 agent 引擎启动失败: {tail}")
            });
        }
        let next = tokio::select! {
            _ = stop_rx.changed() => {
                kill_child_id(child_id).await;
                let _ = child.kill().await;
                let _ = tokio::fs::remove_dir_all(&codex_home).await;
                return Ok(());
            }
            line = tokio::time::timeout(remaining, reader.next_line()) => line,
        };
        let line = match next {
            Ok(Ok(Some(line))) => line,
            _ => {
                kill_child_id(child_id).await;
                let _ = child.kill().await;
                let tail = stderr_tail.lock().await.join("\n");
                let _ = tokio::fs::remove_dir_all(&codex_home).await;
                return Err(if tail.trim().is_empty() {
                    format!("子 agent 引擎启动超时（{HANDSHAKE_TIMEOUT_SECS}s 内无响应）")
                } else {
                    format!("子 agent 引擎启动失败: {tail}")
                });
            }
        };
        match serde_json::from_str::<EngineEvent>(line.trim()) {
            Ok(EngineEvent::ThreadStarted { thread_id }) => break thread_id,
            Ok(EngineEvent::Error { message }) => {
                kill_child_id(child_id).await;
                let _ = child.kill().await;
                let _ = tokio::fs::remove_dir_all(&codex_home).await;
                return Err(format!("子 agent 引擎启动失败: {message}"));
            }
            _ => continue,
        }
    };

    emit_subagent(
        &app,
        &id,
        "started",
        json!({ "thread_id": thread_id, "provider_id": provider_id }),
    );
    let _ = cmd_tx.send(json!({ "op": "user_input", "thread_id": thread_id, "text": prompt }));

    let mut completed = false;
    loop {
        tokio::select! {
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    kill_child_id(child_id).await;
                    let _ = child.kill().await;
                    break;
                }
            }
            line = reader.next_line() => {
                let line = match line {
                    Ok(Some(line)) => line,
                    _ => break,
                };
                if handle_engine_line(&app, &id, &line).await {
                    completed = true;
                    break;
                }
            }
        }
    }

    drop(cmd_tx);
    if completed {
        kill_child_id(child_id).await;
        let _ = child.kill().await;
        set_status_if_running(&manager, &id, SubagentStatus::Done).await;
        emit_subagent(&app, &id, "done", json!({ "exit_code": 0 }));
    } else if *stop_rx.borrow() {
        set_status(&manager, &id, SubagentStatus::Stopped).await;
    } else {
        let status = child
            .wait()
            .await
            .map(|s| s.code().unwrap_or(-1))
            .unwrap_or(-1);
        set_status_if_running(&manager, &id, SubagentStatus::Error).await;
        emit_subagent(
            &app,
            &id,
            "error",
            json!({ "message": format!("子 agent 引擎已退出（code={status}）"), "exit_code": status }),
        );
    }

    let dir = codex_home.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
    });
    Ok(())
}

async fn handle_engine_line(app: &AppHandle, id: &str, line: &str) -> bool {
    let line = line.trim();
    if line.is_empty() {
        return false;
    }
    let ev: EngineEvent = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            emit_subagent(
                app,
                id,
                "output",
                json!({ "stream": "stdout", "text": line }),
            );
            return false;
        }
    };
    match ev {
        EngineEvent::ThreadStarted { .. } | EngineEvent::SessionStarted {} => {}
        EngineEvent::AssistantDelta { text } => {
            emit_subagent(
                app,
                id,
                "output",
                json!({ "role": "assistant", "delta": text }),
            );
        }
        EngineEvent::AssistantMessage { text } => {
            emit_subagent(
                app,
                id,
                "output",
                json!({ "role": "assistant", "text": text }),
            );
        }
        EngineEvent::CommandRun {
            cmd,
            exit_code,
            output_tail,
        } => {
            emit_subagent(
                app,
                id,
                "tool",
                json!({ "tool": "bash", "cmd": cmd, "exit_code": exit_code, "output": output_tail }),
            );
        }
        EngineEvent::FileEdit {
            path,
            kind,
            diff,
            added,
            removed,
        } => {
            emit_subagent(
                app,
                id,
                "tool",
                json!({ "tool": "file_edit", "path": path, "edit_kind": kind, "diff": diff, "added": added, "removed": removed }),
            );
        }
        EngineEvent::Usage {
            input_tokens,
            cached_input_tokens,
            output_tokens,
            reasoning_output_tokens,
        } => {
            emit_subagent(
                app,
                id,
                "output",
                json!({ "usage": { "input_tokens": input_tokens, "cached_input_tokens": cached_input_tokens, "output_tokens": output_tokens, "reasoning_output_tokens": reasoning_output_tokens } }),
            );
        }
        EngineEvent::TurnCompleted {} => return true,
        EngineEvent::Error { message } => {
            emit_subagent(app, id, "error", json!({ "message": message }));
        }
    }
    false
}

fn emit_subagent(app: &AppHandle, id: &str, kind: &str, mut extra: Value) {
    let mut payload = serde_json::Map::new();
    payload.insert("id".to_string(), Value::String(id.to_string()));
    payload.insert("kind".to_string(), Value::String(kind.to_string()));
    payload.insert("ts".to_string(), Value::Number(now_ms().into()));
    if let Value::Object(obj) = &mut extra {
        for (k, v) in std::mem::take(obj) {
            payload.insert(k, v);
        }
    }
    let _ = app.emit("subagent-event", Value::Object(payload));
}

async fn set_status(
    manager: &Arc<Mutex<HashMap<String, SubagentHandle>>>,
    id: &str,
    status: SubagentStatus,
) {
    let mut g = manager.lock().await;
    if let Some(h) = g.get_mut(id) {
        h.status = status;
    }
}

async fn set_status_if_running(
    manager: &Arc<Mutex<HashMap<String, SubagentHandle>>>,
    id: &str,
    status: SubagentStatus,
) {
    let mut g = manager.lock().await;
    if let Some(h) = g.get_mut(id) {
        if h.status == SubagentStatus::Running {
            h.status = status;
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn build_config_toml(base_url: &str, model: &str) -> String {
    format!(
        r#"model = "{model}"
model_provider = "agentboard"
approval_policy = "never"
sandbox_mode = "danger-full-access"
disable_response_storage = true

[model_providers.agentboard]
name = "AgentBoard"
base_url = "{base}"
wire_api = "responses"
env_key = "{key_env}"
"#,
        model = model.replace('"', ""),
        base = normalize_base_url(base_url),
        key_env = KEY_ENV,
    )
}

fn normalize_base_url(base_url: &str) -> String {
    let b = base_url.trim().trim_end_matches('/');
    let root = b.strip_suffix("/v1").unwrap_or(b);
    format!("{root}/v1")
}

const OUTPUT_STYLE_AGENTS_MD: &str = "\
# 输出风格（AgentBoard 子 agent）

- 用中文回复，简洁直接。
- 聚焦当前子任务，完成后给出关键结果；不要复述无关上下文。
- 修改文件或执行命令后，说明关键改动/结果与失败原因。
";

fn resolve_provider_id(db: &Db) -> Result<String, String> {
    db.settings_get("default_provider_id")
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "未选择服务商，且没有默认服务商".to_string())
}

fn resolve_provider_creds(db: &Db, provider_id: &str) -> Result<(String, String, String), String> {
    let row = db
        .provider_get(provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("服务商不存在: {provider_id}"))?;
    let key = crate::providers::key_get(provider_id)?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| "该服务商未设置 API Key".to_string())?;
    Ok((row.base_url, key, row.wire_api))
}

fn resolve_engine_bin(db: &Db, app: Option<&AppHandle>) -> Result<PathBuf, String> {
    if let Ok(Some(p)) = db.settings_get("engine_bin_path") {
        let p = p.trim().to_string();
        if !p.is_empty() {
            let pb = PathBuf::from(&p);
            if pb.exists() {
                return Ok(pb);
            }
            return Err(format!("配置的 engine_bin_path 不存在: {p}"));
        }
    }
    #[cfg(windows)]
    let name = "agentboard-engine.exe";
    #[cfg(not(windows))]
    let name = "agentboard-engine";
    if let Some(app) = app {
        if let Ok(res) = app.path().resolve(name, BaseDirectory::Resource) {
            if res.exists() {
                return Ok(res);
            }
        }
    }
    let dev = PathBuf::from("..")
        .join("engine")
        .join("target")
        .join("release")
        .join(name);
    if dev.exists() {
        return Ok(dev);
    }
    Err("找不到 agentboard-engine，请重新安装应用或在设置中指定 engine_bin_path".to_string())
}

async fn resolve_codex_exe(db: &Db, app: Option<&AppHandle>) -> Result<String, String> {
    let explicit = db
        .settings_get("codex_exe_path")
        .unwrap_or(None)
        .filter(|s| !s.trim().is_empty());
    if let Some(p) = &explicit {
        if PathBuf::from(p).exists() {
            return Ok(p.clone());
        }
    }
    if let Some(app) = app {
        for rel in ["engine-codex/bin/codex.exe", "engine-codex/codex.exe"] {
            if let Ok(res) = app.path().resolve(rel, BaseDirectory::Resource) {
                if res.exists() {
                    return Ok(normalize_spawn_path(&res).to_string_lossy().to_string());
                }
            }
        }
    }
    locate_codex_exe(None).await
}

fn normalize_spawn_path(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        let s = s.trim();
        let mut s = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            s.to_string()
        };
        s = s.replace('/', "\\");
        let b = s.as_bytes();
        if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            s.push('\\');
        }
        PathBuf::from(s)
    }
    #[cfg(not(windows))]
    {
        p.to_path_buf()
    }
}

async fn kill_child_id(child_id: Option<u32>) {
    #[cfg(windows)]
    if let Some(pid) = child_id {
        let _ = tokio::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .no_window()
            .output()
            .await;
    }
    #[cfg(not(windows))]
    let _ = child_id;
}
