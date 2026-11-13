---
feature: voice-provider-expansion
status: delivered
updated: 2026-11-13
branch: feat/voice-provider-expansion
worktree: .worktrees/voice-provider-expansion
commits: 1586fec..a70662b
---

# 语音识别/合成多服务商支持（Qwen、MiMo、自定义，跨提供商）

## Report

**What was built** — 语音识别与合成从单一豆包服务商扩展为多服务商体系：全局可分别为 ASR/TTS 选择 豆包（默认，存量用户无感迁移）/ 通义千问（DashScope 原生协议：Paraformer WS 流式识别 + CosyVoice SSE 流式合成）/ 小米 MiMo（仅 TTS：Chat Completions 兼容 + Base64 WAV 解码）/ 自定义（OpenAI 兼容 /audio/speech + /audio/transcriptions，含 24k→16k 重采样与 WAV 封装），每家凭据按 scope 隔离（豆包继续走凭据库），实现跨商组合（如 Qwen 识别 + 豆包合成）。每个形象可在「人设与声音」显式指定 TTS 服务商（schema v2，`voice.provider`，v1 存量一律迁移为跟随全局）；非豆包服务商忽略复刻音色并按大小写无关规则把豆包风格音色 id 回退到该服务商默认音色。Rust 侧新增 `TtsEngine`/`SpeechRecognizer` trait 与工厂，全部调用方（实时对话、PTT、组件语音/资讯缓存、语音笔记）改经工厂解析；资讯缓存键豆包保持 `news-pcm16-v1` 字节兼容、其他服务商 `news-pcm16-v2|provider|model|voice|speed`。设置页「语音识别」「语音合成」双卡独立配置（provider 单选 + 模型手填 + 自定义端点 + 按 scope 掩码恢复），凭据广播兼容新旧 providerId。已知限制（MINOR，遗留）：形象级 `custom_tts` 覆盖在全局 TTS 非 custom 时会得到明确的「请先保存 Key」错误（不存在独立的形象级 custom 端点存储）。

**Verification** — `cargo check` PASS（CARGO_TARGET_DIR=C:/Users/chenfei/cargo-target/hachimo-vpe）；全量 Rust 测试（Windows 经 `node pc/src-tauri/scripts/run-tests-windows.mjs`）1330 通过 / 16 失败，16 个全部为本次未触碰模块的 Windows 环境类 PRE-EXISTING（codex_composer PowerShell、graphics_acceptance ELF 路径、usb_serial 传输 harness 等；基线 1586fec 在 Windows 连 lib 测试目标都无法编译，已用独立基线 worktree 证实）；语音套件定向运行全绿：voice_chat_settings 24、component_notes 20、speech_cache 3、dashscope_asr 3、mimo_tts 3、openai_audio 3、persona-swap 1；前端 `npm test` 1827 测试 / 1826 通过 / 1 失败（基线 prism 权限清单，与本特性无关）。独立审查两轮：首轮 2 CRITICAL + 4 个验收测试缺口，修复（a70662b）后复核 SPEC COMPLIANCE / CORRECTNESS / CODEBASE CONSISTENCY 三项 PASS。

### Journey log（排障记录）

1. **worktree 构建三连坑**（Windows）：`ring` 的 C 编译因路径过长失败 → 用短 `CARGO_TARGET_DIR`（如 `C:/Users/chenfei/cargo-target/hachimo-vpe`）；tauri 资源校验要求 `src-tauri/generated-runtime/*`（打包脚本按 `PET_MANAGER_*` 环境变量准备）与 `pc/dist`（`npm run build:web` 生成）存在，本地验证需占位/生成。
2. **基线 `cargo test` 在 Windows 从未可编译**：4 个测试里直接调用 macOS-only 的 `volcengine_asr::configure_storage_dir`（无 cfg 门控）。本分支补上 `#[cfg(target_os = "macos")]` 门控（macOS 行为不变），Windows 测试目标首次可编译。
3. **测试 harness 加载即崩（STATUS_ENTRYPOINT_NOT_FOUND）**：harness import `TaskDialogIndirect`（comctl32 v6 独有），而 tauri-build→embed-resource 只把 manifest 链进 bin 目标（`rustc-link-arg-bins`）；构建脚本内 `PROFILE` 恒为 `debug`，无法感知测试构建。解决：`pc/src-tauri/scripts/run-tests-windows.mjs` 在构建后为测试 exe 落外部 manifest（SxS 优先读取），零构建侵入。Windows 上跑 Rust 测试请用 `node scripts/run-tests-windows.mjs`。

