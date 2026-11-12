---
feature: zcode-agent-support
status: designed
updated: 2026-11-12
branch: feat/zcode-agent-support
commits: 1586fec..
---

# ZCode 渠道:检测、状态跟随与桌面输入框语音

## Report

(delivery 时填写)

## [S1] 问题

HachimoDock 已适配 ChatGPT(Codex)、Claude、OpenClaw、MiMoCode、DeepSeek Harness、Prism 与 WorkBuddy,但不检测也不跟随 ZCode(ZCode 桌面 App + 其本地 CLI 运行时,Electron 外壳,数据在 `~/.zcode/`)。ZCode 用户无法把状态放到设备气泡,也无法用设备按键向 ZCode 口述草稿。

## [S2] 设计

### S2.1 Agent 选项

`pc/src/lib/agent-appearance-config.js` 的 `FIXED_AGENT_OPTIONS` 追加 `{ id: "zcode", label: "ZCode", detail: "ZCode 桌面渠道:状态跟随与当前可见输入框语音" }`,排在 `workbuddy` 之后(顺序断言同步更新)。派生函数由该表驱动,无需单独改动。

### S2.2 本地检测(Rust)

`lib.rs` 增加 `detect_zcode()`,镜像 `detect_prism()` 的 classify 模式(带 label 的公共分类器):

- 应用候选:Windows `%LOCALAPPDATA%\Programs\ZCode\ZCode.exe` 与 `C:\Program Files\ZCode\ZCode.exe`;macOS `/Applications/ZCode.app`。
- CLI:应用内捆绑 `resources/glm/zcode.cjs`(相对应用安装目录);无独立安装布局约定,不做 PATH 猜测。
- 活动数据:`~/.zcode/cli/db/db.sqlite` 存在即视为有会话数据;`~/.zcode/cli/log` 目录存在即视为有日志。`can_sync_hook: false`。
- 注册进 `detect_local_agents_inner`;`normalize_agent_id` 无需别名(`zcode` 本身即规范 id,未知 id 已按小写透传)。

### S2.3 Rust 能力谓词

`agent_uses_visible_composer` 加入 `zcode`;`agent_streams_voice_draft` 加入 `zcode`(与 Codex 同级:草稿增量可见,依赖既有 UIA/AX 读回校验);`visible_composer_agent_label` → "ZCode";`should_locate_desktop_session` **不含** `zcode`(S2.5);`device_voice_platform_block_reason` 无 zcode 分支(双平台);Rust `KNOWN_USB_STATE_SOURCES`(lib.rs)与桥侧 `KNOWN_AGENT_SOURCES`(headless-mqtt.js)各加入 `"zcode"`。

### S2.4 状态监控(桥侧日志监控器)

新增 `bridge/agents/zcode.js`(默认值与事件映射)与 `bridge/agents/zcode-log-monitor.js`,接线进 `headless-mqtt.js` 的 `startZCodeMonitor`,与 Codex 监控同开关策略(同一 `CLAWD_ENABLE_*` 配置面)。

- 数据源:`~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` 结构化日志(当天 + 跨天回退看昨天;字节偏移增量读,容忍滚动/截断)。已在本机实查:事件含 `turn.started/turn.completed/turn.failed`、`tool.call.started/completed/failed`、`model.request.started/completed/failed`、`ttft.model.first_content`,每行带 `sessionId`/`turnId`/`context`。
- 过滤:`sessionId` 以 `sess_subagent` 开头的会话不进入主状态(子代理噪音不冒充主会话);其余视为桌面/CLI 主会话。
- 事件映射:`turn.started`→thinking;`tool.call.started`→working;`ttft.model.first_content`→speaking;`turn.completed`→attention;`turn.failed`/`model.request.failed`→error;`model.request.started`→thinking(兜底长思考)。状态回落(idle)按既有 monitor 的超时策略。
- 回执关联:ZCode 日志不含用户文本。`turn.started` 时以只读 WAL 连接查询 `~/.zcode/cli/db/db.sqlite` 的 `input_history`(按 `session_id` + `time_created` 取最新一条),SHA-256 得 64 位十六进制 `taskCorrelation.userHash`;日志 `context.inputLength` 仅作诊断告警,不参与判定。任何 sqlite 错误都降级为无回执关联,不影响状态跟随。
- 会话标题:同一连接查询 `session` 表(`id/title/directory/time_updated`,LIMIT 有界),供状态 payload 与会话列表。
- 输出与 Codex monitor 同形:经 `metricsTracker.apply()` 与 `publisher.publishSource()`,写入 `%TEMP%\pet-manager-bridge-state\zcode.json`。已知缺口如实记录:ZCode 日志不含助手正文与 token 用量,因此**无语音预览气泡、无 token 统计**,缺失信息不伪装完整回复。

