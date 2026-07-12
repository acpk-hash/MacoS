//! 真交互式终端（P8）：portable-pty 驱动本地 shell。
//!
//! Windows 走 ConPTY（portable-pty 的 native pty），其它平台走 openpty。
//! 生命周期与数据流：
//!   - `pty_open{cwd, cols, rows}` → 在 cwd 起一个真 shell，返回终端 id；
//!     一个阻塞 reader 线程把子进程输出按块 base64 后经 Tauri 事件
//!     `pty-output{id, data}` 流式推给前端（base64 避免多字节 UTF-8 在
//!     读块边界被截断的问题——前端把字节直接喂给 xterm 的 UTF-8 解码器）。
//!   - `pty_write{id, data}` → 用户键入写回 PTY；`pty_resize` 同步行列。
//!   - 子进程退出（或被 `pty_close` 杀掉）→ waiter 线程发 `pty-exit{id, code}`
//!     并从会话表移除（drop master 让 reader 线程自然收尾，防僵尸进程）。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

/// 行列夹取范围（防御非法参数；ConPTY 对 0 行列会报错）。
const MIN_DIM: u16 = 2;
const MAX_DIM: u16 = 500;

// ── 状态 ────────────────────────────────────────────────────────────────────

/// 一个存活的 PTY 会话（master 供 resize；writer 供用户输入；killer 供关闭）。
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// 全部存活 PTY 会话。Arc 让 waiter 线程能在子进程退出后自行清理表项。
pub struct PtyState {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ── 事件载荷 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct PtyOutput {
    id: String,
    /// base64 编码的原始输出字节。
    data: String,
}

#[derive(Debug, Clone, Serialize)]
struct PtyExit {
    id: String,
    code: Option<u32>,
}

// ── 纯函数（可单测） ─────────────────────────────────────────────────────────

/// 平台默认 shell：Windows 用 powershell.exe（系统必装，ConPTY 兼容好）；
/// 其它平台用 $SHELL，缺省 /bin/bash。
fn shell_program() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        ("powershell.exe".to_string(), vec!["-NoLogo".to_string()])
    }
    #[cfg(not(windows))]
    {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        (sh, Vec::new())
    }
}

/// 夹取行列到安全范围。
fn clamp_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(MIN_DIM, MAX_DIM),
        cols: cols.clamp(MIN_DIM, MAX_DIM),
        pixel_width: 0,
        pixel_height: 0,
    }
}

// ── Tauri 命令 ──────────────────────────────────────────────────────────────

/// 在 `cwd` 起一个真 shell，返回终端 id。输出经 `pty-output` 事件流式推送。
#[tauri::command]
pub(crate) async fn pty_open(
    cwd: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() || !Path::new(&cwd).is_dir() {
        return Err(format!("终端工作目录不存在: {cwd}"));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(clamp_size(cols, rows))
        .map_err(|e| format!("创建 PTY 失败: {e}"))?;

    let (prog, args) = shell_program();
    let mut cmd = CommandBuilder::new(&prog);
    for a in &args {
        cmd.arg(a);
    }
    cmd.cwd(&cwd);
    #[cfg(not(windows))]
    cmd.env("TERM", "xterm-256color");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 shell 失败（{prog}）: {e}"))?;
    // slave 端交给子进程后立刻放掉，master 端保留给我们读写。
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("获取 PTY 读端失败: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("获取 PTY 写端失败: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    state.pty.sessions.lock().unwrap().insert(
        id.clone(),
        PtySession {
            master: pair.master,
            writer,
            killer,
        },
    );

    // Reader 线程：阻塞读子进程输出 → base64 → pty-output 事件。
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // EOF / master 已被 drop
                    Ok(n) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app.emit("pty-output", &PtyOutput { id: id.clone(), data });
                    }
                }
            }
        });
    }

    // Waiter 线程：等子进程退出 → 清理会话表（drop master 收掉 reader）→ pty-exit。
    {
        let app = app.clone();
        let id = id.clone();
        let sessions = state.pty.sessions.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            drop(sessions.lock().unwrap().remove(&id));
            let _ = app.emit("pty-exit", &PtyExit { id, code });
        });
    }

    Ok(id)
}