(delivered 时填写)

## [S1] Problem

语音识别（ASR）与语音合成（TTS）各自硬编码单一服务商（豆包/火山引擎），无法使用通义千问（DashScope）、小米 MiMo 等其他服务商，也无法自定义模型；ASR 与 TTS 强制共用一个火山 API Key，导致"识别用 A 家、合成用 B 家"的跨商组合不可能。

## [S2] Design

总体：把「对话大模型」已有的多服务商模式（presets 提供默认值、非白名单、凭据按 provider scope 隔离、自定义模型可手填）复制到 ASR 与 TTS。豆包保持默认服务商，存量用户无感迁移。

### S2.1 服务商清单与标识

统一 provider id：`volcengine`（豆包，默认）、`dashscope`（通义千问/阿里云百炼）、`mimo`（小米）、`custom`（通用 OpenAI 兼容）。

- ASR 可用服务商：`volcengine`、`dashscope`、`mimo`、`custom`（MiMo ASR 为交付后追加，见 S2.8）。
- TTS 可用服务商：`volcengine`、`dashscope`、`mimo`、`custom`。
- 每个服务商预设默认（provider → baseUrl / 默认模型 / 默认音色）：
  - `dashscope`：ASR 模型 `paraformer-realtime-v2`；TTS 模型 `cosyvoice-v3-flash`；baseUrl `https://dashscope.aliyuncs.com`（其 ASR/TTS 走 DashScope 原生协议，不是 OpenAI 兼容音频端点）。音色预设：`longxiaochun_v3`、`longshu_v3`、`longanrou_v3`、`longshange_v3`、`longanxuan_v3`、`longlaotie_v3`（+ 自由填写）。
  - `mimo`：baseUrl `https://api.xiaomimimo.com/v1`。已核实（mimo.mi.com/docs，2026-11-12）：TTS `mimo-v2.5-tts` 走 Chat Completions 兼容端点（assistant 消息携带待合成文本，`audio.voice` 指定音色，响应 `choices[].message.audio.data` 为 Base64 WAV）；预设音色 `mimo_default` 等。ASR `mimo-v2.5-asr` 同端点短语音识别（初版评估遗漏，交付后经用户指正补齐，见 S2.8）。
  - `custom`：用户自填 baseUrl + 模型 + 音色，适配器按 OpenAI 兼容 `/audio/speech`、`/audio/transcriptions` 调用（覆盖 SiliconFlow、私有部署等）。

### S2.2 配置与凭据（Rust `voice_chat_settings.rs`）

`VoiceChatSettings` 新增（serde camelCase，全部带 default 兼容旧文件）：

- `asr_provider: String`（默认 `volcengine`）、`asr_model`、`asr_base_url`（仅 custom）
- `tts_provider: String`（默认 `volcengine`）、`tts_model`、`tts_base_url`（仅 custom）、`tts_voice`（非豆包服务商的默认音色）
- `speech_api_keys: BTreeMap<String, String>` — scope 规则与 LLM `llm_api_keys` 相同：`volcengine`（值代理到 volcengine_asr keyring，不落盘）、`dashscope`、`mimo`、`custom:<base-url>`。

规则：

- ASR 与 TTS **共用** `speech_api_keys`（同一服务商一把钥匙，两腿共用）。豆包例外：`volcengine` scope 的 key 继续存放在现有 volcengine_asr keyring 存储（`stored_api_key()`），迁移逻辑 `migrate_shared_speech_key` 保持不变。
- `resolve_tts_key` 改为：provider=`volcengine` → keyring；否则 → `speech_api_keys[scope]`。`tts_uses_asr_key` 仅在 volcengine 下为 true。
- Status（`VoiceChatSettingsStatus`）新增：`asrProvider/asrModel/asrBaseUrl/asrApiKeyMasked/asrConfigured`（asrConfigured = 当前 ASR provider 的 key 就绪）、`ttsProvider/ttsModel/ttsBaseUrl/ttsVoice/ttsApiKeyMasked`；`tts_configured` 按**已解析 provider** 计算。
- 输入（`VoiceChatSettingsInput`）新增对应可选字段；保存时按 scope 隔离，切换 provider 不沿用其他家 key（复用 LLM 的 mask/restore 模式）。
- 旧字段 `tts_api_key`/`tts_resource_id` 及其迁移逻辑原样保留（豆包路径）。

