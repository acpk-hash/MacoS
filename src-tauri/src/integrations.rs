use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Manager};

use crate::procext::NoWindowExt;

#[derive(Clone, Copy)]
struct IntegrationSpec {
    id: &'static str,
    name: &'static str,
    repo: &'static str,
    license: &'static str,
    capability: &'static str,
    dir: &'static str,
    marker: &'static str,
    prerequisites: &'static [&'static str],
    install: &'static str,
    launch: &'static str,
    local_url: Option<&'static str>,
}

const SPECS: &[IntegrationSpec] = &[
    IntegrationSpec { id: "yuxi", name: "Yuxi", repo: "https://github.com/xerrors/Yuxi", license: "MIT", capability: "知识库、知识图谱与智能问答", dir: "Yuxi", marker: "docker-compose.yml", prerequisites: &["docker"], install: "docker compose build", launch: "docker compose up -d", local_url: Some("http://localhost:5173") },
    IntegrationSpec { id: "scientific-agent-skills", name: "scientific-agent-skills", repo: "https://github.com/K-Dense-AI/scientific-agent-skills", license: "MIT", capability: "科研技能库导入源", dir: "scientific-agent-skills", marker: "skills", prerequisites: &[], install: "导入 149 个 Skills", launch: "", local_url: None },
    IntegrationSpec { id: "draftpaper-loop", name: "Draftpaper_loop", repo: "https://github.com/xiejhhhhhh/Draftpaper_loop", license: "Repository license", capability: "本地优先科研论文循环引擎", dir: "Draftpaper_loop", marker: "pyproject.toml", prerequisites: &["uv"], install: "uv pip install --python .venv\\Scripts\\python.exe -e .[plotting]", launch: ".venv\\Scripts\\draftpaper.exe --help", local_url: None },
    IntegrationSpec { id: "landppt", name: "LandPPT", repo: "https://github.com/sligter/LandPPT", license: "Repository license", capability: "本地 PPT 生成与修改服务", dir: "LandPPT", marker: "run.py", prerequisites: &["uv"], install: "uv sync", launch: "uv run python run.py", local_url: Some("http://localhost:8000") },
    IntegrationSpec { id: "money-printer-turbo", name: "MoneyPrinterTurbo", repo: "https://github.com/harry0703/MoneyPrinterTurbo", license: "MIT", capability: "AI 短视频自动生成流水线", dir: "MoneyPrinterTurbo", marker: "webui.bat", prerequisites: &["uv", "ffmpeg"], install: "uv sync --frozen", launch: "webui.bat", local_url: Some("http://localhost:8501") },
    IntegrationSpec { id: "open-montage", name: "OpenMontage", repo: "https://github.com/calesthio/OpenMontage", license: "AGPL-3.0", capability: "智能视频制作与审核流水线", dir: "OpenMontage", marker: "requirements.txt", prerequisites: &["uv", "npm", "ffmpeg"], install: "uv venv .venv && uv pip install --python .venv\\Scripts\\python.exe -r requirements.txt piper-tts && cd remotion-composer && npm install", launch: "cmd /K .venv\\Scripts\\activate.bat", local_url: None },
    IntegrationSpec { id: "abtop", name: "abtop", repo: "https://github.com/graykode/abtop", license: "MIT", capability: "Agent 用量与进程监控终端", dir: "abtop", marker: "Cargo.toml", prerequisites: &["cargo"], install: "cargo build --release", launch: "target\\release\\abtop.exe", local_url: None },
    IntegrationSpec { id: "drawnix", name: "drawnix", repo: "https://github.com/plait-board/drawnix", license: "MIT", capability: "开源白板与思维导图", dir: "drawnix", marker: "package.json", prerequisites: &["npm"], install: "npm install", launch: "npm run start", local_url: Some("http://localhost:7200") },
    IntegrationSpec { id: "trendradar", name: "TrendRadar", repo: "https://github.com/sansan0/TrendRadar", license: "GPL-3.0", capability: "热榜、RSS、报告与多通道推送", dir: "TrendRadar", marker: "trendradar", prerequisites: &["uv"], install: "uv sync", launch: "set PYTHONUTF8=1&& uv run python -m trendradar", local_url: None },
];

