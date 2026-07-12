//! open-science（@synsci/openscience）自动科研流水线驱动（A 档：headless CLI）。
//!
//! ## 实证结论（2026-07-12，openscience 1.3.4）
//! - `openscience run [message..]` 是真实存在的 headless 运行模式，关键 flags：
//!   `--agent <name>`（primary agent，自动科研用 `research`）、
//!   `-m provider/model`、`--format json`（stdout 逐行 JSON 事件：
//!   `{"type":"step_start"|"text"|"tool_use"|"step_finish",...}`）。
//! - 工作目录配置文件必须命名为 **`openscience.json`**（`opencode.json` 不被
//!   该 fork 读取，已实测）。provider 走 `@ai-sdk/openai-compatible`，
//!   `options.apiKey` 用 `{env:OPENAI_API_KEY}` 插值语法引用环境变量——
//!   明文 key 永不落盘，只注入子进程环境（与 pi_rpc 同一套纪律）。
//! - agent 列表（`openscience agent list`）：`research`(primary) 编排
//!   `explore` / `literature-review` / `critique` / `write` / `reviewer` 等
//!   subagent，即四阶段流水线的实际形态。
//! - 全局安装后（`npm i -g @synsci/openscience`）真实二进制位于
//!   `%APPDATA%\npm\node_modules\@synsci\openscience\node_modules\
//!   @synsci\openscience-windows-x64*\bin\openscience.exe`（bun 编译的原生
//!   exe），直接 spawn 它可避免 `cmd /c` 转义与 .cmd shim 的杀树问题。
//!
//! 事件通道：`os-event`，信封 `{ kind, ... }`：
//! - `install_output { line }` / `install_done { code }`
//! - `run_output { runId, line }` / `run_stderr { runId, line }`
//! - `run_done { runId, code }`

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{watch, Mutex};

use crate::db::Db;
use crate::procext::NoWindowExt;

/// openscience.json 里 apiKey 引用的环境变量名。真实 key 只注入子进程环境。
const OS_KEY_ENV: &str = "OPENAI_API_KEY";
/// 生成配置里的 provider 名（`-m` flag 需要 `provider/model` 形式）。
const OS_PROVIDER_NAME: &str = "agentboard";
/// 自动科研流水线的 primary agent（实测 `openscience agent list`）。
const RESEARCH_AGENT: &str = "research";
/// 未显式指定模型时的兜底。
const DEFAULT_MODEL: &str = "gpt-5.5";
/// stderr 环形缓冲行数。
const STDERR_TAIL_LINES: usize = 40;
/// 产物扫描：最大递归深度 / 最多返回条数。
const SCAN_MAX_DEPTH: usize = 6;
const SCAN_MAX_ITEMS: usize = 500;
/// os_read_text 预览上限（1 MB，防止把大文件整个吸进前端）。
const READ_TEXT_MAX_BYTES: u64 = 1024 * 1024;
/// os_read_bytes 预览上限（50 MB，base64 膨胀后 ~67 MB 仍在 WebView 可接受范围）。
const READ_BYTES_MAX: u64 = 50 * 1024 * 1024;

// ── Engine state（tauri managed）─────────────────────────────────────────────

struct OsRun {
    stop_tx: watch::Sender<bool>,
    #[allow(dead_code)]
    workspace: String,
}

/// 运行中的 openscience 子进程表：runId → handle。
pub struct OsEngine {
    inner: Arc<Mutex<HashMap<String, OsRun>>>,
}