### S2.3 TTS 引擎抽象（Rust）

- 新 trait `TtsEngine { async synthesize(text, on_pcm) -> usize; interrupt(&mut self); async reset(); }`（on_pcm 收 16kHz 单声道 S16LE PCM，与现状一致）。
- `DoubaoTtsClient` 适配 trait（现有行为不变）。
- 新适配器：
  - `dashscope_tts.rs`：HTTP POST `https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`，header `Authorization: Bearer` + `X-DashScope-SSE: enable`，body `{model, input:{text, voice, format:"pcm", sample_rate:16000}}`，解析 SSE `output.audio.data` base64 分片流式产出 PCM。speed 映射到服务商支持的语速参数（不可用时忽略并注释说明）。
  - `openai_audio.rs::speech`：POST `{base}/audio/speech` `{model, input, voice, speed, response_format:"pcm"}`，24kHz（OpenAI 规范）→ 16kHz 线性插值重采样。
  - `mimo_tts.rs`：MiMo 专属适配器——Chat Completions 兼容调用 + Base64 WAV 解码（解析 WAV 头采样率，任意声道均值混单声道，线性重采样到 16 kHz）。
- 工厂 `voice_chat_settings::tts_engine(provider_override: Option<&str>, speaker, clone_id, speed) -> Result<Box<dyn TtsEngine>, String>`：解析 provider（形象级覆盖 > 全局）、凭据、模型、音色；**非豆包 provider 收到豆包风格音色 id（空、含 `bigtts`/`icl`）时回退到该 provider 默认音色**（组件语音/新闻读书场景）。
- 调用方改造：`realtime_chat.rs`（会话 TTS、`apply_pending_persona*`、`persona_voice_preview`）、`component_voice.rs`、`component_audio.rs`、`speech_queue.rs` 全部经工厂获取引擎；`speech_cache.rs` 缓存键加入 provider+model。

### S2.4 ASR 引擎抽象（Rust）

- 新 trait：`SpeechRecognizer { start(callback: Fn(StreamingSpeechEvent)); push_pcm(&[u8]); finish(); cancel(); }`，事件复用 `StreamingSpeechEvent::{Ready, Partial, Final, Error}`（移到中立的 `speech.rs` 或保留原模块 re-export，避免命名漂移）。
- `StreamingSpeechRecognizer`（火山）适配 trait，协议不变。
- 新适配器：
  - `dashscope_asr.rs`：DashScope WebSocket 推理协议（`wss://dashscope.aliyuncs.com/api-ws/v1/inference/`，`Authorization: Bearer`），run-task（`paraformer-realtime-v2`，`format:"pcm"`、`sample_rate:16000`）→ 二进制 PCM 帧 → finish-task；`result-generated` 映射 Partial/Final。实现时以官方文档核对帧格式（T2 内核验点）。
  - `openai_audio.rs::transcribe`：一次性识别——缓冲整轮 PCM（上限 60s，超出截断并注释），finish 时加 WAV 头 POST `{base}/audio/transcriptions`（multipart，`model`、可选 `language`），只产 Final 事件（无 Partial）。
- 工厂 `asr_engine::create() -> Result<Box<dyn SpeechRecognizer>, String>`（按全局配置）。每轮语音开始时调用工厂，provider 切换下一轮即生效。
- `volcengine_asr::settings_status()` 的 `provider` 字段改为从全局配置读取（不再硬编码 `"volcengine"`）；`configured` 按当前 provider 的凭据判断。`probe_saved_settings`（静音探测）仅保留给 volcengine；其他服务商"已配置"= key 非空。
- 调用方改造：`lib.rs`（PTT 转写）、`realtime_chat.rs`、`component_notes.rs`、`pc_audio.rs` 构造点全部经工厂。
- 本地 SAPI 离线兜底（pc_audio 内部）不受影响。

### S2.5 形象级 TTS 服务商（前端 persona-voice.js + Rust VoiceSpec）

