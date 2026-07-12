//! 子进程创建扩展：Windows 下抑制控制台黑框弹窗。
//!
//! Tauri 主程序是 GUI 子系统进程（无控制台）。它直接 spawn 的任何控制台
//! 子进程（codex 引擎、git、taskkill、cmd/node 探测等）默认会新建一个
//! **可见**的 conhost 窗口——即用户看到的"黑框闪现"。`CREATE_NO_WINDOW`
//! (0x08000000) 让子进程挂一个不可见控制台运行；其后代进程（引擎再 spawn
//! 的 codex.exe / 命令 runner）继承这个隐藏控制台，同样不会弹窗。
//!
//! 终端（pty.rs）不经此路径：portable-pty 用 ConPTY
//! （EXTENDED_STARTUPINFO_PRESENT + PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE）
//! 挂接 shell，conhost 以 headless 方式运行，本就不会弹出外部窗口。

/// Windows `CREATE_NO_WINDOW` process-creation flag.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 链式辅助：让 tokio `Command` 以"无控制台窗口"方式创建子进程。
pub trait NoWindowExt {
    /// Windows 下加 `CREATE_NO_WINDOW` 创建标志；其它平台为 no-op。
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindowExt for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

// ── 单元测试 ────────────────────────────────────────────────────────────────

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// 加了标志后子进程仍正常运行（功能冒烟）。
    #[tokio::test]
    async fn no_window_spawn_succeeds() {
        let out = tokio::process::Command::new("cmd")
            .args(["/c", "echo", "ok"])
            .no_window()
            .output()
            .await
            .expect("spawn cmd");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("ok"));
    }

    /// PowerShell 探针：在子进程内部查询自己的控制台窗口是否可见。
    const PROBE: &str = r#"Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);' -Name W -Namespace P; [P.W]::IsWindowVisible([P.W]::GetConsoleWindow())"#;

    /// 关键证据：带 `CREATE_NO_WINDOW` 的子进程没有**可见**控制台窗口
    /// （GetConsoleWindow 为 NULL 或 ConPTY 的隐藏伪窗口）。同时打印
    /// 不带标志的对照结果（其可见性取决于测试宿主是否有交互控制台，
    /// 故只打印不断言）。
    #[tokio::test]
    async fn no_window_child_has_no_visible_console() {
        let flagged = tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", PROBE])
            .no_window()
            .output()
            .await
            .expect("spawn flagged probe");
        let flagged_out = String::from_utf8_lossy(&flagged.stdout).trim().to_string();

        let control = tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", PROBE])
            .output()
            .await
            .expect("spawn control probe");
        let control_out = String::from_utf8_lossy(&control.stdout).trim().to_string();

        println!("[no-window] flagged probe IsWindowVisible={flagged_out}, control(no flag)={control_out}");
        assert!(
            flagged_out.contains("False"),
            "CREATE_NO_WINDOW 子进程不得有可见控制台窗口，探针输出: {flagged_out}"
        );
    }
}
