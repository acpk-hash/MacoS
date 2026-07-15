//! pi RPC 内核桥（pivot-codex-app 产品转向的核心地基）。
//!
//! 把 pi（`@earendil-works/pi-coding-agent`）作为子进程 agent 引擎驱动：
//! `node <pi_dist>/cli.js --mode rpc --approve --no-context-files
//! --no-extensions --no-skills`，stdin 逐行喂 JSON 命令，stdout 逐行读
//! JSON（`type=="response"` 是命令回包，其余全部是流式事件），全部原样
//! 转发给前端的 `pi-event` 通道：`{ sessionId, event: <该行JSON> }`。
//!
//! ## 协议要点（已实证）
//! - 启动后等 ~800ms 再发第一条命令（writer 任务起步先 sleep，命令在
//!   unbounded channel 里排队，不丢）。
//! - stdin 必须保持开放：writer 任务持有 stdin 写半，直到会话关闭才 drop
//!   （关 stdin pi 会退出）。
//! - 每条命令一行 JSON + `\n`，无 BOM、LF（serde_json 输出天然如此）。
//!
//! ## pi 环境准备（凭据不落盘）
//! 每个会话在 app 数据目录下生成独立的 `pi-agent/<sessionId>/`，通过
//! `PI_CODING_AGENT_DIR` 指给 pi。其中 `models.json` 定义唯一 provider
//! `agentboard`（F1 服务商的 baseUrl + wire_api 映射），apiKey 写的是
//! `"$AGENTBOARD_PI_KEY"` **环境变量引用**（pi 的 resolveConfigValue 支持
//! `$VAR` 插值）；真实 key 只注入子进程环境，不写盘、不进日志、不回前端。
//! `settings.json` 固定 defaultProvider/defaultModel/thinkingLevel。
//!
//! ## node / pi dist 三级定位（参照 workbench 的 codex 定位）
//! node：settings `pi_node_path` 覆盖 → Tauri resource `engine-pi/node.exe`
//! （打包自带）→ PATH 里的 `node`。
//! pi dist：settings `pi_dist_path` 覆盖（cli.js 或其所在目录）→ Tauri
//! resource `engine-pi/pi/dist/cli.js`（打包自带，resolve 不到就跳过）→ 全局 npm 安装
//! （`%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent\dist\cli.js`）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

use crate::db::Db;
use crate::procext::NoWindowExt;

/// 生成的 models.json 里 apiKey 引用的环境变量名（值 = 真实 key，仅注入
/// 子进程环境）。
const PI_KEY_ENV: &str = "AGENTBOARD_PI_KEY";
/// pi 读取 agent 配置目录的环境变量（dist/config.js: ENV_AGENT_DIR）。
const PI_AGENT_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
/// 启动后到第一条 stdin 命令之间的静默期（协议实证：过早写入会一发不响）。
const STARTUP_GRACE_MS: u64 = 800;
/// 未显式指定模型时的兜底（与 providers::FALLBACK_CHAT_MODEL 一致）。
const DEFAULT_MODEL: &str = "gpt-5.5";
/// models.json 里的 provider 名（前端 set_model 需要传 provider 时用它）。
const PI_PROVIDER_NAME: &str = "agentboard";
/// stderr 环形缓冲行数（进程退出时随 process_exit 事件带给前端）。
const STDERR_TAIL_LINES: usize = 40;
/// Loaded explicitly even with `--no-extensions`. It blocks only high-risk
/// operations and uses RPC extension UI so Windows and paired Android clients
/// can race to decide; Pi's matching request id makes the first response win.
const IRIS_APPROVAL_EXTENSION: &str = r#"
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import path from 'node:path';

export default function (pi: ExtensionAPI) {
  const riskyShell = [
    /(^|[;&|]\s*)(rm|rmdir|del|erase|remove-item)\b/i,
    /\b(sudo|runas|start-process\s+[^\n]*-verb\s+runas)\b/i,
    /\b(chmod|chown|takeown|icacls)\b/i,
    /\b(winget|choco|scoop|apt|apt-get|dnf|yum|pacman|brew)\s+(install|remove|uninstall|upgrade)\b/i,
    /\b(npm|pnpm|yarn|pip|pip3|cargo|gem)\s+(publish|install|uninstall|add|remove)\b/i,
    /\b(git\s+push|docker\s+push|twine\s+upload)\b/i,
    /\b(curl|wget|invoke-webrequest|invoke-restmethod|ssh|scp|sftp|rsync)\b/i,
    /\b(shutdown|reboot|restart-computer|stop-computer|format|diskpart|bcdedit|reg\s+(add|delete))\b/i,
  ];

  pi.on('tool_call', async (event, ctx) => {
    let reason: string | undefined;
    let detail = '';
    const input = (event.input || {}) as Record<string, unknown>;
    if (event.toolName === 'bash') {
      detail = String(input.command || '');
      if (riskyShell.some((pattern) => pattern.test(detail))) reason = '高风险命令';
    } else if (event.toolName === 'write' || event.toolName === 'edit') {
      detail = String(input.path || input.file_path || '');
      if (detail && path.isAbsolute(detail)) {
        const root = path.resolve(ctx.cwd).toLowerCase();
        const target = path.resolve(detail).toLowerCase();
        if (target !== root && !target.startsWith(root + path.sep)) reason = '写入项目目录之外';
      }
    }
    if (!reason) return undefined;
    const approved = await ctx.ui.confirm(
      `Iris 安全审批 · ${reason}`,
      detail.slice(0, 4000),
      { timeout: 300000 },
    );
    if (!approved) return { block: true, reason: 'Iris approval rejected or timed out' };
    return undefined;
  });
}
"#;

// ── Session handle + engine (tauri managed state) ───────────────────────────

/// 一个存活的 pi RPC 子进程会话。
struct PiSession {
    /// 命令 JSON → writer 任务 → 子进程 stdin（writer 持有 stdin 写半，
    /// 保证 stdin 在会话生命周期内保持开放）。
    cmd_tx: mpsc::UnboundedSender<Value>,
    /// 通知 supervisor 杀进程树（taskkill /F /T + kill）。
    stop_tx: watch::Sender<bool>,
    /// 等待 pi RPC response 的请求表；避免“写入 stdin 就当成功”造成静默卡死。
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    /// 会话工作目录（诊断用）。
    #[allow(dead_code)]
    cwd: String,
    /// 会话模型（诊断用）。
    #[allow(dead_code)]
    model: String,
    /// 本会话专属 PI_CODING_AGENT_DIR（关闭后延迟清理）。
    agent_dir: PathBuf,
}

