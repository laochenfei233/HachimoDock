---
feature: prism-agent-support
status: delivered
updated: 2026-11-12
branch: feat/prism-agent-support
commits: 361cb0e..571258a
---

# Prism agent 选项：检测、桥接适配与会话切换

## Report

**交付内容** — prism-agent 成为可选择的 agent 通道：前端 `FIXED_AGENT_OPTIONS` 加 `prism-agent`（排 DeepSeek 之后）；Rust `detect_prism*` 镜像 `detect_dsh*`（应用包、`Contents/Resources/runtime/prism/lib/bin.js` 捆绑 CLI、`~/.prism/bin/prism`、profile `~/.prism/profiles/web`），classify 抽出带 label 的公共实现且 DeepSeek 行为逐字不变；`adapters/prism.js` 继承 DshAdapter（dsh.js 新增 label/capabilityFile/agentId/acl 选项，默认值保持 DSH 行为），注册进 agent-session-bus `cli.js` 与 headless-mqtt；`dsh_auth.rs` 以 `Bridge` 枚举参数化（`Dsh` | `Prism` 各读各的 descriptor，post 白名单加 `/sessions/activate`）；两个审批中继各自绑定自己的 descriptor（事件流撤销监视器按归属读取——评审修复）；设备会话气泡切换经 `switchableDesktopSession`/`emitActivatedSession`（纯函数单测）调 `prism_activate_session` 命令，POST 桥的 `/sessions/activate`，不抢窗口焦点。交付时省略 prism 的 pair/connection 命令（语音走通用 OS composer；S2.4 已记录）。

**验证** — node --test 八个套件（prism-adapter、server、codex-adapter、agent-appearance-config、useDeviceVoiceRouter、useP4SessionSync、agent-voice-capabilities、agent-switch-responsiveness）112 测试 0 失败；`rustfmt --check` 触碰的 Rust 代码解析干净（既有风格差异除外）；`cargo check --lib` 在本机 PRE-EXISTING 失败（ring 0.17.14 vs MSVC 14.50，未改动的 main 同样失败），无法在本机编译 Rust。一轮评审（REQUEST_CHANGES：中继监视器读错 descriptor、捆绑 CLI 路径指向目录、缺切换处理单测）全部修复后复审通过。

**Journey log** —
- 共享的传输/审批 Rust 模块参数化 descriptor 归属时，每一处内部重读（尤其是事件流里的撤销监视器）都必须带归属——漏一处就是"prism 中继拿 DSH descriptor 自撤销"这种只在运行时现形的错。
- 上游 dsh-adapter.test.js 的 Windows ACL 路径在 macOS 上标 NOT_RUN；本机 PowerShell create-directory 阶段真实失败，prism 适配器测试通过注入 acl 替身（复现其文件系统副作用）保持可跑。
- 桌面端复用 DSH 线协议的钥匙是把 DshAdapter 的身份三要素（agentId/label/capabilityFile）参数化而不是复制 456 行。

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

`dsh_auth::load(role)` 参数化 bridge 归属（`Dsh` | `Prism`），prism 选择 `~/.claw-pet/prism-bridge/capability.json`；`dsh_approval::start` 与其事件流/撤销监视器携带归属参数（prism 中继只读 prism descriptor）。交付时省略 `prism_connection_status` / `prism_pair_session` 与 `dsh_desktop::status/pair` 的归属参数化：prism 桌面语音走通用 OS composer 路径（`allowedOrigins` 保持为空、无浏览器语音消费者），legacy pair 流程不接线；连接状态由探测 `/sessions` 的总线适配器承载。审批中继无条件启动，但自门控于 descriptor 存在与 USB 连接。

### S2.5 会话切换

设备上选择会话后，当激活 agent 为 `prism-agent`，桌面端经 bus token 调用桥的 `POST /sessions/activate`（prism 侧新端点）；不改变窗口焦点。接线点在实现时钉在设备会话选择处理（`DeviceDashboard` 的语音会话选择路径及 P4 气泡选择事件）。

### S2.6 文档

`pc/docs/agent-integration-audit.md` 表格加 Prism 行；README「Agent 兼容范围」加 Prism 条目；`integrations/` 加指针说明 prism 使用同一协议与独立 descriptor 目录。

## [S3] 范围

- 范围内：前端选项、Rust 检测、总线适配器、Rust 认证归属参数化、会话切换调用、测试、文档。
- 范围外：prism 侧桥接插件（prism-agent 仓库的独立 feature）、managed-install 向 prism profile 注入、固件改动。

## Tasks

- [x] T1: `FIXED_AGENT_OPTIONS` 加 prism-agent（依赖：无）
- [x] T2: Rust `detect_prism()` 与注册（依赖：T1）
- [x] T3: `adapters/prism.js` 与两处注册（依赖：T1）
- [x] T4: `dsh_auth` 归属参数化 + 审批中继（`prism_activate_session` 切换命令在 S2.5）（依赖：T3）
- [x] T5: 设备会话选择 → `POST /sessions/activate`（依赖：T3）
- [x] T6: 测试（适配器测试镜像 `dsh-adapter.test.js`；检测单测注入 home）（依赖：T2、T3）
- [x] T7: 文档（依赖：T6）

## [S4] 验收

- [ ] `~/.prism/profiles/web` 存在时 `detect_local_agents` 返回 ready 的 `prism-agent`（注入 home 的单测覆盖）。
- [ ] 适配器以 prism descriptor 探测 `/sessions`、转发 `/inject`（mock 桥测试镜像 DSH 适配器测试）。
- [ ] 激活 agent 为 prism 时设备选择触发 `POST /sessions/activate`（处理函数单测）。
- [ ] 触碰的 Rust `cargo check --lib` 通过；Node `node --test` 通过。