impl Default for OsEngine {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ── os_detect ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct OsDetect {
    /// openscience CLI 可用（PATH shim 或原生 exe 任一命中）。
    pub installed: bool,
    /// `openscience --version` 输出（如 `1.3.4`）。
    pub version: Option<String>,
    /// node 可用（npm 安装的前提）。
    pub node: bool,
}

/// 检测 node 与 openscience CLI（`npm i -g @synsci/openscience`）。
#[tauri::command]
pub async fn os_detect() -> Result<OsDetect, String> {
    let (node_v, os_v) = tokio::join!(probe_version("node"), probe_version("openscience"));
    // PATH shim 探测失败时兜底看原生 exe 是否在 npm 全局目录里。
    let exe_found = locate_openscience_exe().is_some();
    Ok(OsDetect {
        installed: os_v.is_some() || exe_found,
        version: os_v,
        node: node_v.is_some(),
    })
}

/// `cmd /c <bin> --version`（Windows 下 .cmd shim 必须经 cmd 解析）。
async fn probe_version(bin: &str) -> Option<String> {
    #[cfg(windows)]
    let out = tokio::process::Command::new("cmd")
        .args(["/c", bin, "--version"])
        .no_window()
        .output()
        .await;
    #[cfg(not(windows))]
    let out = tokio::process::Command::new(bin)
        .arg("--version")
        .no_window()
        .output()
        .await;
    out.ok().filter(|o| o.status.success()).and_then(|o| {
        let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
        // 版本探测输出可能带 banner，取最后一个非空行（实测 `1.3.4` 单行）。
        v.lines()
            .rev()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(|l| l.to_string())
    })
}

// ── os_install ───────────────────────────────────────────────────────────────

/// 一键安装：spawn `npm install -g @synsci/openscience`，stdout/stderr 逐行
/// emit `os-event {kind:"install_output"}`，退出 emit `install_done {code}`。
/// 命令返回即表示已启动（流式结果走事件通道）。
#[tauri::command]
pub async fn os_install(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/c", "npm", "install", "-g", "@synsci/openscience"]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("npm");
        c.args(["install", "-g", "@synsci/openscience"]);
        c
    };
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false)
        .no_window()
        .spawn()
        .map_err(|e| format!("启动 npm 安装失败: {e}（需要已安装 Node.js/npm）"))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    {
        let app2 = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                emit_os_event(&app2, json!({ "kind": "install_output", "line": l }));
            }
        });
    }
    {
        let app2 = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                emit_os_event(&app2, json!({ "kind": "install_output", "line": l }));
            }
        });
    }
    tokio::spawn(async move {
        let code = child
            .wait()
            .await
            .map(|s| s.code().unwrap_or(-1))
            .unwrap_or(-1);
        emit_os_event(&app, json!({ "kind": "install_done", "code": code }));
    });
    Ok(())
}

// ── os_prepare ───────────────────────────────────────────────────────────────

/// 建工作目录并生成 `openscience.json`（provider baseURL 来自 AgentBoard
/// providers；apiKey 写 `{env:OPENAI_API_KEY}` 引用，明文 key 不落盘）。
/// 返回写入的配置文件路径。
#[tauri::command]
pub(crate) async fn os_prepare(
    state: State<'_, crate::AppState>,
    workspace: String,
    provider_id: Option<String>,
    model: String,
) -> Result<String, String> {
    let db = state.db.clone();
    let workspace = validate_workspace(&workspace, true)?;

    let provider_id = resolve_provider_id(&db, provider_id)?;
    let row = db
        .provider_get(&provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("服务商不存在: {provider_id}"))?;
    let model = normalize_model(Some(model));

    let cfg_path = Path::new(&workspace).join("openscience.json");
    tokio::fs::write(&cfg_path, build_openscience_json(&row.base_url, &model))
        .await
        .map_err(|e| format!("写入 openscience.json 失败: {e}"))?;
    Ok(cfg_path.to_string_lossy().to_string())
}

// ── os_run / os_stop ─────────────────────────────────────────────────────────

