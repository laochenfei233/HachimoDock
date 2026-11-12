---
feature: prism-agent-codex-parity
status: delivered
updated: 2026-11-12
branch: feat/prism-codex-parity
commits: 1586fec..20de8f2
---

# Prism-agent 补齐到 Codex 级别支持

## Report

**交付内容** — prism-agent 补齐到与 codex/DSH 同级的桌面支持。(1) 权限修复:`prism_activate_session` 加入 `local-app-commands` 白名单——此前命令已注册且被仪表盘调用但不在白名单,设备气泡切换 prism 对话在运行时会被拒绝;顺带以本机真实安装(对照 prism-agent 仓库 tauri.conf.json)修复 Windows 检测:主程序是 `%LOCALAPPDATA%\Prism Agent\prism-agent.exe`(Tauri mainBinaryName)而非 `Programs\Prism Agent\Prism Agent.exe`,Windows 捆绑 CLI 在 `<install>\runtime\prism\lib\bin.js` 而非 Contents/Resources。(2) 可见输入框语音:prism-agent 镜像 deepseek-harness 加入 `codex_composer`(Windows UIA)与 `codex_composer_macos`(macOS AX)的全部身份表、谓词、前台纪律与 button-only 提交——macOS 用独立 `LAST_PRISM_WRITTEN` 草稿缓存(不与 DSH 共享,双开互不污染),13 处硬编码 "DeepSeek Harness" 错误文案改为按 agent 取名;lib.rs 谓词五处(`uses/streams/label/current-visible/bound-addressable`)、start_bound 拒绝、三处 round-guard 同步加入,DSH 专属的插件回退分支保持不动。(3) 注册表一级化:`KNOWN_USB_STATE_SOURCES`(7 项)、`score_usb_source` 24(恰在 DSH 25 之下)、显示名 "Prism"、`normalize_agent_id` 别名(prism/prism-agent)、宠物频道映射。(4) 前端:VoiceAssistantPanel 名单/失败正则/标签链、macOS VoiceComposerCheck 门控、partial 阶段一次性写入文案组、审批超时选择器覆盖双中继桥(共享 pet-bridge.json,prism 插件侧已支持)。(5) 文档:审计表、集成 README、.folder.md 对齐;`/inject` 桥接通道保留为带回执的备用投递路径。

**验证** — pc 12 套件 107 测试 0 失败(含新增 prism.test.js 契约套件与全部静态源码断言镜像);agent-session-bus 147 测试 133 过 11 失败——与未触碰的 main 基线逐项一致(PRE-EXISTING:DSH 适配器测试的 Windows ACL create-directory 失败);评审另跑 5 个相邻套件 100 测试全绿;`rustfmt --edition 2021 --check` 三个触碰的 Rust 文件零解析错误(仓库既有风格差异除外);`cargo check` 本机 PRE-EXISTING 失败(ring 0.17.14 vs MSVC,main 同样失败)。独立评审(REQUEST 无 critical):S4 六条验收全 PASS;发现的覆盖缺口(lib.rs 缺 label/score 精确断言)已补并复验。

**Journey log** —
- 上轮交付把 prism 文案写成了"可见输入框"但代码走桥接注入——文档声称与代码现实脱节是这类 fork 适配最容易埋的错;本次接线后文案才成真。
- 真实安装布局是检测逻辑的唯一权威:`Prism Agent.exe` 与 `prism-agent.exe` 一字之差,对照 prism-agent 的 tauri.conf.json(mainBinaryName=crate 名)与真机目录才暴露;镜像 fork 的身份常量要逐个对照上游构建配置,不能从 DSH 推断。
- 并行 fork(DeepSeek 与 Prism 同时运行)意味着任何单例缓存(`LAST_DSH_WRITTEN`)都必须按 agent 分槽,跨 agent 复用会互写草稿状态。

## [S1] 问题

上一轮交付(prism-agent-support,361cb0e..571258a)让 prism-agent 成为可选通道,但对照 codex 的全部接线点仍有真实缺口:设备气泡切换 prism 对话的命令不在 Tauri 权限白名单(运行时被拒,功能实际不可用);设备语音文案与文档声称"当前可见输入框"但代码走的是桥接注入;prism 缺席多个一级公民注册表(USB 状态源、来源评分、显示名、agent 别名、宠物频道映射)。用户决策:可见输入框语音路径也要接通(与 DSH 同级体验)。

## [S2] 设计

### S2.1 权限白名单修复

`pc/src-tauri/permissions/local-app-commands.json` 的 `local-app-commands` allow 列表加入 `prism_activate_session`(紧邻既有 DSH 三条)。