/// pi RPC 内核桥：sessionId → 存活子进程。tauri `.manage()` 持有。
pub struct PiEngine {
    inner: Arc<Mutex<HashMap<String, PiSession>>>,
}

impl Default for PiEngine {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl PiEngine {
    /// 发送 RPC 命令并等待同 id 的 response。只有 pi 明确 success=true 才返回成功。
    async fn send_raw(&self, session_id: &str, cmd: Value) -> Result<(), String> {
        let cmd_tx = {
            let g = self.inner.lock().await;
            g.get(session_id)
                .ok_or_else(|| format!("pi 会话不存在: {session_id}"))?
                .cmd_tx
                .clone()
        };
        cmd_tx.send(cmd).map_err(|_| "pi 进程已退出".to_string())
    }

    async fn request(&self, session_id: &str, mut cmd: Value) -> Result<(), String> {
        let id = cmd
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(req_id);
        cmd["id"] = Value::String(id.clone());
        let (cmd_tx, pending) = {
            let g = self.inner.lock().await;
            let s = g
                .get(session_id)
                .ok_or_else(|| format!("pi 会话不存在: {session_id}"))?;
            (s.cmd_tx.clone(), s.pending.clone())
        };
        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert(id.clone(), tx);
        if cmd_tx.send(cmd).is_err() {
            pending.lock().await.remove(&id);
            return Err("pi 进程已退出".to_string());
        }
        let response = match tokio::time::timeout(Duration::from_secs(15), rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => return Err("pi 响应通道已关闭".to_string()),
            Err(_) => {
                pending.lock().await.remove(&id);
                return Err("pi 命令响应超时（15s）".to_string());
            }
        };
        if response.get("success").and_then(Value::as_bool) == Some(true) {
            Ok(())
        } else {
            Err(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("pi 拒绝了命令")
                .to_string())
        }
    }
}

// ── Tauri commands（契约固定，前端并行开发依赖）──────────────────────────────

/// 打开一个 pi 会话：准备 pi 环境（models.json / settings.json / env 注入），
/// spawn `node cli.js --mode rpc`，把 stdout 逐行事件转发到 `pi-event`。
/// 返回 sessionId。
#[tauri::command]
pub(crate) async fn pi_open(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    engine: State<'_, PiEngine>,
    cwd: String,
    provider_id: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    use tokio::process::Command;

    let db = state.db.clone();

    // -- cwd 校验（裸盘符 D: → D:\，参照 workbench）--
    if cwd.trim().is_empty() {
        return Err("请选择工作目录".to_string());
    }
    let cwd = normalize_spawn_path(Path::new(&cwd))
        .to_string_lossy()
        .to_string();
    if !Path::new(&cwd).is_dir() {
        return Err(format!("工作目录不存在: {cwd}"));
    }

    // -- provider / model 解析（key 从 OS 凭据库取，绝不落盘）--
    let provider_id = resolve_provider_id(&db, provider_id)?;
    let (base_url, key, wire_api) = resolve_provider_creds(&db, &provider_id)?;
    let model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    // -- node + pi dist 定位 --
    let node = resolve_node(&db, Some(&app));
    let cli_js = resolve_pi_cli(&db, Some(&app))?;

    // -- pi 环境准备：app 数据目录下的会话专属 agent dir --
    let session_id = uuid::Uuid::new_v4().to_string();
    let agent_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法取得应用数据目录: {e}"))?
        .join("pi-agent")
        .join(&session_id);
    tokio::fs::create_dir_all(&agent_dir)
        .await
        .map_err(|e| format!("创建 pi 配置目录失败: {e}"))?;
    tokio::fs::write(
        agent_dir.join("models.json"),
        build_models_json(&base_url, &wire_api, &model),
    )
    .await
    .map_err(|e| format!("写入 pi models.json 失败: {e}"))?;
    tokio::fs::write(agent_dir.join("settings.json"), build_settings_json(&model))
        .await
        .map_err(|e| format!("写入 pi settings.json 失败: {e}"))?;
    let approval_extension = agent_dir.join("iris-approval.ts");
    tokio::fs::write(&approval_extension, IRIS_APPROVAL_EXTENSION)
        .await
        .map_err(|e| format!("写入 Iris 审批扩展失败: {e}"))?;
    let agents_md_content = {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法取得应用数据目录: {e}"))?;
        let mut md = PI_AGENTS_MD.to_string();
        md.push_str(&crate::hooks::build_hooks_agents_md_section(&data_dir));
        md
    };
    tokio::fs::write(agent_dir.join("AGENTS.md"), &agents_md_content)
        .await
        .map_err(|e| format!("写入 pi AGENTS.md 失败: {e}"))?;

    // -- skills 接线：共享 skills（app_data_dir/skills）镜像进会话目录，
    //    spawn 时以 --skill 挂载（保留 --no-skills：只加载镜像，屏蔽其它来源）--
    let skills_arg: Option<PathBuf> = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("skills"))
        .and_then(|shared| crate::skills_hub::mirror_skills_into(&shared, &agent_dir));
    let mut pi_args: Vec<std::ffi::OsString> = [
        "--mode",
        "rpc",
        "--approve",
        "--no-context-files",
        "--no-extensions",
        "--no-skills",
    ]
    .iter()
    .map(Into::into)
    .collect();
    pi_args.push("--extension".into());
    pi_args.push(approval_extension.as_os_str().to_os_string());
    if let Some(dir) = &skills_arg {
        pi_args.push("--skill".into());
        pi_args.push(dir.as_os_str().to_os_string());
    }