/// 启动自动科研流水线：spawn
/// `openscience run --agent research -m agentboard/<model> --format json <topic>`，
/// stdout 逐行 emit `run_output`，stderr emit `run_stderr`，退出 emit
/// `run_done {code}`。返回 runId。key 从 OS 凭据库取，仅注入子进程环境。
#[tauri::command]
pub(crate) async fn os_run(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    engine: State<'_, OsEngine>,
    workspace: String,
    topic: String,
    provider_id: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let db = state.db.clone();
    let workspace = validate_workspace(&workspace, false)?;
    let topic = topic.trim().to_string();
    if topic.is_empty() {
        return Err("请填写研究方向".to_string());
    }
    if !Path::new(&workspace).join("openscience.json").exists() {
        return Err("工作目录缺少 openscience.json，请先「准备配置」".to_string());
    }

    // -- provider key（keyring → 子进程 env，绝不落盘）--
    let provider_id = resolve_provider_id(&db, provider_id)?;
    let key = crate::providers::key_get(&provider_id)?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| "该服务商未设置 API Key".to_string())?;
    let model = normalize_model(model);

    // -- 定位 CLI（原生 exe 优先，PATH shim 兜底）--
    let (program, prefix_args) = resolve_openscience_cmd()?;
    let model_flag = format!("{OS_PROVIDER_NAME}/{model}");
    let mut args: Vec<String> = prefix_args;
    args.extend(
        [
            "run",
            "--agent",
            RESEARCH_AGENT,
            "-m",
            &model_flag,
            "--format",
            "json",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    args.push(topic.clone());

    let mut child = tokio::process::Command::new(&program)
        .args(&args)
        .current_dir(&workspace)
        .env(OS_KEY_ENV, &key)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_window()
        .spawn()
        .map_err(|e| format!("启动 openscience 失败: {e}（program={program}）"))?;

    let run_id = uuid::Uuid::new_v4().to_string();
    let child_id = child.id();
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // -- stdout 逐行 → run_output --
    {
        let app = app.clone();
        let rid = run_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let l = l.trim().to_string();
                if l.is_empty() {
                    continue;
                }
                emit_os_event(&app, json!({ "kind": "run_output", "runId": rid, "line": l }));
            }
        });
    }
    // -- stderr 逐行 → run_stderr + 环形缓冲 --
    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        let app = app.clone();
        let rid = run_id.clone();
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                {
                    let mut t = tail.lock().await;
                    t.push(l.clone());
                    if t.len() > STDERR_TAIL_LINES {
                        t.remove(0);
                    }
                }
                emit_os_event(&app, json!({ "kind": "run_stderr", "runId": rid, "line": l }));
            }
        });
    }

    // -- supervisor：等退出 or 停止信号 --
    let (stop_tx, mut stop_rx) = watch::channel(false);
    {
        let app = app.clone();
        let rid = run_id.clone();
        let runs = engine.inner.clone();
        let stderr_tail = stderr_tail.clone();
        tokio::spawn(async move {
            tokio::select! {
                status = child.wait() => {
                    let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                    runs.lock().await.remove(&rid);
                    let tail = stderr_tail.lock().await.join("\n");
                    emit_os_event(
                        &app,
                        json!({ "kind": "run_done", "runId": rid, "code": code, "stderr_tail": tail }),
                    );
                }
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        kill_child_id(child_id).await;
                        let _ = child.kill().await;
                        runs.lock().await.remove(&rid);
                        emit_os_event(
                            &app,
                            json!({ "kind": "run_done", "runId": rid, "code": -2, "stopped": true }),
                        );
                    }
                }
            }
        });
    }

    engine.inner.lock().await.insert(
        run_id.clone(),
        OsRun {
            stop_tx,
            workspace,
        },
    );
    Ok(run_id)
}

/// 停止一次流水线运行（Windows taskkill /F /T 整棵进程树）。
#[tauri::command]
pub async fn os_stop(engine: State<'_, OsEngine>, run_id: String) -> Result<(), String> {
    let g = engine.inner.lock().await;
    let r = g
        .get(&run_id)
        .ok_or_else(|| format!("运行不存在或已结束: {run_id}"))?;
    let _ = r.stop_tx.send(true);
    Ok(())
}

// ── os_artifacts / os_read_text ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct OsArtifact {
    pub name: String,
    pub path: String,
    /// pdf / md / tex / jsonl
    pub kind: String,
    pub size: u64,
    /// 修改时间（unix ms）。
    pub mtime: i64,
}

