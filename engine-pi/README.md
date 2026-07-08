# engine-pi — 内置工作区引擎运行时

工作区（Workbench）不再依赖用户本机全局安装的 `pi` CLI。安装包会**自带**一份
`pi` (@earendil-works/pi-coding-agent) 运行时，运行时从这里加载：

```
engine-pi/
  node.exe                 # 独立的 Node 运行时（不依赖系统 node）
  pi/
    dist/cli.js            # pi 入口（--mode rpc）
    node_modules/          # pi 的运行时依赖（自包含，实测可离线运行）
    package.json
```

实测 `engine-pi/node.exe engine-pi/pi/dist/cli.js --version` 输出 `0.80.3`，
即该副本自包含、可独立运行。

## 体积

约 **240 MB**（node.exe ≈ 86 MB + pi 含 node_modules ≈ 154 MB）。这些文件**不入 git**
（见 `.gitignore`），而是在**构建前**由脚本从当前构建机准备好，再由 Tauri 打进安装器。

## 构建前准备

在打包（`npm run tauri build`）之前，先在构建机上执行：

```powershell
pwsh scripts/prepare-engine-pi.ps1
```

该脚本会：
1. 定位本机 `node.exe`（PATH 中的 node）并复制到 `engine-pi/node.exe`；
2. 定位全局 npm 安装的 `@earendil-works/pi-coding-agent`（含 `node_modules`）并复制到
   `engine-pi/pi/`；
3. 跑一次 `--version` 自检，确认副本自包含。

若本机未全局安装 pi：`npm i -g @earendil-works/pi-coding-agent`。

## 运行时解析顺序（见 `src-tauri/src/pi_engine.rs`）

1. **打包资源** `engine-pi/node.exe` + `engine-pi/pi/dist/cli.js`（优先）
2. 设置项 `pi_cli_path`（配合系统 node）
3. 回退：全局 npm 安装的 pi（配合系统 node）
