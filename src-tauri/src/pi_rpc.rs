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
//! node：settings `pi_node_path` 覆盖 → PATH 里的 `node`。
//! pi dist：settings `pi_dist_path` 覆盖（cli.js 或其所在目录）→ Tauri
//! resource `engine-pi/`（将来打包位，resolve 不到就跳过）→ 全局 npm 安装
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
use tokio::sync::{mpsc, watch, Mutex};

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

// ── Session handle + engine (tauri managed state) ───────────────────────────

/// 一个存活的 pi RPC 子进程会话。
struct PiSession {
    /// 命令 JSON → writer 任务 → 子进程 stdin（writer 持有 stdin 写半，
    /// 保证 stdin 在会话生命周期内保持开放）。
    cmd_tx: mpsc::UnboundedSender<Value>,
    /// 通知 supervisor 杀进程树（taskkill /F /T + kill）。
    stop_tx: watch::Sender<bool>,
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
    /// 向指定会话 stdin 写一条命令（一行 JSON）。
    async fn send(&self, session_id: &str, cmd: Value) -> Result<(), String> {
        let g = self.inner.lock().await;
        let s = g
            .get(session_id)
            .ok_or_else(|| format!("pi 会话不存在: {session_id}"))?;
        s.cmd_tx
            .send(cmd)
            .map_err(|_| "pi 进程已退出".to_string())
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
    let node = resolve_node(&db);
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

    // -- spawn（key 只进环境变量）--
    let mut child = Command::new(&node)
        .arg(&cli_js)
        .args([
            "--mode",
            "rpc",
            "--approve",
            "--no-context-files",
            "--no-extensions",
            "--no-skills",
        ])
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

    // -- reader 任务：stdout 逐行 JSON → pi-event --
    {
        let app = app.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(ev) => emit_pi_event(&app, &sid, ev),
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
        .send(
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
        .send(
            &session_id,
            json!({ "type": "steer", "message": message, "id": req_id() }),
        )
        .await
}

/// 追加 follow-up。
#[tauri::command]
pub async fn pi_follow_up(
    engine: State<'_, PiEngine>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    engine
        .send(
            &session_id,
            json!({ "type": "follow_up", "message": message, "id": req_id() }),
        )
        .await
}

/// 中断当前一轮。
#[tauri::command]
pub async fn pi_abort(engine: State<'_, PiEngine>, session_id: String) -> Result<(), String> {
    engine
        .send(&session_id, json!({ "type": "abort", "id": req_id() }))
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

/// node 定位：settings `pi_node_path` 覆盖（存在才生效）→ PATH 里的 `node`。
fn resolve_node(db: &Db) -> String {
    if let Ok(Some(p)) = db.settings_get("pi_node_path") {
        let p = p.trim().to_string();
        if !p.is_empty() && PathBuf::from(&p).exists() {
            return p;
        }
    }
    "node".to_string()
}

/// pi dist 定位（三级 fallback，返回 cli.js 的完整路径）：
/// 1. settings `pi_dist_path`（可指 cli.js 本体，或其所在目录）
/// 2. Tauri resource `engine-pi/`（将来打包位；resolve 不到就跳过）
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
        for rel in ["engine-pi/dist/cli.js", "engine-pi/cli.js"] {
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
    let root = PathBuf::from("/usr/local/lib");
    let mut p = root;
    for seg in REL {
        p = p.join(seg);
    }
    Some(p.join("dist").join("cli.js"))
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
}