    // -- spawn（key 只进环境变量）--
    let mut child = Command::new(&node)
        .arg(&cli_js)
        .args(&pi_args)
        .current_dir(&cwd)
        .env(PI_AGENT_DIR_ENV, &agent_dir)
        .env(PI_KEY_ENV, &key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_window()
        .spawn()
        .map_err(|e| {
            format!(
                "启动 pi 引擎失败: {e}（node={node}, cli={}, cwd={cwd}）",
                cli_js.display()
            )
        })?;

    let child_id = child.id();
    let mut stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // -- stderr 收集（环形缓冲，退出时随 process_exit 带出）--
    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let mut t = tail.lock().await;
                t.push(l);
                if t.len() > STDERR_TAIL_LINES {
                    t.remove(0);
                }
            }
        });
    }

    // -- writer 任务：持有 stdin（保持开放），起步先等 800ms 静默期 --
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(STARTUP_GRACE_MS)).await;
        while let Some(v) = cmd_rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
        // channel 关闭 → drop stdin → pi 优雅退出。
    });

    let pending = Arc::new(Mutex::new(HashMap::<String, oneshot::Sender<Value>>::new()));

    // -- reader 任务：stdout 逐行 JSON → pi-event；顺带用量落库（持久化） --
    {
        let app = app.clone();
        let sid = session_id.clone();
        let db = db.clone();
        let model = model.clone();
        let provider = provider_id.clone();
        let response_waiters = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(ev) => {
                        if ev.get("type").and_then(Value::as_str) == Some("response") {
                            if let Some(id) = ev.get("id").and_then(Value::as_str) {
                                if let Some(tx) = response_waiters.lock().await.remove(id) {
                                    let _ = tx.send(ev);
                                    continue;
                                }
                            }
                        }
                        // message_end（assistant + usage）→ SQLite pi_usage 一行，
                        // 并 emit `pi-usage-updated` 轻事件供用量页实时刷新。
                        record_usage_if_any(&app, &db, &sid, &model, &provider, &ev);
                        emit_pi_event(&app, &sid, ev);
                    }
                    Err(_) => {} // 容忍非 JSON 噪声（如 node 警告混入 stdout）
                }
            }
        });
    }

    // -- supervisor：等退出 or 停止信号；意外退出通知前端并摘除会话 --
    let (stop_tx, mut stop_rx) = watch::channel(false);
    {
        let app = app.clone();
        let sid = session_id.clone();
        let sessions = engine.inner.clone();
        let stderr_tail = stderr_tail.clone();
        tokio::spawn(async move {
            tokio::select! {
                status = child.wait() => {
                    // 进程自己退出（崩溃 / 配置错误 / 优雅退出）。
                    let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                    sessions.lock().await.remove(&sid);
                    let tail = stderr_tail.lock().await.join("\n");
                    emit_pi_event(
                        &app,
                        &sid,
                        json!({ "type": "process_exit", "code": code, "stderr_tail": tail }),
                    );
                }
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        // pi_close 主动关闭：杀进程树，不再打扰前端。
                        kill_child_id(child_id).await;
                        let _ = child.kill().await;
                    }
                }
            }
        });
    }

    engine.inner.lock().await.insert(
        session_id.clone(),
        PiSession {
            cmd_tx,
            stop_tx,
            pending,
            cwd,
            model,
            agent_dir,
        },
    );

    Ok(session_id)
}

/// 发起新一轮 prompt。
#[tauri::command]
pub async fn pi_prompt(
    engine: State<'_, PiEngine>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    engine
        .request(
            &session_id,
            json!({ "type": "prompt", "message": message, "id": req_id() }),
        )
        .await
}

/// 运行中转向（steer）。
#[tauri::command]
pub async fn pi_steer(
    engine: State<'_, PiEngine>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    engine
        .request(
            &session_id,
            json!({ "type": "steer", "message": message, "id": req_id() }),
        )
        .await
}

/// 追加 follow-up，仅用于 agent 仍在运行时排队；空闲续聊应调用 pi_prompt。
#[tauri::command]
pub async fn pi_follow_up(
    engine: State<'_, PiEngine>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    engine
        .request(
            &session_id,
            json!({ "type": "follow_up", "message": message, "id": req_id() }),
        )
        .await
}

/// 中断当前一轮。
#[tauri::command]
pub async fn pi_abort(engine: State<'_, PiEngine>, session_id: String) -> Result<(), String> {
    engine
        .request(&session_id, json!({ "type": "abort", "id": req_id() }))
        .await
}

/// Resolve an extension confirmation. Pi accepts only the first matching
/// response; later desktop/mobile decisions are harmlessly ignored.
#[tauri::command]
pub async fn pi_extension_ui_response(
    engine: State<'_, PiEngine>,
    session_id: String,
    request_id: String,
    approved: bool,
) -> Result<(), String> {
    engine
        .send_raw(
            &session_id,
            json!({
                "type": "extension_ui_response",
                "id": request_id,
                "confirmed": approved
            }),
        )
        .await
}

/// 关闭会话：杀进程树（Windows taskkill /F /T），摘除会话，延迟清理配置目录。
#[tauri::command]
pub async fn pi_close(engine: State<'_, PiEngine>, session_id: String) -> Result<(), String> {
    let session = engine.inner.lock().await.remove(&session_id);
    let s = session.ok_or_else(|| format!("pi 会话不存在: {session_id}"))?;
    // 通知 supervisor 杀进程树；drop cmd_tx 顺带关掉 stdin（双保险）。
    let _ = s.stop_tx.send(true);
    drop(s.cmd_tx);
    // 延迟清理会话配置目录（等 taskkill 完成、句柄释放）。
    let dir = s.agent_dir;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
    });
    Ok(())
}

// ── 用量持久化（pi_usage 落库 + 查询命令） ───────────────────────────────────

/// 单条 assistant `message_end` 里解析出的用量增量。
#[derive(Debug, PartialEq)]
struct UsageDelta {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    cost: f64,
}

/// `message_end` 且 `message.role == "assistant"` 且带 `usage` → 用量增量。
/// 字段名兼容 camelCase / snake_case（与前端 piStore 的归约口径一致）；
/// `cost` 兼容数字或 `{ total }` 对象。其余事件返回 None。
fn extract_assistant_usage(ev: &Value) -> Option<UsageDelta> {
    if ev.get("type").and_then(|t| t.as_str()) != Some("message_end") {
        return None;
    }
    let msg = ev.get("message")?;
    if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
        return None;
    }
    let u = msg.get("usage")?.as_object()?;
    let num = |keys: &[&str]| -> i64 {
        keys.iter()
            .find_map(|k| u.get(*k).and_then(|v| v.as_f64()))
            .unwrap_or(0.0) as i64
    };
    let cost = match u.get("cost") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::Object(o)) => o.get("total").and_then(|v| v.as_f64()).unwrap_or(0.0),
        _ => 0.0,
    };
    Some(UsageDelta {
        input: num(&["input", "inputTokens", "input_tokens"]),
        output: num(&["output", "outputTokens", "output_tokens"]),
        cache_read: num(&["cacheRead", "cache_read"]),
        cache_write: num(&["cacheWrite", "cache_write"]),
        cost,
    })
}

