---
feature: prism-chat-dispatch
status: delivered
updated: 2026-11-18
branch: feat/prism-chat-dispatch
commits: 2ce63a5..02deb86
---

# Prism 对话派发：实时聊天可把任务派给 Prism

## Report

**What was built** — 对话大模型的桌面任务派发新增 Prism（`prism-agent`）适配器，与既有 Codex/WorkBuddy/ZCode 同级：工具 schema、PROMPT、capabilities、跟随目标门控（`supports_default_agent`/`with_agent_selection`）、错误文案重标全部接入。Prism 没有任何回执事件源（无日志监视器、无 Hook），因此采用「作曲器校验发送即终态」语义：`run_dispatch` 对 Prism 跳过 bus 事件 baseline（bus 不可用不阻塞发送），发送确认成功后直接置 `State::AcceptedUntracked`（「已接收 · 待核对」，同时给这个休眠状态接上首个生产者），明确未发送（`WRITE_NOT_CONFIRMED`）沿用共享映射置 `Failed`，仅不确定的发送结果置 `Unknown`；返回空 streamId，调用方据此不启动回执 monitor（baseline 保证其他 agent streamId 非空，不变量封闭）。语音提示如实说明只能确认已接收，完成结果请在 Prism 客户端查看。功能简介（UsageHelp.jsx）补上此前遗漏的 ZCode，并新增 Prism 及其回执限制说明；`desktop-agent-voice.md`、`realtime-chat.md`、`agent-integration-audit.md` 三处过时的「仅 Codex/WorkBuddy」表述同步修正。

**Verification** — `node scripts/run-tests-windows.mjs desktop_agent`（CARGO_TARGET_DIR 独立槽位）55/55 通过（含新增 serde/门控/capabilities/文案区分单测）；`npm test` 1833/1833 通过；`npm run build:web` 通过（JSX 解析+CSP 校验）；rustfmt --check 与 main 基线比对 +3 hunk 全部落在本次编辑区域且符合该文件紧凑 house style（存量 121 hunk 为 PRE-EXISTING，house 规则禁止全文件重排）；cargo check --lib 本机 PRE-EXISTING 失败（ring/MSVC）未触碰。一轮独立评审（APPROVE，零 CRITICAL，4 minor）后修复 3 项：spec 的 Failed/Unknown 措辞澄清、UsageHelp 移除不可验证的「Prism 无排队入口」断言、PROMPT 补「完成结果请在 Prism 客户端查看」；修复后 Rust 与前端套件复跑全绿。

**Journey log** —
- worktree 里跑 Rust 测试要先补齐 gitignored 的运行时资源：从主 checkout 拷 `pc/src-tauri/generated-runtime/`、`pc/dist/`（含 terrier-clips）与 `bridge/packages/clawd-backend-service/node_modules/`（main 侧仅一个 vendored `ws`），否则 build.rs 逐个报 resource 缺失；pc 根 node_modules 同拷（基线一致，锁文件相同）。
- desktop_agent.rs 新单测又踩了两阶段借用（`receipt(&t)["msg"].as_str()` 临时值存活期）——正是语音特性记录过的 93f1b27 同类坑；先绑定再取字段。
- rustfmt 基线比对不能按行号集合做差（插入行会使后续行号整体错位），改比「diff 内容行集合」，新增 hunks 全部落在编辑区域即符合 house style 规则。
- 回执语义的设计取舍：与其让监视器 30 秒超时把每次派发翻成「结果尚未确认」，不如把发送校验（写读回+发送点击）当作完整回执，直接落到休眠的 `AcceptedUntracked`——最小改动且语义诚实；Prism 本地 desktop-server API（127.0.0.1:38081+token）留作后续回执源的独立特性。
- 文档的过时范围比特性清单大：zcode 特性只更新了 audit+README，`desktop-agent-voice.md`/`realtime-chat.md`/UsageHelp 里的「仅 Codex/WorkBuddy」没跟上；本次按「每处按 agent 枚举的表述都要逐点核对」的既有教训一并清理。

## [S1] Problem

对话大模型的桌面任务派发目前只接受 codex/workbuddy/zcode（`desktop_agent.rs` 的 `Agent` 枚举与 `supports_default_agent` 门控）。设备跟随 Prism 时说「把桌面的会议记录整理成文档」，宠物只能提示「当前跟随的 Agent 暂不支持实时对话任务派发」。而 prism-agent 的作曲器发送路径（可见输入框写入+发送校验）已由 prism-agent-codex-parity 完整支持——派发层是唯一缺口。功能简介（UsageHelp.jsx）还停留在「目前支持 ChatGPT（Codex）和 WorkBuddy」，连已交付的 ZCode 也没提。

## [S2] Design

### S2.1 Agent 身份

`desktop_agent.rs` 的 `Agent` 枚举加 `Prism`：serde `#[serde(rename = "prism-agent")]`（覆盖 lowercase 规则，使工具参数 `"prism-agent"` 反序列化通过），`id()` → `"prism-agent"`（与注册表 `KNOWN_USB_STATE_SOURCES`、作曲器进程表、前端 `FIXED_AGENT_OPTIONS` id 一致），`label()` → `"Prism"`。`text()` 重标机制沿用：codex 味文案中的 ChatGPT/Codex 自动替换为 Prism。

### S2.2 参数解析与门控