### S2.5 会话列表与切换边界

- 总线适配器 `agent-session-bus/src/adapters/zcode.js`:仿 `workbuddy.js` 的最小形态。`isAvailable()` 按安装检测;`listSessions()` 只读查询 `db.sqlite` `session` 表(有界、异常降级 `[]`——`session` 是 CLI 自有持久层,与 codex-paths 读 Codex 自有 sqlite 同构,不属于 WorkBuddy 注释里"私有桌面鉴权库"的禁域);`inject()` 恒回 `AGENT_INPUT_UNSUPPORTED`(语音走可见输入框,不支持后台注入,不转发其他 Agent);`openNew()` 抛"请在 ZCode 中新建会话"。注册:`src/index.js`、`src/cli.js`、`headless-mqtt.js` 适配器数组。
- 设备气泡选择对 `zcode` 只改跟随目标,**不切换 ZCode 桌面对话**:`should_locate_desktop_session` 不含 zcode;`switchableDesktopSession` 不含 zcode;不新增 Tauri 切换命令。依据:ZCode 注册了 `zcode://` URL 协议,但语义在本机不可验证(可能是登录回调),盲发违背"结果未知即停止"的产品原则;验证后可在后续版本启用定位。

### S2.6 语音作曲器(Windows 实机验证,macOS 标注未验收)

- Windows(`codex_composer.rs` 内嵌 PowerShell):`is_agent_frontmost` 进程名表加 `zcode.exe`;通用 current-visible 目标(WorkBuddy 式目标发现)按 agent 进程名映射加 `zcode → @('ZCode')`;同文件其余 agent 名过滤/排除点同步补齐;`start_current_task_for` / `start_current` / `start_current_retained` / `start_with_purpose_retained` 分派加 `zcode`;启动超时文案映射加 "ZCode"。ZCode 桌面 App 为 Electron(Chromium AX),复用既有 Chromium AX priming + UIA 读回机制。
- macOS(`codex_composer_macos.rs`):`MacosAgent` 加 `Zcode`;`agent_application_names` 加 "ZCode";**不虚构 bundle identifier**,仅按应用名匹配;`diagnose_current_composer` 分派加 `zcode`;权限引导复用现有辅助功能流程。审计文档标注 macOS 语音路径未实机验收。

### S2.7 desktop_agent 派发工具

`desktop_agent.rs`:`Agent` 枚举加 `Zcode`(`"zcode"` / "ZCode");工具 schema 的 agent 枚举加 `"zcode"`;`capabilities()` 加 zcode 条目(`automaticPermissionApproval: false`,与 Codex 同:不中继审批、未知不代批);`apply_event` 按 S2.4 规范化事件名接入回执状态机;`PROMPT` 文案提及 ZCode;派发路径复用 `CodexComposerBridge::start_current_task_for`。回执匹配沿用 SHA-256 文本哈希 + 单会话歧义拒收语义。

### S2.8 前端接线

`agent-appearance-config.js`(+测试的顺序/数量断言 7→8);`useDeviceVoiceRouter.js` `transcriptMessage` 加 `zcode → "ZCode"` 标签与按住说话提示名单;`VoiceAssistantPanel.jsx` 作曲器文案名单加 zcode;`agent-voice-capabilities.js` 加 zcode 运输就绪逻辑;`useP4SessionSync.js`:zcode 走 WorkBuddy/DeepSeek 同路径(绑定目标为当前可见输入框,无 locate 确认流、无桌面切换)。`pc/src/lib/session-display.js` 如需状态文案映射则补齐。