/// reader 任务的落库钩子：命中 assistant usage 就写一行 `pi_usage`（表在
/// 写入路径 CREATE TABLE IF NOT EXISTS 自建），成功后 emit
/// `pi-usage-updated` 轻事件（payload 仅 sessionId，前端收到即重查）。
fn record_usage_if_any(
    app: &AppHandle,
    db: &Db,
    session_id: &str,
    model: &str,
    provider: &str,
    ev: &Value,
) {
    let Some(u) = extract_assistant_usage(ev) else {
        return;
    };
    let id = uuid::Uuid::new_v4().to_string();
    let row = crate::db::NewPiUsage {
        id: &id,
        session_id,
        model,
        provider,
        input: u.input,
        output: u.output,
        cache_read: u.cache_read,
        cache_write: u.cache_write,
        cost: u.cost,
    };
    match db.pi_usage_insert(&row) {
        Ok(()) => {
            let _ = app.emit("pi-usage-updated", json!({ "sessionId": session_id }));
        }
        Err(e) => eprintln!("[pi_usage] 用量落库失败: {e}"),
    }
}

/// 用量总览（全量累计 + 会话/记录计数）。
#[tauri::command]
pub(crate) async fn pi_usage_overview(
    state: State<'_, crate::AppState>,
) -> Result<crate::db::PiUsageOverview, String> {
    state.db.pi_usage_overview().map_err(|e| e.to_string())
}

/// 近 `days` 天（默认 30，1..=365）按本地日聚合的序列。
#[tauri::command]
pub(crate) async fn pi_usage_series(
    days: Option<u32>,
    state: State<'_, crate::AppState>,
) -> Result<Vec<crate::db::PiUsageDay>, String> {
    let days = days.unwrap_or(30).clamp(1, 365);
    state.db.pi_usage_series(days).map_err(|e| e.to_string())
}

/// 按模型聚合。
#[tauri::command]
pub(crate) async fn pi_usage_by_model(
    state: State<'_, crate::AppState>,
) -> Result<Vec<crate::db::PiUsageModel>, String> {
    state.db.pi_usage_by_model().map_err(|e| e.to_string())
}

/// 最近 `limit` 条（默认 20，1..=200）原始用量记录。
#[tauri::command]
pub(crate) async fn pi_usage_recent(
    limit: Option<u32>,
    state: State<'_, crate::AppState>,
) -> Result<Vec<crate::db::PiUsageRecord>, String> {
    let limit = i64::from(limit.unwrap_or(20).clamp(1, 200));
    state.db.pi_usage_recent(limit).map_err(|e| e.to_string())
}

/// 手动插入一条用量记录（供非 pi 通道的板块写入，如 office/science/commerce/image）。
/// model 字段建议带来源前缀如 `office:gpt-5.5`、`science:gpt-5.5` 以区分板块。
#[tauri::command]
pub(crate) async fn pi_usage_insert_manual(
    session_id: String,
    model: String,
    provider: String,
    input: i64,
    output: i64,
    cache_read: Option<i64>,
    cache_write: Option<i64>,
    cost: Option<f64>,
    state: State<'_, crate::AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let row = crate::db::NewPiUsage {
        id: &id,
        session_id: &session_id,
        model: &model,
        provider: &provider,
        input,
        output,
        cache_read: cache_read.unwrap_or(0),
        cache_write: cache_write.unwrap_or(0),
        cost: cost.unwrap_or(0.0),
    };
    state
        .db
        .pi_usage_insert(&row)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("pi-usage-updated", json!({ "sessionId": session_id }));
    Ok(())
}

// ── 内置引擎（Iris）状态探测 ─────────────────────────────────────────────────

/// 一个运行时构件（node / pi dist）的定位结果。
/// `source`：`settings`（用户覆盖路径）/ `resource`（应用内置）/ `PATH`。
#[derive(Debug, Clone, serde::Serialize)]
pub struct PiRuntimeStatus {
    pub found: bool,
    pub source: String,
    pub path: Option<String>,
    pub version: Option<String>,
}

/// 设置页「内置引擎（Iris）」卡的数据：node + pi 三级定位结果，
/// `bundled` = 打包资源位存在 pi dist（安装版开箱即用）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct PiEngineStatusInfo {
    pub node: PiRuntimeStatus,
    pub pi: PiRuntimeStatus,
    pub bundled: bool,
}

/// best-effort 探测 `<bin> --version`（3 秒超时，失败返回 None）。
async fn probe_version(bin: &str) -> Option<String> {
    let fut = tokio::process::Command::new(bin)
        .arg("--version")
        .no_window()
        .output();
    match tokio::time::timeout(Duration::from_secs(3), fut).await {
        Ok(Ok(out)) if out.status.success() => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if v.is_empty() { None } else { Some(v) }
        }
        _ => None,
    }
}

/// 内置引擎（Iris = node + pi dist）就绪状态，复用 pi_open 的三级定位次序：
/// settings 覆盖 → Tauri resource（打包自带）→ PATH / 全局 npm。
#[tauri::command]
pub(crate) async fn pi_engine_status(
    app: AppHandle,
    state: State<'_, crate::AppState>,
) -> Result<PiEngineStatusInfo, String> {
    let db = state.db.clone();

    // -- node --
    let node_override = db
        .settings_get("pi_node_path")
        .ok()
        .flatten()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty() && PathBuf::from(p).exists());
    let node_resource = app
        .path()
        .resolve("engine-pi/node.exe", BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists())
        .map(|p| normalize_spawn_path(&p).to_string_lossy().to_string());
    let (node_bin, node_source, node_located) = if let Some(p) = node_override {
        (p, "settings", true)
    } else if let Some(p) = node_resource {
        (p, "resource", true)
    } else {
        ("node".to_string(), "PATH", false)
    };
    let node_version = probe_version(&node_bin).await;
    let node_found = node_located || node_version.is_some();
    let node = PiRuntimeStatus {
        found: node_found,
        source: node_source.to_string(),
        path: if node_found { Some(node_bin) } else { None },
        version: node_version,
    };

    // -- pi dist --
    let pi_settings = db
        .settings_get("pi_dist_path")
        .ok()
        .flatten()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(|p| {
            let pb = PathBuf::from(&p);
            if pb.is_dir() { pb.join("cli.js") } else { pb }
        })
        .filter(|p| p.exists());
    let pi_resource = app
        .path()
        .resolve("engine-pi/pi/dist/cli.js", BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists());
    let bundled = pi_resource.is_some();
    let pi_npm = npm_global_pi_cli().filter(|p| p.exists());
    let (pi_found, pi_source, pi_path) = if let Some(p) = pi_settings {
        (true, "settings", Some(p))
    } else if let Some(p) = pi_resource {
        (true, "resource", Some(p))
    } else if let Some(p) = pi_npm {
        (true, "PATH", Some(p))
    } else {
        (false, "PATH", None)
    };
    let pi = PiRuntimeStatus {
        found: pi_found,
        source: pi_source.to_string(),
        path: pi_path.map(|p| normalize_spawn_path(&p).to_string_lossy().to_string()),
        version: None,
    };

    Ok(PiEngineStatusInfo { node, pi, bundled })
}

