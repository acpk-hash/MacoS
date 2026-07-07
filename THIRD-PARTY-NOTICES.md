# Third-Party Notices / 第三方声明

AgentBoard incorporates third-party open-source software. This document lists the
principal components and their licenses. Full license texts are available at the
linked upstream repositories.

AgentBoard 使用了以下第三方开源软件。本文件列出主要组件及其许可协议，完整许可文本
请参见各上游仓库链接。

---

## OpenAI Codex (`codex-rs`) — Apache License 2.0

- Upstream: https://github.com/openai/codex
- Pinned version: `rust-v0.134.0`
- License: Apache License, Version 2.0 — https://github.com/openai/codex/blob/main/LICENSE

AgentBoard's built-in engine (`agentboard-engine`) links the Codex Rust crates as a
library — specifically `codex-core`, `codex-protocol`, `codex-login`,
`codex-exec-server`, and `codex-extension-api` — and compiles them into our own
standalone binary. We do **not** redistribute the unmodified `codex` CLI; instead we
build a separate executable that hosts `codex-core` in-process and speaks a private
NDJSON-over-stdio protocol to the AgentBoard desktop app.

### Statement of modifications (Apache-2.0 §4b)

- No source modifications are made to the Codex crates themselves; they are consumed
  as unmodified Git dependencies pinned to tag `rust-v0.134.0`.
- We provide a new, original binary (`agentboard-engine`) that wraps and drives these
  crates. The wrapper code is authored by the AgentBoard project.
- The build replicates Codex's upstream `[patch.crates-io]` pins for
  `tokio-tungstenite` / `tungstenite` (OpenAI OSS forks) so dependency resolution
  matches upstream; these forks are themselves Apache-2.0 / MIT licensed.

A copy of the Apache License 2.0 governing these components is available at
https://www.apache.org/licenses/LICENSE-2.0. The Codex `NOTICE` file, if present in a
release, is reproduced in accordance with Apache-2.0 §4d via the upstream link above.

The CLI-engine mode of AgentBoard invokes a separately installed `codex` executable as
an external process; that executable is distributed by OpenAI under its own license.

---

## Frontend dependencies (MIT unless noted)

| Package | License | Homepage |
| --- | --- | --- |
| @xyflow/react (React Flow) | MIT | https://github.com/xyflow/xyflow |
| react / react-dom | MIT | https://github.com/facebook/react |
| react-router-dom | MIT | https://github.com/remix-run/react-router |
| react-markdown | MIT | https://github.com/remarkjs/react-markdown |
| remark-gfm | MIT | https://github.com/remarkjs/remark-gfm |
| rehype-highlight | MIT | https://github.com/rehypejs/rehype-highlight |
| highlight.js | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| zustand | MIT | https://github.com/pmndrs/zustand |
| @tauri-apps/api, @tauri-apps/plugin-dialog | MIT / Apache-2.0 | https://github.com/tauri-apps/tauri |

## Desktop shell & Rust dependencies

| Component | License | Homepage |
| --- | --- | --- |
| Tauri (v2) | MIT / Apache-2.0 | https://github.com/tauri-apps/tauri |
| tokio | MIT | https://github.com/tokio-rs/tokio |
| serde / serde_json | MIT / Apache-2.0 | https://github.com/serde-rs/serde |
| rusqlite (bundled SQLite) | MIT / Public Domain (SQLite) | https://github.com/rusqlite/rusqlite |
| reqwest | MIT / Apache-2.0 | https://github.com/seanmonstar/reqwest |
| toml_edit | MIT / Apache-2.0 | https://github.com/toml-rs/toml |
| similar | MIT / Apache-2.0 | https://github.com/mitsuhiko/similar |
| thiserror, uuid, base64, futures-util, tokio-util | MIT / Apache-2.0 | crates.io |

---

Each listed project is the property of its respective copyright holders and is used
under the terms of its license. Where a component is dual-licensed (MIT / Apache-2.0),
AgentBoard's use is compatible with either.