- `Request.agent: Option<Agent>` 由 serde 自动接受 `"prism-agent"`；未知 id 仍走 `invalid_arguments`。
- `with_agent_selection` 加 `"prism-agent"=>Agent::Prism`（跟随目标来自 `resolve_usb_inject_target`，prism 跟随时返回 `"prism-agent"`）。
- `supports_default_agent` 加 `"prism-agent"`，同时放行两处门控：`dispatch` 入口与 `conversation_receipt_from`。

### S2.3 无回执源的发送确认语义（设计决策，用户未及答复，按推荐项执行）

Prism 没有任何回执事件源（无日志监视器、无状态 Hook），desktop_agent 的 monitor 轮询只会 30 秒超时翻 Unknown。作曲器发送路径本身有写读回校验+发送点击校验，因此：

- `run_dispatch` 对 `Agent::Prism` 走无回执分支：跳过 bus baseline（prism 不需要事件流，bus 不可用不阻塞发送），发送经作曲器确认成功后直接置 `State::AcceptedUntracked`（给这个休眠状态接上生产者）；明确未发出的 `DESKTOP_TASK_WRITE_NOT_CONFIRMED` 沿用既有共享错误映射置 `Failed`（语义更准：确未发出），仅真正不确定的发送结果（`Err(State::Unknown)` 桶，含提交未确认与 worker panic）置 `State::Unknown`；返回空 streamId。（评审 Finding 1 澄清）
- 调用方以空 streamId 判定不启动 monitor（baseline 保证非空，空 streamId 只可能来自 prism 分支），避免 monitor 30 秒后把 AcceptedUntracked 翻成 Unknown。
- 语音语义与 WorkBuddy 旧版同类：能确认「已收到」（发送已验证），不能确认完成。取消仍只在 Preparing 阶段有效。

### S2.4 文案

- `receipt()` 的 `State::AcceptedUntracked` 文案按 agent 区分：Prism → 「Prism 已收到任务，但完成结果暂时无法核对，请在 Prism 客户端查看；不会重复发送。」WorkBuddy 文案保持不变。
- 工具 schema：agent 枚举加 `"prism-agent"`，描述提及 Prism。
- `capabilities()`：adapters 加 prism 条目（`target: current_desktop_conversation`，completionReceipts 注明不提供轮次回执），limitations 同步。
- `PROMPT`：适配器清单加 Prism（prism-agent）；说明 Prism 派发只确认已接收，完成结果在 Prism 客户端查看；跟随/指定其他未开放 Agent 的限制说明保持。

### S2.5 前端与文档

- `pc/src/UsageHelp.jsx` 简介段落更新：派发支持 ChatGPT（Codex）、WorkBuddy、ZCode；Prism 可派发但只能确认已接收；其余限制说明保留。
- `pc/docs/agent-integration-audit.md` Prism 行补对话派发说明；`README.md`/`README.en.md` 若枚举派发支持则同步（核对后按实际能力描述，不夸大）。

### S2.6 测试策略

- Rust 单测（desktop_agent `mod tests`）：`"prism-agent"` 反序列化到 `Agent::Prism`；`with_agent_selection("prism-agent")` + `supports_default_agent()` 为真；`capabilities()` JSON 含 prism 条目且 limitations 更新；AcceptedUntracked 文案按 agent 区分。
- 前端：`npm test` 全绿（基线 1833）；JSX 改动跑 `npm run build:web` 解析校验。
- Rust 格式：触碰文件 `rustfmt --check` 干净（house style 文件只做目标化编辑）。

## [S3] Scope

- 范围内：desktop_agent.rs 派发接线与无回执发送确认语义、Rust 单测、UsageHelp 简介、audit/README 核对更新。
- 范围外：Prism 回执事件源建设（本地 desktop-server API 调研，后续独立特性）、zcode 行为变更、macOS prism 实机验收、审批中继（与 Codex 同级不中继）、固件改动。

## Tasks

- [x] T1: desktop_agent.rs 接线：enum/serde/id/label、with_agent_selection、supports_default_agent、run_dispatch 无回执分支、receipt 文案、schema/capabilities/PROMPT (depends: none)
- [x] T2: Rust 单测：反序列化、门控、capabilities、文案区分 (depends: T1)
- [x] T3: UsageHelp.jsx 简介更新 + 前端派发名单核对（current-desktop-task / DeviceDashboard / session-display） (depends: none)
- [x] T4: audit 表 + README 核对更新 (depends: T1)
- [x] T5: 验证与 spec 定稿 (depends: T1-T4)

## [S4] Acceptance

- [x] `"prism-agent"` 作为工具 agent 参数与跟随目标均可进入派发（serde 反序列化 + with_agent_selection + supports_default_agent 单测证明）。
- [x] capabilities() 返回 prism 条目，limitations 不再声称「只有 Codex、WorkBuddy、ZCode 是派发适配器」。
- [x] 发送成功后状态为 accepted_untracked 且不启动回执 monitor；明确未发送（WRITE_NOT_CONFIRMED）为 failed，仅不确定的发送结果为 unknown（run_dispatch 分支以代码审查核实——评审已逐点核过 Cancel 竞态与通知单次语义）。
- [x] AcceptedUntracked 语音文案按 agent 区分（WorkBuddy 原文不变）。
- [x] UsageHelp 简介含 ZCode 与 Prism，且如实描述 Prism 回执限制；npm test 全绿。
- [x] rustfmt --check 增量与 main 基线比对：+3 hunk 全部落在本次编辑区域、符合该文件 house style（存量 121 hunk PRE-EXISTING，未做全文件重排）；Rust desktop_agent 单测全绿。