// ── pi 环境生成 ──────────────────────────────────────────────────────────────

/// 生成会话 `models.json`。apiKey 是 `"$AGENTBOARD_PI_KEY"` 环境变量**引用**
/// （pi 的 resolveConfigValue 对 `$VAR` 做插值）——明文 key 永不落盘。
/// schema 以 pi 0.80.x 的 model-registry 校验为准（providers → baseUrl/api/
/// apiKey/models[]，model 需要 id/contextWindow/maxTokens）。
fn build_models_json(base_url: &str, wire_api: &str, model: &str) -> String {
    let v = json!({
        "providers": {
            PI_PROVIDER_NAME: {
                "name": "AgentBoard",
                "baseUrl": normalize_base_url(base_url),
                "api": pi_api_for_wire(wire_api),
                "apiKey": format!("${PI_KEY_ENV}"),
                "models": [
                    {
                        "id": model,
                        "name": model,
                        "reasoning": true,
                        "input": ["text", "image"],
                        "contextWindow": 400000,
                        "maxTokens": 128000,
                        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
                    }
                ]
            }
        }
    });
    serde_json::to_string_pretty(&v).expect("models.json serializes")
}

/// 全局指令(写入 `<agentDir>/AGENTS.md`,pi 原生读取并注入 system prompt)。
const PI_AGENTS_MD: &str = "\
# Iris 编码 Agent 全局指令

## 输出风格
- 用中文回复。简单问题一两句话说清，复杂问题分点展开。
- 修改文件后说明改了哪些文件、每处做了什么。
- 执行命令只汇报关键结果与失败原因。

## 交互式工作流(关键)
- 收到复杂或模糊任务时，**不要直接开始执行**。
- 先分析任务，列出需要用户确认的关键问题（如目标范围、技术选型、约束条件、优先级等），用编号清单提问。
- 等用户回答后，再给出收敛的执行方案概要，请用户确认后才动手。
- 执行过程中遇到重大分歧点（多种可行方案、破坏性操作、不确定的需求），暂停提问而非自行决定。
- 简单明确的任务（如 格式化这个文件、运行测试）可直接执行，不必提问。
";

/// 生成会话 `settings.json`（defaultProvider 固定指向生成的 provider）。
fn build_settings_json(model: &str) -> String {
    let v = json!({
        "defaultProvider": PI_PROVIDER_NAME,
        "defaultModel": model,
        "thinkingLevel": "medium"
    });
    serde_json::to_string_pretty(&v).expect("settings.json serializes")
}

/// F1 服务商的 wire_api → pi 的 api 类型。
fn pi_api_for_wire(wire_api: &str) -> &'static str {
    if wire_api == "responses" {
        "openai-responses"
    } else {
        "openai-completions"
    }
}

/// 把服务商 base_url 归一化为 pi 期望的 `…/v1` 形式。
fn normalize_base_url(base_url: &str) -> String {
    let b = base_url.trim().trim_end_matches('/');
    let root = b.strip_suffix("/v1").unwrap_or(b);
    format!("{root}/v1")
}

// ── provider / 路径解析 ──────────────────────────────────────────────────────

/// 解析生效的服务商 id（显式传入 → settings default_provider_id）。
fn resolve_provider_id(db: &Db, provider_id: Option<String>) -> Result<String, String> {
    if let Some(p) = provider_id.filter(|p| !p.trim().is_empty()) {
        return Ok(p);
    }
    db.settings_get("default_provider_id")
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "未选择服务商，且没有默认服务商".to_string())
}

/// 取服务商 `(base_url, api_key, wire_api)`（key 来自 OS 凭据库）。
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

/// node 定位（三级 fallback）：
/// 1. settings `pi_node_path` 覆盖（存在才生效）
/// 2. Tauri resource `engine-pi/node.exe`（Windows）或 `engine-pi/node`（macOS）
/// 3. PATH 里的 `node`（dev 默认）
fn resolve_node(db: &Db, app: Option<&AppHandle>) -> String {
    if let Ok(Some(p)) = db.settings_get("pi_node_path") {
        let p = p.trim().to_string();
        if !p.is_empty() && PathBuf::from(&p).exists() {
            return p;
        }
    }
    if let Some(app) = app {
        #[cfg(windows)]
        let bundled_node = "engine-pi/node.exe";
        #[cfg(not(windows))]
        let bundled_node = "engine-pi/node";
        if let Ok(res) = app.path().resolve(bundled_node, BaseDirectory::Resource) {
            if res.exists() {
                return normalize_spawn_path(&res).to_string_lossy().to_string();
            }
        }
    }
    "node".to_string()
}

/// pi dist 定位（三级 fallback，返回 cli.js 的完整路径）：
/// 1. settings `pi_dist_path`（可指 cli.js 本体，或其所在目录）
/// 2. Tauri resource `engine-pi/pi/dist/cli.js`（打包自带；resolve 不到就跳过）
/// 3. 全局 npm 安装目录（dev 默认）
fn resolve_pi_cli(db: &Db, app: Option<&AppHandle>) -> Result<PathBuf, String> {
    // 1) settings 覆盖。
    if let Ok(Some(p)) = db.settings_get("pi_dist_path") {
        let p = p.trim().to_string();
        if !p.is_empty() {
            let pb = PathBuf::from(&p);
            let candidate = if pb.is_dir() { pb.join("cli.js") } else { pb };
            if candidate.exists() {
                return Ok(normalize_spawn_path(&candidate));
            }
            return Err(format!("配置的 pi_dist_path 不存在: {p}"));
        }
    }
    // 2) 打包资源位。
    if let Some(app) = app {
        for rel in ["engine-pi/pi/dist/cli.js"] {
            if let Ok(res) = app.path().resolve(rel, BaseDirectory::Resource) {
                if res.exists() {
                    return Ok(normalize_spawn_path(&res));
                }
            }
        }
    }
    // 3) 全局 npm 安装（dev 默认）。
    if let Some(p) = npm_global_pi_cli() {
        if p.exists() {
            return Ok(normalize_spawn_path(&p));
        }
    }
    Err(
        "找不到 pi 引擎（@earendil-works/pi-coding-agent）。请 `npm i -g \
         @earendil-works/pi-coding-agent`，或在设置中指定 pi_dist_path"
            .to_string(),
    )
}