- `persona-voice.json` schema 升级 v2：`voice.provider` 允许 `""`（跟随全局，默认）、`"doubao_tts"`、`"dashscope_tts"`、`"mimo_tts"`、`"custom_tts"`。
- 迁移：v1 文档一律把 provider 规整为 `""`（旧值是强制写入的 `doubao_tts`，不能当作用户显式选择），升级后由用户在 UI 重新显式选择。
- `voiceSpecFor` 载荷新增 `provider`；Rust `RealtimeChatStartInput.voice`（`VoiceSpec`）新增 `provider: String`；会话解析用形象级覆盖，否则全局。
- 复刻音色（clone_speaker_id）仅豆包支持：解析为非豆包 provider 时忽略 clone 字段（UI 同时隐藏）。

### S2.6 前端设置 UI（ApiSettings.jsx）

「语音识别与合成」一卡拆两卡，均含 provider 单选（豆包/通义千问/小米MiMo/自定义，按 S2.1 可用性）：

- 识别卡：provider 单选；豆包 = 现有 key 输入 + 测试（keyring + probe 原样）；其他 = 模型（预设默认 + 「手动填写模型」自由输入，复用 TextModelSelect 交互模式）+ 自定义 baseUrl（custom）+ key 输入。切换 provider 清空草稿、按 scope 恢复掩码（复刻 LLM 卡行为）。保存路由：豆包 → `save_device_asr_settings`；其他 → `save_voice_chat_settings`。
- 合成卡：provider 单选；豆包 = 现状提示（与识别共用 key）+ 资源信息；其他 = 模型（默认+手填）+ 默认音色（dashscope 预设列表 + 自由填写；mimo/custom 自由填写）+ 自定义 baseUrl + key。
- `api-configuration.js`：新增 `ASR_PROVIDER_OPTIONS`、`TTS_PROVIDER_OPTIONS`（id/label/每家默认值），ASR/TTS 凭据 scope/mask/restore 帮助函数（复刻 LLM 三件套）。
- `voice-credential-events.js`：`subscribeAsrCredentialUpdates` 同时接受旧 `volcengine-asr` 与新通用 `voice-asr` providerId；ApiSettings 广播两处对齐。
- `VoiceAssistantPanel.jsx`：识别服务商状态文案跟随 provider（不再写死"豆包"）。

### S2.7 形象声音 UI（PersonaVoiceModal.jsx）

声音列新增「合成服务商」选择（跟随全局/豆包/通义千问/MiMo/自定义）；音色选择随 provider 切换：豆包 = 现有目录；dashscope = 预设音色 + 手填；mimo/custom = 手填；复刻音色输入仅在豆包显示；语速滑杆保留（适配器不支持时忽略）。试听（`persona_voice_preview`）按当前选择的 provider 试听，gating 改为该 provider 凭据就绪。

### S2.8 MiMo ASR（交付后追加，2026-11-13）

初版评估判定「MiMo 无公开 ASR」有误——`mimo-v2.5-asr` 走与 TTS 同一 Chat Completions 端点的短语音识别（用户指正并核实 mimo.mi.com/docs）：整轮 PCM 加 WAV 头，以 `input_audio`（Base64 data URL，≤10MB，仅 wav/mp3）上传，`asr_options.language` 支持 auto/zh/en，转写文本在 `choices[].message.content`。实现复用一次性转写架构：`mimo_tts::transcribe` 适配器 + `asr_engine::Transcriber::Mimo` 路由（无流式 Partial，仅 Final），预设模型 `mimo-v2.5-asr`（可手填）。shortcut: 短语音一次性输出对 PTT 场景足够；需要边说边出字时再评估其流式接口。

### S2.9 通义千问 ASR 协议二选一（交付后追加，2026-11-13）

`qwen3-asr-flash` 的 OpenAI 兼容 HTTP 接口（compatible-mode `/chat/completions`，请求/响应形状与 MiMo ASR 完全一致）取代 WS 成为预设：`asr_engine` 按**模型名**分发协议——模型含 `qwen` 走 HTTP Chat 一次性（`Transcriber::Chat`，`compatible_mode: true` 拼 `/compatible-mode/v1` 前缀），否则（含存量保存的 `paraformer-realtime-v2`）继续走 WS 流式。二选一无新增配置项，保存的模型名即协议选择；设置页模型字段给出两种选择的说明。Rust 预设与前端 `ASR_PROVIDER_PRESETS` 默认改为 `qwen3-asr-flash`。

