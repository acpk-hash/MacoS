//! Hooks 后端支持：前端每次增删 hook 后调 hooks_sync 写 active-hooks.json，
//! pi_open 写 AGENTS.MD 时读取此文件拼入活跃 hooks 指令段。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 前端传来的单个 hook 同步条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct HookEntry {
    pub id: String,
    pub instruction: String,
}

/// 活跃 hooks 文件名（写在 app_data_dir 下）。
const ACTIVE_HOOKS_FILE: &str = "active-hooks.json";

/// 前端每次 install/uninstall hook 后调用，把当前启用列表写入
/// `<app_data_dir>/active-hooks.json`。
#[tauri::command]
pub(crate) async fn hooks_sync(
    app: AppHandle,
    hooks: Vec<HookEntry>,
) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法取得应用数据目录: {e}"))?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("创建数据目录失败: {e}"))?;
    let json = serde_json::to_string_pretty(&hooks)
        .map_err(|e| format!("序列化 hooks 失败: {e}"))?;
    tokio::fs::write(dir.join(ACTIVE_HOOKS_FILE), json)
        .await
        .map_err(|e| format!("写入 active-hooks.json 失败: {e}"))?;
    Ok(())
}

/// 供 pi_rpc::pi_open 调用：读取 active-hooks.json，拼出追加到 AGENTS.MD
/// 末尾的 hooks 指令段。若文件不存在或为空则返回空字符串。
pub(crate) fn build_hooks_agents_md_section(app_data_dir: &std::path::Path) -> String {
    let path = app_data_dir.join(ACTIVE_HOOKS_FILE);
    let Ok(data) = std::fs::read_to_string(&path) else {
        return String::new();
    };
    let Ok(hooks) = serde_json::from_str::<Vec<HookEntry>>(&data) else {
        return String::new();
    };
    if hooks.is_empty() {
        return String::new();
    }
    let mut section = String::from("\n## 活跃 Hooks\n\n");
    for h in &hooks {
        section.push_str(&format!("### {}\n{}\n\n", h.id, h.instruction));
    }
    section
}