/// 把用户输入写进 PTY。
#[tauri::command]
pub(crate) async fn pty_write(
    id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut g = state.pty.sessions.lock().unwrap();
    let s = g.get_mut(&id).ok_or_else(|| "终端已关闭".to_string())?;
    s.writer
        .write_all(data.as_bytes())
        .and_then(|_| s.writer.flush())
        .map_err(|e| format!("写入终端失败: {e}"))
}

/// 同步终端行列（前端 FitAddon / ResizeObserver 驱动）。
#[tauri::command]
pub(crate) async fn pty_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let g = state.pty.sessions.lock().unwrap();
    let s = g.get(&id).ok_or_else(|| "终端已关闭".to_string())?;
    s.master
        .resize(clamp_size(cols, rows))
        .map_err(|e| format!("调整终端尺寸失败: {e}"))
}

/// 关闭终端：杀 shell 子进程并移除会话（waiter 线程随后发 pty-exit）。
#[tauri::command]
pub(crate) async fn pty_close(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let session = state.pty.sessions.lock().unwrap().remove(&id);
    if let Some(mut s) = session {
        let _ = s.killer.kill();
        // drop(s) → master/writer 关闭 → reader 线程 EOF 收尾。
    }
    Ok(())
}

// ── 单元测试 ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn shell_program_is_sane() {
        let (prog, _args) = shell_program();
        assert!(!prog.trim().is_empty());
        #[cfg(windows)]
        assert_eq!(prog, "powershell.exe");
    }

    #[test]
    fn clamp_size_bounds() {
        let s = clamp_size(0, 0);
        assert_eq!((s.cols, s.rows), (MIN_DIM, MIN_DIM));
        let s = clamp_size(120, 30);
        assert_eq!((s.cols, s.rows), (120, 30));
        let s = clamp_size(9999, 9999);
        assert_eq!((s.cols, s.rows), (MAX_DIM, MAX_DIM));
    }

    #[test]
    fn pty_state_starts_empty() {
        let st = PtyState::new();
        assert!(st.sessions.lock().unwrap().is_empty());
    }

    /// LIVE：真起一个 PTY shell，写入 echo 命令，断言回显输出。
    /// 运行：`cargo test -p agentboard --lib pty::tests::live_pty_echo_roundtrip -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_pty_echo_roundtrip() {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(clamp_size(80, 24)).expect("openpty");

        let (prog, args) = shell_program();
        let mut cmd = CommandBuilder::new(&prog);
        for a in &args {
            cmd.arg(a);
        }
        cmd.cwd(std::env::temp_dir());
        let mut child = pair.slave.spawn_command(cmd).expect("spawn shell");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");

        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        // ConPTY 起步会发 DSR 光标位置查询（ESC[6n）并等终端应答后才继续
        // 渲染——真实前端由 xterm.js 自动应答，这里由测试代劳（ESC[1;1R）。
        let marker = "pty-live-ok-42";
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut acc = String::new();
        let mut dsr_answered = 0usize;
        let mut cmd_sent = false;
        while Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(300)) {
                acc.push_str(&String::from_utf8_lossy(&chunk));
            }
            let dsr_seen = acc.matches("\x1b[6n").count();
            while dsr_answered < dsr_seen {
                writer.write_all(b"\x1b[1;1R").expect("answer DSR");
                writer.flush().expect("flush DSR");
                dsr_answered += 1;
            }
            // 提示符出现（PowerShell 的 `>` / bash 的 `$`）后敲入 echo。
            if !cmd_sent && (acc.contains('>') || acc.contains('$')) {
                std::thread::sleep(Duration::from_millis(300));
                writer.write_all(b"echo pty-live-ok-42\r").expect("write cmd");
                writer.flush().expect("flush cmd");
                cmd_sent = true;
            }
            // 输入回显 + 命令输出 → marker 出现 ≥2 次为强证据。
            if acc.matches(marker).count() >= 2 {
                break;
            }
        }
        println!("[live-pty] shell={prog} bytes={} output:\n{acc}", acc.len());
        let _ = child.kill();
        assert!(
            acc.contains(marker),
            "PTY 必须回显 echo 输出，实际输出:\n{acc}"
        );
    }
}