/// 扫描工作目录产物（递归找 .pdf/.md/.tex + provenance .jsonl），mtime 降序。
#[tauri::command]
pub async fn os_artifacts(workspace: String) -> Result<Vec<OsArtifact>, String> {
    let workspace = validate_workspace(&workspace, false)?;
    let root = PathBuf::from(workspace);
    let mut out = tokio::task::spawn_blocking(move || {
        let mut acc = Vec::new();
        scan_artifacts(&root, 0, &mut acc);
        acc
    })
    .await
    .map_err(|e| format!("产物扫描失败: {e}"))?;
    out.sort_by_key(|a| std::cmp::Reverse(a.mtime));
    out.truncate(SCAN_MAX_ITEMS);
    Ok(out)
}

/// 读取文本产物用于应用内预览（md/tex/jsonl，≤1MB，UTF-8 lossy）。
#[tauri::command]
pub async fn os_read_text(path: String) -> Result<String, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_file() {
        return Err(format!("文件不存在: {}", p.display()));
    }
    match artifact_kind(&p) {
        Some(k) if k != "pdf" => {}
        _ => return Err("该文件类型不支持文本预览".to_string()),
    }
    let meta = tokio::fs::metadata(&p).await.map_err(|e| e.to_string())?;
    if meta.len() > READ_TEXT_MAX_BYTES {
        return Err(format!(
            "文件过大（{} KB > {} KB），请在外部打开",
            meta.len() / 1024,
            READ_TEXT_MAX_BYTES / 1024
        ));
    }
    let bytes = tokio::fs::read(&p).await.map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// 读取二进制产物（PDF 等）用于应用内预览，base64 返回。≤50 MB。
#[derive(serde::Serialize)]
pub struct OsBytes {
    pub base64: String,
    pub size: u64,
}

#[tauri::command]
pub async fn os_read_bytes(path: String) -> Result<OsBytes, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_file() {
        return Err(format!("文件不存在: {}", p.display()));
    }
    let meta = tokio::fs::metadata(&p).await.map_err(|e| e.to_string())?;
    if meta.len() > READ_BYTES_MAX {
        return Err(format!(
            "文件过大（{:.1} MB > {} MB），请用系统查看器打开",
            meta.len() as f64 / (1024.0 * 1024.0),
            READ_BYTES_MAX / (1024 * 1024)
        ));
    }
    let bytes = tokio::fs::read(&p).await.map_err(|e| e.to_string())?;
    use base64::Engine as _;
    Ok(OsBytes {
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        size: meta.len(),
    })
}

/// 同步递归扫描（spawn_blocking 里跑）。跳过依赖/版本控制目录。
fn scan_artifacts(dir: &Path, depth: usize, acc: &mut Vec<OsArtifact>) {
    if depth > SCAN_MAX_DEPTH || acc.len() >= SCAN_MAX_ITEMS {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        if acc.len() >= SCAN_MAX_ITEMS {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if matches!(name.as_str(), "node_modules" | ".git" | "target" | "__pycache__" | ".venv") {
                continue;
            }
            scan_artifacts(&path, depth + 1, acc);
            continue;
        }
        let Some(kind) = artifact_kind(&path) else {
            continue;
        };
        // jsonl 只收 provenance（.openscience/provenance.jsonl 等），避免噪声。
        if kind == "jsonl" && !name.to_lowercase().contains("provenance") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        acc.push(OsArtifact {
            name,
            path: path.to_string_lossy().to_string(),
            kind: kind.to_string(),
            size: meta.len(),
            mtime,
        });
    }
}

/// 扩展名 → 产物类型。
fn artifact_kind(p: &Path) -> Option<&'static str> {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?
        .as_str()
    {
        "pdf" => Some("pdf"),
        "md" => Some("md"),
        "tex" => Some("tex"),
        "jsonl" => Some("jsonl"),
        _ => None,
    }
}

// ── 配置生成 / 路径定位 ──────────────────────────────────────────────────────