/// 全局 npm 安装的 pi cli.js 候选路径（Windows: %APPDATA%\npm\node_modules）。
fn npm_global_pi_cli() -> Option<PathBuf> {
    const REL: [&str; 3] = ["node_modules", "@earendil-works", "pi-coding-agent"];
    #[cfg(windows)]
    let root = std::env::var("APPDATA").ok().map(|a| PathBuf::from(a).join("npm"))?;
    #[cfg(not(windows))]
    {
        for root in [PathBuf::from("/opt/homebrew/lib"), PathBuf::from("/usr/local/lib")] {
            let mut p = root;
            for seg in REL {
                p = p.join(seg);
            }
            let cli = p.join("dist").join("cli.js");
            if cli.exists() {
                return Some(cli);
            }
        }
        None
    }
    #[cfg(windows)]
    {
        let mut p = root;
        for seg in REL {
            p = p.join(seg);
        }
        Some(p.join("dist").join("cli.js"))
    }
}

// ── 杂项 ─────────────────────────────────────────────────────────────────────

/// 命令回包关联 id。
fn req_id() -> String {
    format!("req_{}", uuid::Uuid::new_v4().simple())
}

/// 统一的 pi-event 信封：`{ sessionId, event }`。
fn emit_pi_event(app: &AppHandle, session_id: &str, event: Value) {
    let _ = app.emit("pi-event", json!({ "sessionId": session_id, "event": event }));
}

/// 交给子进程 / 配置文件的路径归一化（verbatim 前缀剥除、正斜杠修正、裸盘符
/// 补全）。与 workbench.rs 的同名函数保持一致（该函数为模块私有，按仓库惯例
/// 各模块自持一份）。
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

/// Windows 下 taskkill 整棵进程树（best-effort）。
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