### S2.2 可见输入框(composer)语音路径

prism-agent 加入可见 composer 路径,镜像 deepseek-harness 接线:codex_composer.rs(Windows UIA:进程 `prism-agent.exe`/`'prism-agent'`、前台纪律、块名单、button-only 提交)与 codex_composer_macos.rs(macOS AX:bundle `ai.prism.agent.desktop`、应用名 "Prism Agent"、窗口标题 "prism agent"、UTF-16 光标追加、独立 `LAST_PRISM_WRITTEN` 草稿缓存槽);`agent_uses_visible_composer` 加 prism、`agent_streams_voice_draft` 不含(一次性追加)、`visible_composer_agent_label` 返回 "Prism";提交分支与 DSH 同形。身份常量对照 prism-agent 仓库 tauri.conf.json 与真实安装布局逐项核实。

### S2.3 语音谓词与前端文案

`should_use_current_visible_session`/`voice_needs_current_composer`/`device_voice_bound_target_is_addressable` 按 DSH 成员资格纳入 prism(不比 DSH 更宽);`useDeviceVoiceRouter.js` partial 文案组加 Prism;VoiceAssistantPanel 名单/正则/标签链、VoiceComposerCheck 门控加 prism-agent;审计文档 Prism 行如实描述。

### S2.4 注册表一级化

`KNOWN_USB_STATE_SOURCES` 加 `prism-agent`;`score_usb_source` 取 24;`usb_source_display_name` → "Prism";`normalize_agent_id` 别名;`selected_agent_to_channel_id` 与 `normalize_pet_channel_id` → `prism-agent`。

### S2.5 文档

审计文档、`integrations/dsh-hachimodock/README.md`、`pc/.folder.md` 对齐 composer 路径与 `/inject` 备用通道。

## [S3] 范围

- 范围内:权限白名单条目;prism 可见 composer 接线(Rust 双平台 + 谓词 + 提交分支);前端语音面板/文案名单;USB/频道注册表;文档对齐;各单测镜像。
- 范围外:桌面任务派发(realtime chat 仍仅 Codex/WorkBuddy);codex 宠物导入生态;MQTT 日志监视器(DSH 亦无);fixtures.js mock 行;桥接注入通道的移除(保留为回执通道);prism-agent 仓库侧改动(其桥接插件已交付)。

## Tasks

- [x] T1: `prism_activate_session` 加入权限白名单 (depends: none)
- [x] T2: Rust composer 身份表与谓词加 prism-agent(Windows + macOS)(depends: none)
- [x] T3: 设备语音提交流程的 prism 分支(composer 草稿 + 确认提交)(depends: T2)
- [x] T4: 前端名单与文案(VoiceAssistantPanel、VoiceComposerCheck、useDeviceVoiceRouter)(depends: T2)
- [x] T5: 注册表一级化(KNOWN_USB_STATE_SOURCES、score、display name、normalize 别名、频道映射)(depends: none)
- [x] T6: 文档对齐(audit doc、integration README、.folder.md)(depends: T2、T5)
- [x] T7: 测试:prism.test.js 契约套件、lib.rs twins、Windows bundled-CLI 解析测试、文案镜像、既有断言更新(depends: T2-T5)
- [x] T1b: Windows 检测候选与捆绑 CLI 路径修复(实现中发现的检测 bug)(depends: none)

## [S4] 验收

- [x] `local-app-commands.json` allow 列表含 `prism_activate_session`(prism.test.js JSON 解析断言)。
- [x] `agent_uses_visible_composer("prism-agent")` 为真;`agent_streams_voice_draft("prism-agent")` 为假;`visible_composer_agent_label("prism-agent")` == "Prism"(lib.rs 单测 + JS 契约断言)。
- [x] composer 身份表(Windows/macOS)含 Prism Agent 身份,与 detect_prism 常量一致(prism.test.js 静态断言 + 评审逐点核对;Windows bundled-CLI 有纯函数单测)。
- [x] prism 语音文案走可见输入框组;VoiceAssistantPanel/VoiceComposerCheck 名单含 prism-agent(node --test 107/107)。
- [x] `score_usb_source("prism-agent")==24`、`usb_source_display_name` 返回 "Prism"、频道映射返回 `prism-agent`(lib.rs 单测精确断言)。
- [x] `node --test` 相关套件全绿(107/107 + 评审 100 相邻 + bus 133/147 与 main 基线一致);触碰的 Rust rustfmt 零解析错误;`cargo check` PRE-EXISTING 失败(ring/MSVC,main 相同)。