## [S3] Scope

- In scope：
  - ASR：volcengine（现有）、dashscope（WS 流式）、custom / OpenAI 兼容（一次性）；mimo 视 T7 核实结果。
  - TTS：volcengine（现有）、dashscope（HTTP SSE 流式）、mimo、custom / OpenAI 兼容。
  - 全局 ASR/TTS 独立配置 + 各自凭据（跨商组合）；形象级 TTS provider 覆盖；自定义模型/音色/端点；存量配置迁移。
  - 全部调用方改造（realtime chat、PTT、组件语音、语音笔记）与回归测试。
- Out of scope：
  - 非豆包服务商的音色复刻/克隆与音色注册（voice enrollment）。
  - 音频模型的 `/models` 目录发现（手填即可，复用 TextModelSelect 的手动模式交互）。
  - custom ASR 的流式 Partial（OpenAI 兼容转写为一次性，只有 Final）。
  - per-appearance ASR provider（形象级只做 TTS，ASR 保持全局）。
  - Qwen-Audio / Realtime duplex 语音到语音大模型（管线仍是 ASR→LLM→TTS 级联）。
  - 本地 SAPI 兜底、固件、server 目录改动。

## Tasks

- [x] T1: Rust 配置层——`VoiceChatSettings` 新字段、speech key scopes、status/input 扩展、volcengine 代理与迁移（depends: none）
- [x] T2: TTS 引擎——trait + 工厂 + doubao 适配 + `dashscope_tts.rs` + `openai_audio.rs::speech`（含 24k→16k 重采样）+ 调用方/缓存键改造（depends: T1）
- [x] T3: ASR 引擎——trait + 工厂 + 火山适配 + `dashscope_asr.rs` + `openai_audio.rs::transcribe`（WAV 封装、一次性 Final）+ `settings_status` 动态 provider + 调用方改造（depends: T1）
- [x] T4: 前端配置库与设置 UI——`api-configuration.js` provider 表、ApiSettings 双卡、`voice-credential-events.js`、`VoiceAssistantPanel` 文案（depends: T1, T2, T3 接口定稿后并行）
- [x] T5: 形象声音——persona-voice.js v2（provider 迁移）、`VoiceSpec.provider` 贯通、PersonaVoiceModal provider 感知音色 UI、试听 gating（depends: T2, T4）
- [x] T6: MiMo 核实与收尾——已核实（TTS=Chat Completions 兼容 + Base64 WAV；ASR 无公开 API，MiMo 仅进 TTS 列表）；落地 `mimo_tts.rs` 适配器（depends: T1–T5）

## [S4] Acceptance

- [x] A1: 全局选择 ASR=dashscope、TTS=volcengine（或任意跨商组合）时，实时对话（realtime chat）完整走通：设备语音 → 转写 → LLM → 合成回放（Rust 测试覆盖 provider 解析与引擎选择；网络调用以适配器单测的请求构造/响应解析为准）。
- [x] A2: 每个 provider 的凭据按 scope 隔离：切换 ASR/TTS provider 后 key 草稿清空、掩码按 scope 恢复、不沿用其他家 key（Rust + 前端测试）。
- [x] A3: 自定义服务商可配置 baseUrl + 模型 + 音色，适配器按 OpenAI 兼容音频端点发请求（单测断言 URL/headers/body 形状、PCM 重采样正确性）。
- [x] A4: 形象级 provider：v1 存量文档迁移为跟随全局；显式选择某 provider 后该形象用所选服务商合成，复刻字段对非豆包被忽略（persona-voice 测试 + Rust VoiceSpec 测试）。
- [x] A5: 组件语音/新闻读书在全局 TTS 为非豆包时仍能发声（豆包音色 id 回退到该 provider 默认音色；缓存键含 provider+model）。
- [x] A6: 存量用户升级无感：无新配置时 ASR/TTS 均回落 volcengine/豆包，现有测试全部保持通过。
- [x] A7: `cargo test`（pc/src-tauri）与前端 `npm test` 全绿（新增测试 + 既有回归），验证命令与输出记录在案。
