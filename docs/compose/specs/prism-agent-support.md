---
feature: prism-agent-support
status: designed
updated: 2026-11-11
branch: feat/prism-agent-support
commits: 361cb0e..(交付时填写)
---

# Prism agent 选项：检测、桥接适配与会话切换

## Report

## [S1] 问题

HachimoDock 已适配 DeepSeek Harness，但 prism-agent 是安装身份独立的分叉（bin `prism`、home `~/.prism`、应用 "Prism Agent"），既不被检测也不被桥接。此外设备气泡选择无法切换它的桌面对话。

## [S2] 设计

### S2.1 Agent 选项

`pc/src/lib/agent-appearance-config.js` 的 `FIXED_AGENT_OPTIONS` 增加 `{ id: "prism-agent", label: "Prism", detail: "Prism（DeepSeek Harness 分支）桌面对话与本地桥接渠道" }`，排在 `deepseek-harness` 之后。派生函数（`normalizeDetectedAgents`、`sanitizeAgentAppearanceMap` 等）按既有 `FIXED_AGENT_OPTIONS` 驱动，无需单独改动。

### S2.2 本地检测（Rust）

`detect_prism()` 镜像 `detect_dsh()`：应用候选（macOS `Prism Agent.app` / bundle id `ai.prism.agent.desktop`；Windows `%LOCALAPPDATA%\Programs\Prism Agent\Prism Agent.exe` 与 Program Files）、CLI（应用内捆绑 + `~/.prism/bin/prism`、`~/.local/bin/prism`、`prism.exe`）、profile 目录 `~/.prism/profiles/web`；版本读取复用 macos Info.plist 路径。`detect_local_agents_inner` 加入 `detect_prism()`。

### S2.3 会话总线适配器

`adapters/prism.js`：继承 `DshAdapter`，`agentId: "prism-agent"`，descriptor 默认路径 `~/.claw-pet/prism-bridge/capability.json`（env `HACHIMODOCK_PRISM_CAPABILITY_FILE` 可覆盖）。注册点：`agent-session-bus/src/cli.js` 与 `clawd-backend-service/src/headless-mqtt.js`。

### S2.4 Rust 认证与桌面通道

`dsh_auth::load(role)` 参数化 bridge 归属（`dsh` | `prism`），prism 选择 `~/.claw-pet/prism-bridge/capability.json`；`dsh_desktop::status/pair` 与 `dsh_approval` 的流/决策路径携带归属参数。`lib.rs` 增加 prism 侧 `prism_connection_status` / `prism_pair_session` 命令，并在 prism 渠道激活时启动其审批中继。

### S2.5 会话切换

设备上选择会话后，当激活 agent 为 `prism-agent`，桌面端经 bus token 调用桥的 `POST /sessions/activate`（prism 侧新端点）；不改变窗口焦点。接线点在实现时钉在设备会话选择处理（`DeviceDashboard` 的语音会话选择路径及 P4 气泡选择事件）。

### S2.6 文档

`pc/docs/agent-integration-audit.md` 表格加 Prism 行；README「Agent 兼容范围」加 Prism 条目；`integrations/` 加指针说明 prism 使用同一协议与独立 descriptor 目录。

## [S3] 范围

- 范围内：前端选项、Rust 检测、总线适配器、Rust 认证归属参数化、会话切换调用、测试、文档。
- 范围外：prism 侧桥接插件（prism-agent 仓库的独立 feature）、managed-install 向 prism profile 注入、固件改动。

## Tasks

- [ ] T1: `FIXED_AGENT_OPTIONS` 加 prism-agent（依赖：无）
- [ ] T2: Rust `detect_prism()` 与注册（依赖：T1）
- [ ] T3: `adapters/prism.js` 与两处注册（依赖：T1）
- [ ] T4: `dsh_auth` 归属参数化 + prism 命令 + 审批中继（依赖：T3）
- [ ] T5: 设备会话选择 → `POST /sessions/activate`（依赖：T3）
- [ ] T6: 测试（适配器测试镜像 `dsh-adapter.test.js`；检测单测注入 home）（依赖：T2、T3）
- [ ] T7: 文档（依赖：T6）

## [S4] 验收

- [ ] `~/.prism/profiles/web` 存在时 `detect_local_agents` 返回 ready 的 `prism-agent`（注入 home 的单测覆盖）。
- [ ] 适配器以 prism descriptor 探测 `/sessions`、转发 `/inject`（mock 桥测试镜像 DSH 适配器测试）。
- [ ] 激活 agent 为 prism 时设备选择触发 `POST /sessions/activate`（处理函数单测）。
- [ ] 触碰的 Rust `cargo check --lib` 通过；Node `node --test` 通过。