#[derive(Debug, Serialize)]
pub struct IntegrationStatus {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub license: String,
    pub capability: String,
    pub path: String,
    pub source_ready: bool,
    pub prerequisites_ready: bool,
    pub missing_prerequisites: Vec<String>,
    pub installed: bool,
    pub install_command: String,
    pub launch_command: String,
    pub local_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IntegrationCommandResult {
    pub id: String,
    pub command: String,
    pub success: bool,
    pub output: String,
}

fn external_root() -> PathBuf {
    if let Some(v) = std::env::var_os("AGENTBOARD_EXTERNAL_DIR") {
        return PathBuf::from(v);
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = manifest.parent() {
        let candidate = root.join("external");
        if candidate.is_dir() { return candidate; }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for base in cwd.ancestors() {
            let candidate = base.join("external");
            if candidate.is_dir() { return candidate; }
        }
    }
    PathBuf::from("external")
}

fn spec(id: &str) -> Result<IntegrationSpec, String> {
    SPECS.iter().copied().find(|x| x.id == id).ok_or_else(|| format!("未知集成: {id}"))
}

#[cfg(windows)]
async fn command_exists(name: &str) -> bool {
    let found = tokio::process::Command::new("where").arg(name).no_window().stdout(Stdio::null()).stderr(Stdio::null()).status().await.map(|s| s.success()).unwrap_or(false);
    if found { return true; }
    name == "docker" && Path::new(r"C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe").is_file()
}

#[cfg(not(windows))]
async fn command_exists(name: &str) -> bool {
    tokio::process::Command::new("sh").arg("-lc").arg(format!("command -v {}", name)).stdout(Stdio::null()).stderr(Stdio::null()).status().await.map(|s| s.success()).unwrap_or(false)
}

fn installed_marker(spec: IntegrationSpec, path: &Path, shared_skills: Option<&Path>) -> bool {
    match spec.id {
        "yuxi" => false,
        "scientific-agent-skills" => shared_skills.map(|p| p.join("scientific-schematics/SKILL.md").is_file()).unwrap_or(false),
        "abtop" => path.join("target/release/abtop.exe").is_file() || path.join("target/release/abtop").is_file(),
        "drawnix" => path.join("node_modules").is_dir(),
        "open-montage" => path.join(".venv").is_dir() && path.join("remotion-composer/node_modules").is_dir(),
        _ => path.join(".venv").is_dir(),
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() { copy_dir_recursive(&from, &to)?; }
        else if from.is_file() { fs::copy(&from, &to).map_err(|e| e.to_string())?; }
    }
    Ok(())
}

fn import_scientific_skills(app: &AppHandle, source: &Path) -> Result<usize, String> {
    let dest_root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("skills");
    fs::create_dir_all(&dest_root).map_err(|e| e.to_string())?;
    let mut count = 0;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let skill_dir = entry.path();
        if skill_dir.is_dir() && skill_dir.join("SKILL.md").is_file() {
            copy_dir_recursive(&skill_dir, &dest_root.join(entry.file_name()))?;
            count += 1;
        }
    }
    Ok(count)
}

#[tauri::command]
pub async fn integrations_list(app: AppHandle) -> Result<Vec<IntegrationStatus>, String> {
    let root = external_root();
    let shared_skills = app.path().app_data_dir().ok().map(|p| p.join("skills"));
    let mut out = Vec::with_capacity(SPECS.len());
    for s in SPECS {
        let path = root.join(s.dir);
        let source_ready = path.join(s.marker).exists() && path.join(".git").is_dir();
        let mut missing = Vec::new();
        for req in s.prerequisites {
            if !command_exists(req).await { missing.push((*req).to_string()); }
        }
        out.push(IntegrationStatus {
            id: s.id.into(), name: s.name.into(), repo: s.repo.into(), license: s.license.into(), capability: s.capability.into(),
            path: path.to_string_lossy().to_string(), source_ready, prerequisites_ready: missing.is_empty(), missing_prerequisites: missing,
            installed: source_ready && installed_marker(*s, &path, shared_skills.as_deref()), install_command: s.install.into(), launch_command: s.launch.into(), local_url: s.local_url.map(str::to_string),
        });
    }
    Ok(out)
}

async fn run_shell(path: &Path, command: &str) -> Result<std::process::Output, String> {
    #[cfg(windows)]
    let mut cmd = { let mut c = tokio::process::Command::new("cmd"); c.args(["/D", "/S", "/C", command]); c.no_window(); c };
    #[cfg(not(windows))]
    let mut cmd = { let mut c = tokio::process::Command::new("sh"); c.args(["-lc", command]); c };
    cmd.current_dir(path).output().await.map_err(|e| format!("命令启动失败: {e}"))
}

#[tauri::command]
pub async fn integration_install(app: AppHandle, id: String) -> Result<IntegrationCommandResult, String> {
    let s = spec(&id)?;
    let path = external_root().join(s.dir);
    if !path.join(s.marker).exists() { return Err(format!("源码目录不存在: {}", path.display())); }
    for req in s.prerequisites {
        if !command_exists(req).await { return Err(format!("缺少前置工具: {req}")); }
    }
    if s.id == "scientific-agent-skills" {
        let count = import_scientific_skills(&app, &path.join("skills"))?;
        return Ok(IntegrationCommandResult { id, command: s.install.into(), success: count > 0, output: format!("已导入 {count} 个科研 Skills 到 Iris 共享技能目录") });
    }
    if s.install.is_empty() { return Err("该集成没有安装命令".into()); }
    let output = run_shell(&path, s.install).await?;
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    Ok(IntegrationCommandResult { id, command: s.install.into(), success: output.status.success(), output: text.chars().rev().take(12_000).collect::<String>().chars().rev().collect() })
}

#[tauri::command]
pub async fn integration_launch(id: String) -> Result<IntegrationCommandResult, String> {
    let s = spec(&id)?;
    let path = external_root().join(s.dir);
    if !path.join(s.marker).exists() { return Err(format!("源码目录不存在: {}", path.display())); }
    if s.launch.is_empty() { return Err("该项目是资源集成，不提供独立服务".into()); }
    #[cfg(windows)]
    let mut child = { let mut c = tokio::process::Command::new("cmd"); c.args(["/D", "/S", "/C", "start", "", "/B", s.launch]); c.no_window(); c };
    #[cfg(not(windows))]
    let mut child = { let mut c = tokio::process::Command::new("sh"); c.args(["-lc", &format!("nohup {} >/tmp/iris-{}.log 2>&1 &", s.launch, s.id)]); c };
    child.current_dir(&path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("启动失败: {e}"))?;
    Ok(IntegrationCommandResult { id, command: s.launch.into(), success: true, output: s.local_url.map(|u| format!("已启动: {u}")).unwrap_or_else(|| "进程已启动".into()) })
}

#[tauri::command]
pub async fn integration_open_dir(id: String) -> Result<(), String> {
    let s = spec(&id)?;
    let path = external_root().join(s.dir);
    if !path.is_dir() { return Err(format!("目录不存在: {}", path.display())); }
    #[cfg(windows)]
    let result = tokio::process::Command::new("explorer").arg(&path).no_window().spawn();
    #[cfg(target_os = "macos")]
    let result = tokio::process::Command::new("open").arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = tokio::process::Command::new("xdg-open").arg(&path).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}