// ── 单元测试 ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_assistant_usage_happy_path_and_filters() {
        // assistant + usage（camelCase + cost 数字）→ Some。
        let ev = json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "usage": {
                    "input": 120, "output": 34,
                    "cacheRead": 56, "cacheWrite": 7,
                    "cost": 0.0123
                }
            }
        });
        let u = extract_assistant_usage(&ev).expect("should parse usage");
        assert_eq!(u.input, 120);
        assert_eq!(u.output, 34);
        assert_eq!(u.cache_read, 56);
        assert_eq!(u.cache_write, 7);
        assert!((u.cost - 0.0123).abs() < 1e-9);

        // snake_case 字段 + cost 对象 { total }。
        let ev2 = json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "usage": {
                    "input_tokens": 10, "output_tokens": 2,
                    "cache_read": 3, "cache_write": 4,
                    "cost": { "total": 0.5 }
                }
            }
        });
        let u2 = extract_assistant_usage(&ev2).unwrap();
        assert_eq!((u2.input, u2.output, u2.cache_read, u2.cache_write), (10, 2, 3, 4));
        assert!((u2.cost - 0.5).abs() < 1e-9);

        // 非 message_end / user 角色 / 无 usage → None。
        assert!(extract_assistant_usage(&json!({ "type": "agent_end" })).is_none());
        assert!(extract_assistant_usage(&json!({
            "type": "message_end",
            "message": { "role": "user", "usage": { "input": 1 } }
        }))
        .is_none());
        assert!(extract_assistant_usage(&json!({
            "type": "message_end",
            "message": { "role": "assistant" }
        }))
        .is_none());
    }

    #[test]
    fn models_json_references_env_key_not_plaintext() {
        let s = build_models_json("https://relay.example.com", "responses", "gpt-5.5");
        let v: Value = serde_json::from_str(&s).expect("valid json");
        let p = &v["providers"][PI_PROVIDER_NAME];
        assert_eq!(p["baseUrl"], "https://relay.example.com/v1");
        assert_eq!(p["api"], "openai-responses");
        // key 必须是环境变量引用，绝不是字面量密钥。
        assert_eq!(p["apiKey"], format!("${PI_KEY_ENV}"));
        assert!(!s.to_lowercase().contains("sk-"));
        // model 条目满足 pi 的 schema 必填项。
        let m = &p["models"][0];
        assert_eq!(m["id"], "gpt-5.5");
        assert!(m["contextWindow"].as_i64().unwrap() > 0);
        assert!(m["maxTokens"].as_i64().unwrap() > 0);
        // 无 BOM。
        assert!(!s.starts_with('\u{feff}'));
    }

    #[test]
    fn settings_json_pins_provider_model_thinking() {
        let s = build_settings_json("gpt-5.5");
        let v: Value = serde_json::from_str(&s).expect("valid json");
        assert_eq!(v["defaultProvider"], PI_PROVIDER_NAME);
        assert_eq!(v["defaultModel"], "gpt-5.5");
        assert_eq!(v["thinkingLevel"], "medium");
        assert!(!s.starts_with('\u{feff}'));
    }

    #[test]
    fn wire_api_maps_to_pi_api() {
        assert_eq!(pi_api_for_wire("responses"), "openai-responses");
        assert_eq!(pi_api_for_wire("chat"), "openai-completions");
        assert_eq!(pi_api_for_wire("anything-else"), "openai-completions");
    }

    #[test]
    fn normalize_base_url_variants() {
        assert_eq!(normalize_base_url("https://x.com"), "https://x.com/v1");
        assert_eq!(normalize_base_url("https://x.com/"), "https://x.com/v1");
        assert_eq!(normalize_base_url("https://x.com/v1"), "https://x.com/v1");
        assert_eq!(normalize_base_url("https://x.com/v1/"), "https://x.com/v1");
    }

    #[cfg(windows)]
    #[test]
    fn normalize_spawn_path_fixes_bare_drive_slashes_and_verbatim() {
        let n = |s: &str| {
            normalize_spawn_path(Path::new(s))
                .to_string_lossy()
                .to_string()
        };
        assert_eq!(n("D:"), r"D:\");
        assert_eq!(n("D:/some/dir"), r"D:\some\dir");
        assert_eq!(n(r"\\?\D:\some\dir"), r"D:\some\dir");
    }

    #[test]
    fn req_ids_are_unique_and_prefixed() {
        let a = req_id();
        let b = req_id();
        assert!(a.starts_with("req_"));
        assert_ne!(a, b);
    }

    /// LIVE 冒烟：真实起 `node cli.js --mode rpc --approve …`，用生成的
    /// models.json/settings.json（key 为假值，仅走 env 注入路径；get_state
    /// 不打网络），发 `{"type":"get_state","id":"t1"}`，断言拿到 response。
    /// 证明：spawn 参数、800ms 静默期、stdin 行协议、stdout response 回包
    /// 全链路通。
    ///
    /// 运行：`cargo test -p agentboard --lib pi_rpc::tests::live_rpc_get_state
    /// -- --ignored --nocapture`（需要本机 node + 全局 npm 装的 pi）。
    #[tokio::test]
    #[ignore]
    async fn live_rpc_get_state() {
        use tokio::process::Command;

        let cli = npm_global_pi_cli().expect("npm global path");
        assert!(cli.exists(), "pi cli.js not found: {}", cli.display());

        // 会话专属 agent dir（与产品路径同构，只是落在 temp）。
        let agent_dir =
            std::env::temp_dir().join(format!("ab-pi-smoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("models.json"),
            build_models_json("https://sub.aiboys.xyz/v1", "responses", "gpt-5.5"),
        )
        .unwrap();
        std::fs::write(agent_dir.join("settings.json"), build_settings_json("gpt-5.5")).unwrap();
        let approval_extension = agent_dir.join("iris-approval.ts");
        std::fs::write(&approval_extension, IRIS_APPROVAL_EXTENSION).unwrap();

        let work = std::env::temp_dir().join(format!("ab-pi-work-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&work).unwrap();

        let mut child = Command::new("node")
            .arg(&cli)
            .args([
                "--mode",
                "rpc",
                "--approve",
                "--no-context-files",
                "--no-extensions",
                "--no-skills",
            ])
            .arg("--extension")
            .arg(&approval_extension)
            .current_dir(&work)
            .env(PI_AGENT_DIR_ENV, &agent_dir)
            .env(PI_KEY_ENV, "smoke-dummy-key")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .no_window()
            .spawn()
            .expect("spawn pi");

        let mut stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut errlines = BufReader::new(child.stderr.take().unwrap()).lines();
        tokio::spawn(async move {
            while let Ok(Some(l)) = errlines.next_line().await {
                eprintln!("[pi-stderr] {l}");
            }
        });

        // 协议要求：启动后 ~800ms 再发第一条命令；stdin 保持开放。
        tokio::time::sleep(Duration::from_millis(STARTUP_GRACE_MS)).await;
        stdin
            .write_all(b"{\"type\":\"get_state\",\"id\":\"t1\"}\n")
            .await
            .unwrap();
        stdin.flush().await.unwrap();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let mut got: Option<Value> = None;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let line = match tokio::time::timeout(remaining, lines.next_line()).await {
                Ok(Ok(Some(l))) => l,
                _ => break,
            };
            println!("[pi-stdout] {line}");
            if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                if v["type"] == "response" && v["id"] == "t1" {
                    got = Some(v);
                    break;
                }
            }
        }

        let _ = child.kill().await;
        let _ = std::fs::remove_dir_all(&agent_dir);
        let _ = std::fs::remove_dir_all(&work);

        let v = got.expect("must receive response for get_state (id=t1)");
        assert_eq!(v["command"], "get_state");
        assert_eq!(v["success"], true);
        // 生成的环境生效：默认模型来自我们的 settings.json/models.json。
        assert_eq!(v["data"]["model"]["id"], "gpt-5.5");
    }

    /// LIVE 端到端冒烟（真网络 + 真 key）：连续两轮 agent turn。
    /// 证明产品链路的最终判据：pi_open 同构生成的环境（models.json/
    /// settings.json 复用生产函数）→ 真实 prompt → agent 真调工具在
    /// 工作目录写出 hello.txt → agent_end，事件顺序与落盘产物都验证。
    ///
    /// 需要：本机 node + 全局 npm 的 pi + 环境变量 `OPENAI_API_KEY`
    /// （指向 aiboys relay 的 key，注入为子进程 AGENTBOARD_PI_KEY）。
    ///
    /// 运行：`cargo test -p agentboard --lib pi_rpc::tests::live_rpc_full_turn
    /// -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_rpc_full_turn() {
        use tokio::process::Command;

        // 与产品一致，从应用默认 provider 读取凭据；环境变量可覆盖用于 CI。
        let db = Db::open().expect("open app db");
        let provider_id = resolve_provider_id(&db, None).expect("default provider");
        let (base_url, stored_key, wire_api) =
            resolve_provider_creds(&db, &provider_id).expect("provider creds");
        let key = std::env::var("OPENAI_API_KEY")
            .ok()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .unwrap_or(stored_key);
        let model = "gpt-5.6-luna";

        let cli = npm_global_pi_cli().expect("npm global path");
        assert!(cli.exists(), "pi cli.js not found: {}", cli.display());

        // -- 与产品 pi_open 同构的会话环境（配置内容 100% 复用生产函数）--
        let agent_dir =
            std::env::temp_dir().join(format!("pi-e2e-cfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("models.json"),
            build_models_json(&base_url, &wire_api, model),
        )
        .unwrap();
        std::fs::write(agent_dir.join("settings.json"), build_settings_json(model)).unwrap();
        let approval_extension = agent_dir.join("iris-approval.ts");
        std::fs::write(&approval_extension, IRIS_APPROVAL_EXTENSION).unwrap();

        // -- 临时工作目录：agent 要在这里写 hello.txt --
        let work = std::env::temp_dir().join(format!("pi-e2e-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&work).unwrap();

        let mut child = Command::new("node")
            .arg(&cli)
            .args([
                "--mode",
                "rpc",
                "--approve",
                "--no-context-files",
                "--no-extensions",
                "--no-skills",
            ])
            .arg("--extension")
            .arg(&approval_extension)
            .current_dir(&work)
            .env(PI_AGENT_DIR_ENV, &agent_dir)
            .env(PI_KEY_ENV, &key)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .no_window()
            .spawn()
            .expect("spawn pi");

        let child_id = child.id();
        let mut stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

        // stderr → 共享尾部缓冲（失败时打印诊断）。
        let stderr_tail = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        {
            let tail = stderr_tail.clone();
            let mut errlines = BufReader::new(child.stderr.take().unwrap()).lines();
            tokio::spawn(async move {
                while let Ok(Some(l)) = errlines.next_line().await {
                    let mut t = tail.lock().unwrap();
                    t.push(l);
                    if t.len() > STDERR_TAIL_LINES {
                        t.remove(0);
                    }
                }
            });
        }

        // -- 协议：800ms 静默期后发真实 prompt --
        tokio::time::sleep(Duration::from_millis(STARTUP_GRACE_MS)).await;
        let prompt = json!({
            "type": "prompt",
            "message": "在当前目录创建 hello.txt，内容为 pivot-ok，然后结束。",
            "id": "e2e1"
        });
        let mut line = prompt.to_string();
        line.push('\n');
        stdin.write_all(line.as_bytes()).await.unwrap();
        stdin.flush().await.unwrap();

        // -- 事件循环（总超时 120s）：验证 agent_start → tool_execution_start
        //    →（…）→ agent_end 的顺序 --
        let started = std::time::Instant::now();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        let mut events: Vec<String> = Vec::new();
        let (mut saw_agent_start, mut saw_tool_start, mut saw_agent_end) = (false, false, false);
        let mut order_ok = true;
        let mut tool_names: Vec<String> = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let l = match tokio::time::timeout(remaining, lines.next_line()).await {
                Ok(Ok(Some(l))) => l,
                _ => break, // EOF / 读错 / 超时
            };
            let trimmed = l.trim();
            if trimmed.is_empty() {
                continue;
            }
            events.push(trimmed.to_string());
            let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            match v["type"].as_str().unwrap_or("") {
                "agent_start" => saw_agent_start = true,
                "tool_execution_start" => {
                    if !saw_agent_start {
                        order_ok = false;
                    }
                    saw_tool_start = true;
                    let name = v["toolName"]
                        .as_str()
                        .or_else(|| v["tool_name"].as_str())
                        .or_else(|| v["name"].as_str())
                        .unwrap_or("?");
                    tool_names.push(name.to_string());
                    println!("[e2e tool_execution_start] {trimmed}");
                }
                "agent_end" => {
                    // pi 对可重试错误会发 willRetry=true 的 agent_end 然后
                    // 自动重试；只有最终的 agent_end 才算一轮真正结束。
                    if v["willRetry"] == true {
                        println!("[e2e agent_end willRetry=true → 继续等重试]");
                        continue;
                    }
                    if !saw_tool_start {
                        order_ok = false;
                    }
                    saw_agent_end = true;
                    println!("[e2e agent_end] {trimmed}");
                    break; // 一轮结束
                }
                _ => {}
            }
        }
        // 第一轮结束后必须用 prompt 开启正常第二轮；这是编码窗口续聊的产品路径。
        let second = json!({
            "type": "prompt",
            "message": "只回复 second-ok，不要调用工具。",
            "id": "e2e2"
        });
        stdin
            .write_all(format!("{second}\n").as_bytes())
            .await
            .unwrap();
        stdin.flush().await.unwrap();

        let second_deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        let mut saw_second_start = false;
        let mut saw_second_message = false;
        let mut saw_second_end = false;
        let mut second_text = String::new();
        loop {
            let remaining = second_deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let l = match tokio::time::timeout(remaining, lines.next_line()).await {
                Ok(Ok(Some(l))) => l,
                _ => break,
            };
            events.push(l.clone());
            let Ok(v) = serde_json::from_str::<Value>(l.trim()) else {
                continue;
            };
            match v["type"].as_str().unwrap_or("") {
                "agent_start" => saw_second_start = true,
                "message_end" if v["message"]["role"] == "assistant" => {
                    saw_second_message = true;
                    if let Some(parts) = v["message"]["content"].as_array() {
                        for part in parts {
                            if part["type"] == "text" {
                                second_text.push_str(part["text"].as_str().unwrap_or(""));
                            }
                        }
                    }
                }
                "agent_end" if v["willRetry"] != true => {
                    saw_second_end = true;
                    break;
                }
                _ => {}
            }
        }
        let elapsed = started.elapsed();

        // -- 落盘产物验证（在杀进程前后都不受影响，先读再清理）--
        let hello = work.join("hello.txt");
        let hello_content = std::fs::read_to_string(&hello).ok();

        // -- 清理：杀进程树 + 删临时目录 --
        kill_child_id(child_id).await;
        let _ = child.kill().await;
        let _ = std::fs::remove_dir_all(&agent_dir);
        let _ = std::fs::remove_dir_all(&work);

        // -- 诊断输出（失败时把最后 30 行事件 + stderr 尾部打出来）--
        let content_ok = hello_content
            .as_deref()
            .map(|c| c.contains("pivot-ok"))
            .unwrap_or(false);
        let pass = saw_agent_start
            && saw_tool_start
            && saw_agent_end
            && order_ok
            && content_ok
            && saw_second_start
            && saw_second_message
            && saw_second_end
            && second_text.to_lowercase().contains("second-ok");
        if !pass {
            eprintln!("---- last {} events ----", events.len().min(30));
            for e in events.iter().rev().take(30).collect::<Vec<_>>().into_iter().rev() {
                eprintln!("[event] {e}");
            }
            eprintln!("---- stderr tail ----");
            for l in stderr_tail.lock().unwrap().iter() {
                eprintln!("[stderr] {l}");
            }
        }
        println!(
            "[e2e] elapsed={elapsed:?} tools={tool_names:?} hello.txt={hello_content:?} second={second_text:?}"
        );

        assert!(saw_agent_start, "未观察到 agent_start");
        assert!(saw_tool_start, "未观察到 tool_execution_start");
        assert!(saw_agent_end, "未观察到第一轮 agent_end");
        assert!(saw_second_start, "第二轮 prompt 未触发 agent_start");
        assert!(saw_second_message, "第二轮未收到 assistant message_end");
        assert!(saw_second_end, "第二轮未收到 agent_end");
        assert!(
            second_text.to_lowercase().contains("second-ok"),
            "第二轮回答异常: {second_text:?}"
        );
        assert!(order_ok, "事件顺序不对（应为 agent_start → tool → agent_end）");
        let c = hello_content.expect("hello.txt 未生成");
        assert!(c.contains("pivot-ok"), "hello.txt 内容不含 pivot-ok: {c:?}");
    }
}