### S2.9 文档

`pc/docs/agent-integration-audit.md` 表格加 ZCode 行(状态与气泡、按键语音路径、说明含"不切换其桌面对话"与"macOS 未实机验收");`README.md` / `README.en.md`「Agent 兼容范围」加 ZCode。

### S2.10 测试策略

- 监控器:`node:test` 单测覆盖事件映射、`sess_subagent` 过滤、跨天文件回退、userHash 关联(mkdtemp 临时 sqlite fixture + 假日志流)。
- 适配器:镜像 `workbuddy` 最小套件(isAvailable、listSessions sqlite fixture、inject 拒绝)。
- 前端:`agent-appearance-config.test.js` 更新;`useDeviceVoiceRouter` / `useP4SessionSync` / `agent-voice-capabilities` 既有套件保持全绿并补 zcode 断言。
- Rust:`lib.rs` `mod tests` 注入 home 的 classify 单测;触碰的 Rust 文件 `rustfmt --check` 解析干净;`cargo check --lib` 在本机为 PRE-EXISTING 失败(ring 0.17.14 vs MSVC 14.50,未改动代码同样失败)时如实记录。

## [S3] 范围

- 范围内:前端选项、Rust 检测与谓词、Windows/macOS 作曲器接入、桥侧日志监控器、总线适配器、desktop_agent 派发、前端接线、测试、文档。
- 范围外:`zcode://` 深链会话定位(语义未验证)、ZCode CLI 后台注入模式(未验证,语音走可见输入框)、审批中继(与 Codex 同级:不中继)、pet 导入(Codex 专属)、固件改动、prism/DSH 通道行为变更。

## Tasks

- [ ] T1: Rust `detect_zcode()` + classify + 注册 + 单测(依赖:无)
- [ ] T2: Rust 能力谓词与两处 KNOWN_SOURCES(依赖:无)
- [ ] T3: Windows 作曲器接入 zcode(依赖:无)
- [ ] T4: macOS 作曲器接入 zcode(依赖:无)
- [ ] T5: `zcode-log-monitor.js` + headless 接线 + 单测(依赖:无)
- [ ] T6: `adapters/zcode.js` + 注册 + 适配器测试(依赖:T5 同文件避让)
- [ ] T7: `desktop_agent.rs` 派发接入(依赖:T3、T5 事件契约)
- [ ] T8: 前端接线 + 测试(依赖:T1)
- [ ] T9: 文档(audit + 双语 README)(依赖:T1-T8)
- [ ] T10: 验证与 spec 定稿(依赖:T9)

## [S4] 验收

- [ ] `~/.zcode/cli/db/db.sqlite` 存在时 `detect_local_agents` 返回 ready 的 `zcode`(注入 home 单测;缺席时 detected:false)。
- [ ] 监控器单测:`turn.*`/`tool.call.*`/`ttft.model.first_content` 映射正确;`sess_subagent` 不产生状态;userHash 与 `input_history` fixture 一致且 sqlite 故障时降级不抛错。
- [ ] 适配器测试:缺失 sqlite 时 `ready` 降级为未安装、`listSessions` 有界返回、`inject` 回 `AGENT_INPUT_UNSUPPORTED`。
- [ ] `FIXED_AGENT_OPTIONS` 含 8 个渠道且 zcode 在 workbuddy 之后(顺序断言更新)。
- [ ] 语音链路接线点齐全:谓词、frontmost 进程表、current-visible 目标映射、分派白名单、前端文案与能力表均有 zcode 条目(以 diff 逐点核对)。
- [ ] `npm test` 与 `npm run test:bridge` 全绿;触碰 Rust 文件 `rustfmt --check` 干净;`cargo check --lib` 结果如实记录(PRE-EXISTING 需注明)。
- [ ] audit 表与双语 README 含 ZCode 行,与实际能力一致(不夸大:无语音预览、无 token 统计、无桌面切换)。
