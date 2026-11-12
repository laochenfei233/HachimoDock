---
feature: prism-agent-codex-parity
status: in-progress
updated: 2026-11-12
branch: feat/prism-codex-parity
commits: 1586fec..(delivery)
---

# Prism-agent 补齐到 Codex 级别支持

## Report

（交付时填写）

## [S1] 问题

上一轮交付（prism-agent-support，361cb0e..571258a）让 prism-agent 成为可选通道，但对照 codex 的全部接线点仍有真实缺口：设备气泡切换 prism 对话的命令不在 Tauri 权限白名单（运行时被拒，功能实际不可用）；设备语音文案与文档声称"当前可见输入框"但代码走的是桥接注入；prism 缺席多个一级公民注册表（USB 状态源、来源评分、显示名、agent 别名、宠物频道映射）。用户决策：可见输入框语音路径也要接通（与 DSH 同级体验）。

## [S2] 设计

### S2.1 权限白名单修复

`pc/src-tauri/permissions/local-app-commands.json` 的 `local-app-commands` allow 列表加入 `prism_activate_session`（紧邻既有 `dsh_connection_status`/`connect_dsh_desktop`/`dsh_pair_session` 三条）。该命令已在 `lib.rs` 注册并从 `DeviceDashboard.jsx` 调用，缺失即运行时拒绝。

### S2.2 可见输入框（composer）语音路径

prism-agent 加入可见 composer 路径，镜像 deepseek-harness 的接线（身份常量 + 谓词成员 + composer 桥身份表 + 提交分支）。具体接线点在实现时按探索报告钉住：codex_composer.rs（Windows UIA）与 codex_composer_macos.rs（macOS AX）的 agent 身份表加 Prism Agent（bundle id `ai.prism.agent.desktop`、进程 `Prism Agent.exe`）；`agent_uses_visible_composer` 加 `prism-agent`；`agent_streams_voice_draft` 不含 prism（与 DSH 同为一次性追加）；`visible_composer_agent_label` 返回 "Prism"；提交分支镜像 DSH 的 composer 草稿写入 + 确认键提交流程。

### S2.3 语音谓词与前端文案

- `should_use_current_visible_session`、`voice_needs_current_composer`、`device_voice_bound_target_is_addressable`：按 DSH 的成员资格处理 prism（实现时逐条核对语义后定成员，原则是不比 DSH 更宽）。
- `useDeviceVoiceRouter.js` `transcriptMessage`：prism 归入可见输入框组（接线后原文案成真）；`VoiceAssistantPanel.jsx` `isVisibleDesktopAgent` 与 macOS 辅助权限 UI 的 agent 名单加 prism-agent；`VoiceComposerCheck.jsx` 名单同步。
- 审计文档 `pc/docs/agent-integration-audit.md` Prism 行的语音路径描述在接线后即为"当前可见输入框"，补充说明桥接注入仍作为回执通道保留（bus inject 路径不删除）。

### S2.4 注册表一级化

- `lib.rs` `KNOWN_USB_STATE_SOURCES` 加 `prism-agent`。
- `score_usb_source`：`prism-agent` 低于 `deepseek-harness`(25)、高于 openclaw(10)，取 24。
- `usb_source_display_name`：`prism-agent`（含别名）→ "Prism"。
- `normalize_agent_id`：`prism` | `prism-agent` → `prism-agent`。
- `selected_agent_to_channel_id` 与 `normalize_pet_channel_id`：`prism-agent`（含别名）→ `prism-agent`。

### S2.5 文档

`pc/docs/agent-integration-audit.md` Prism 行核对更新；`pc/.folder.md` 若描述 DSH composer 路径的段落适用于 prism 则补一句。

## [S3] 范围

- 范围内：权限白名单条目；prism 可见 composer 接线（Rust 双平台 + 谓词 + 提交分支）；前端语音面板/文案名单；USB/频道注册表；文档对齐；各单测镜像。
- 范围外：桌面任务派发（realtime chat 仍仅 Codex/WorkBuddy，属设计约束）；codex 宠物导入生态（agent 无关）；MQTT 日志监视器（DSH 亦无，prism 状态走总线）；fixtures.js mock 行（无用户可见效果，有断言风险）；桥接注入通道的移除（保留为回执通道）；prism-agent 仓库侧改动（其桥接插件已交付）。

## Tasks

- [ ] T1: `prism_activate_session` 加入权限白名单 (depends: none)
- [ ] T2: Rust composer 身份表与谓词加 prism-agent（Windows + macOS）(depends: none)
- [ ] T3: 设备语音提交流程的 prism 分支（composer 草稿 + 确认提交）(depends: T2)
- [ ] T4: 前端名单与文案（VoiceAssistantPanel、VoiceComposerCheck、useDeviceVoiceRouter）(depends: T2)
- [ ] T5: 注册表一级化（KNOWN_USB_STATE_SOURCES、score、display name、normalize 别名、频道映射）(depends: none)
- [ ] T6: 文档对齐（audit doc、.folder.md）(depends: T2、T5)
- [ ] T7: 测试：谓词单测、文案单测镜像、权限文件断言 (depends: T2-T5)

## [S4] 验收

- [ ] `local-app-commands.json` allow 列表含 `prism_activate_session`（文件断言测试）。
- [ ] `agent_uses_visible_composer("prism-agent")` 为真；`agent_streams_voice_draft("prism-agent")` 为假；`visible_composer_agent_label("prism-agent")` == "Prism"（lib.rs 单测）。
- [ ] composer 身份表（Windows/macOS）含 Prism Agent 身份，与 detect_prism 常量一致（代码审查 + 单测覆盖可纯测部分）。
- [ ] prism 语音文案走可见输入框组；VoiceAssistantPanel/VoiceComposerCheck 名单含 prism-agent（node --test）。
- [ ] `score_usb_source("prism-agent")==24`、`usb_source_display_name` 返回 "Prism"、频道映射返回 `prism-agent`（lib.rs 单测）。
- [ ] `node --test` 相关套件全绿；触碰的 Rust `cargo check` 通过（本机 ring/MSVC 已知失败则记录 PRE-EXISTING 并以语法级检查替代）。