/// 生成 `openscience.json`。apiKey 是 `{env:OPENAI_API_KEY}` **引用**（实测
/// openscience 对 `{env:VAR}` 做插值）——明文 key 永不写盘。
fn build_openscience_json(base_url: &str, model: &str) -> String {
    let v = json!({
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            OS_PROVIDER_NAME: {
                "name": "AgentBoard",
                "npm": "@ai-sdk/openai-compatible",
                "options": {
                    "baseURL": normalize_base_url(base_url),
                    "apiKey": format!("{{env:{OS_KEY_ENV}}}"),
                },
                "models": {
                    model: { "name": model }
                }
            }
        }
    });
    serde_json::to_string_pretty(&v).expect("openscience.json serializes")
}

/// 把服务商 base_url 归一化为 `…/v1`。
fn normalize_base_url(base_url: &str) -> String {
    let b = base_url.trim().trim_end_matches('/');
    let root = b.strip_suffix("/v1").unwrap_or(b);
    format!("{root}/v1")
}

fn normalize_model(model: Option<String>) -> String {
    model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

/// 解析生效服务商 id（显式传入 → settings default_provider_id）。
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

/// 校验（可选创建）工作目录，返回归一化路径。
fn validate_workspace(workspace: &str, create: bool) -> Result<String, String> {
    if workspace.trim().is_empty() {
        return Err("请选择工作目录".to_string());
    }
    let w = normalize_spawn_path(Path::new(workspace.trim()));
    if create {
        std::fs::create_dir_all(&w).map_err(|e| format!("创建工作目录失败: {e}"))?;
    }
    if !w.is_dir() {
        return Err(format!("工作目录不存在: {}", w.display()));
    }
    Ok(w.to_string_lossy().to_string())
}

/// 定位 openscience 启动方式：原生 exe 直接 spawn（干净的 argv 与杀树），
/// 找不到再退回 `cmd /c openscience`（PATH shim）。
fn resolve_openscience_cmd() -> Result<(String, Vec<String>), String> {
    if let Some(exe) = locate_openscience_exe() {
        return Ok((exe.to_string_lossy().to_string(), vec![]));
    }
    #[cfg(windows)]
    {
        Ok(("cmd".to_string(), vec!["/c".into(), "openscience".into()]))
    }
    #[cfg(not(windows))]
    {
        Ok(("openscience".to_string(), vec![]))
    }
}

/// npm 全局安装的原生 exe 候选（Windows）：
/// `%APPDATA%\npm\node_modules\@synsci\openscience\node_modules\@synsci\
/// openscience-windows-x64*\bin\openscience.exe`，另兜底 `~/.openscience/bin`。
fn locate_openscience_exe() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let scoped = PathBuf::from(appdata)
                .join("npm")
                .join("node_modules")
                .join("@synsci")
                .join("openscience")
                .join("node_modules")
                .join("@synsci");
            if let Ok(rd) = std::fs::read_dir(&scoped) {
                let mut candidates: Vec<PathBuf> = rd
                    .flatten()
                    .filter(|e| {
                        e.file_name()
                            .to_string_lossy()
                            .starts_with("openscience-windows-")
                    })
                    .map(|e| e.path().join("bin").join("openscience.exe"))
                    .filter(|p| p.is_file())
                    .collect();
                // 精确名（无 -baseline 后缀）优先。
                candidates.sort_by_key(|p| p.to_string_lossy().contains("baseline"));
                if let Some(p) = candidates.into_iter().next() {
                    return Some(normalize_spawn_path(&p));
                }
            }
        }
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let p = PathBuf::from(home)
                .join(".openscience")
                .join("bin")
                .join("openscience.exe");
            if p.is_file() {
                return Some(normalize_spawn_path(&p));
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var_os("HOME")?;
        let p = PathBuf::from(home)
            .join(".openscience")
            .join("bin")
            .join("openscience");
        p.is_file().then_some(p)
    }
}

// ── 杂项（按仓库惯例各模块自持一份）──────────────────────────────────────────

fn emit_os_event(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit("os-event", payload);
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

// ── 单元测试 ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn openscience_json_references_env_key_not_plaintext() {
        let s = build_openscience_json("https://relay.example.com", "gpt-5.5");
        let v: Value = serde_json::from_str(&s).expect("valid json");
        let p = &v["provider"][OS_PROVIDER_NAME];
        assert_eq!(p["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(p["options"]["baseURL"], "https://relay.example.com/v1");
        // key 必须是 {env:VAR} 引用，绝不是字面量密钥。
        assert_eq!(p["options"]["apiKey"], "{env:OPENAI_API_KEY}");
        assert!(!s.to_lowercase().contains("sk-"));
        // 模型条目存在。
        assert!(p["models"]["gpt-5.5"].is_object());
        // 无 BOM。
        assert!(!s.starts_with('\u{feff}'));
    }

    #[test]
    fn normalize_base_url_variants() {
        assert_eq!(normalize_base_url("https://x.com"), "https://x.com/v1");
        assert_eq!(normalize_base_url("https://x.com/"), "https://x.com/v1");
        assert_eq!(normalize_base_url("https://x.com/v1"), "https://x.com/v1");
        assert_eq!(normalize_base_url("https://x.com/v1/"), "https://x.com/v1");
    }

    #[test]
    fn normalize_model_defaults() {
        assert_eq!(normalize_model(None), "gpt-5.5");
        assert_eq!(normalize_model(Some("  ".into())), "gpt-5.5");
        assert_eq!(normalize_model(Some("o3".into())), "o3");
    }

    #[test]
    fn artifact_kind_classification() {
        assert_eq!(artifact_kind(Path::new("a/paper.PDF")), Some("pdf"));
        assert_eq!(artifact_kind(Path::new("notes.md")), Some("md"));
        assert_eq!(artifact_kind(Path::new("main.tex")), Some("tex"));
        assert_eq!(artifact_kind(Path::new("provenance.jsonl")), Some("jsonl"));
        assert_eq!(artifact_kind(Path::new("data.csv")), None);
        assert_eq!(artifact_kind(Path::new("noext")), None);
    }

    #[test]
    fn scan_finds_artifacts_and_skips_node_modules() {
        let tmp = std::env::temp_dir().join(format!("os-scan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(tmp.join(".openscience")).unwrap();
        std::fs::create_dir_all(tmp.join("node_modules/pkg")).unwrap();
        std::fs::write(tmp.join("paper.pdf"), b"%PDF").unwrap();
        std::fs::write(tmp.join("report.md"), "# r").unwrap();
        std::fs::write(tmp.join(".openscience/provenance.jsonl"), "{}\n").unwrap();
        std::fs::write(tmp.join("random.jsonl"), "{}\n").unwrap(); // 非 provenance，应跳过
        std::fs::write(tmp.join("node_modules/pkg/readme.md"), "x").unwrap(); // 应跳过

        let mut acc = Vec::new();
        scan_artifacts(&tmp, 0, &mut acc);
        let _ = std::fs::remove_dir_all(&tmp);

        let names: Vec<&str> = acc.iter().map(|a| a.name.as_str()).collect();
        assert!(names.contains(&"paper.pdf"));
        assert!(names.contains(&"report.md"));
        assert!(names.contains(&"provenance.jsonl"));
        assert!(!names.contains(&"random.jsonl"));
        assert_eq!(acc.iter().filter(|a| a.name == "readme.md").count(), 0);
        let pdf = acc.iter().find(|a| a.name == "paper.pdf").unwrap();
        assert_eq!(pdf.kind, "pdf");
        assert!(pdf.size > 0);
        assert!(pdf.mtime > 0);
    }

    #[test]
    fn validate_workspace_rejects_empty_and_missing() {
        assert!(validate_workspace("", false).is_err());
        assert!(validate_workspace("Z:/definitely/not/a/dir-xyz", false).is_err());
        // create=true 时应能建目录。
        let tmp = std::env::temp_dir().join(format!("os-ws-{}", uuid::Uuid::new_v4()));
        let s = validate_workspace(&tmp.to_string_lossy(), true).unwrap();
        assert!(Path::new(&s).is_dir());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
