---
feature: weather-key-providers
status: delivered
updated: 2026-11-14
branch: feat/weather-key-providers
commits: 901b89c..(rc1 构建 HEAD)
---

# 天气提供器（和风/彩云）+ 设置页 Key 管理

## Report

**What was built** — 组合引擎新增 PC 内置天气提供器源 `qweather`/`caiyun`（包只声明 kind+坐标，端点与凭据都在 PC：Key/Token 入 Windows 系统凭据库，和风 API Host 存非密配置文件）；设置页新增"天气数据源"区块（填 Key/Host/Token、状态徽标、清除按钮，永不回显 Key）；desk-companion-clock v6（单 qweather 源、官方中文天气直出、27 字 CJK 图集 224×128、pet 178×178，像素预算 97220/98304）；**同分支修复了"等待数据"卡死 bug**（吊销在途取数导致 pending 永久卡死 + 失败后整窗退避），已由用户实测确认根因。

**Verification** — Rust：composition 套件 39/39、weather_keys 3/3（单线程，含卡死回归测试与契约向量）；cargo test --no-run 全量编译通过。Python：校验器 9 用例（合法/坐标/refresh/未知字段/bool/v1 引擎）+ 表达式模拟 5 案例全对；skill 镜像与 repo 副本保持逐字节一致。前端：npm test 1833/1833（含权限清单守护测试）；build:web + CSP 通过。发布器原生校验在未装新引擎的 App 上正确拦截 v6（门禁按设计工作）；v6 发布待用户安装 0.1.230-rc1 后执行。

**Journey log** —
1. json-get 查询参数黑名单（key/token/…）双侧强制——和风 key 参数被硬拦，彩云 token 在路径里虽能绕过黑名单但属"用户凭据"被契约禁止且会随包泄露 → PC 内置提供器是唯一合规路径（github.me 模式）。
2. 用户装的是上游官方 0.1.230（Hachimodock.exe，fork 版本号 0.1.201 混淆）→ 按用户决定 fork 版本改 0.1.230-rc1；发布器门禁读取的是"已安装 App"，v6 发布必须等新引擎装好。
3. skill 目录（~/.agents/skills/petui）是仓库 pc/skills/petui 的镜像，会被同步还原——补丁必须落在仓库里，镜像按需重拷。
4. run-tests-windows.mjs 必须先 prepare-desktop-resources.mjs（需要 bridge/packages/clawd-backend-service 的 node_modules 与 PET_MANAGER_* 环境变量）；npm test 有 lib.rs 命令清单守护测试——新增 Tauri 命令必须同步 permissions/local-app-commands.json。
5. "等待数据"最终定位靠在真实包文件上跑 request() 诊断：PC 组合 2 秒后出数，设备每 2 秒轮询——两层都正常才指向 finish() 的卡死 bug。

## [S1] Problem

桌搭子时钟等组件的天气目前用 Open-Meteo（全球模式数据，对中国城市实况精度一般）+ wttr.in（社区服务，慢且不稳）。用户希望接入**和风天气**与**彩云天气**两个对中国更准的实况源，并在 **Pet Manager 软件设置**里填写各自的 Key/Token。

约束：组合引擎 json-get 禁止携带用户凭据（查询参数黑名单 key/token/… + 不支持自定义请求头，Rust/Py 校验器双侧强制；彩云 token 在路径里虽能绕过黑名单，但属"用户凭据"，契约明文禁止且会随包泄露）——所以 Key 只能存 PC 侧、由 PC 注入请求，即 github.me 鉴权提供器的既有模式。

## [S2] Design

### S2.1 组合引擎新源（component_composition.rs）

`Source` 枚举新增两个变体（serde tag=kind，kebab-case；`QWeather` 显式 rename "qweather"）：

```rust
QWeather { lat: f64, lon: f64, refresh_sec: u32 },   // rename "qweather"
Caiyun  { lat: f64, lon: f64, refresh_sec: u32 },
```

- 仅 `pc-app-composition-v2/v3` 允许声明（v1 拒绝），与 computed/document/collection 同门禁。
- validate：lat ±90 / lon ±180 且有限（取整到 2 位小数，同 app_weather）；refresh_sec 900..=86400。
- 源值归一化为共同形状 `{"text": "<中文天气>", "temp": "<整数字符串>"}`，表达式直接 concat。
- 取数复用现有网络池（Job 增加 `provider: Option<ProviderJob>` 分支；`with_public_network` 守卫、
  15s 超时、2 worker、8 队列语义全部不变）；Key 在 worker 执行时从 keyring 读取，不进缓存键、
  不进日志/错误串。换 Key 后最迟下一个刷新窗口（≤15min）生效，设备端 SW1 刷新立即生效。

### S2.2 两个提供器的请求与解析（PC 内置描述符，包只写 kind+坐标）

| | 和风 QWeather | 彩云 Caiyun |
|---|---|---|
| 请求 | `https://{host}/v7/weather/now?location={lon},{lat}&key={key}` | `https://api.caiyunapp.com/v2.6/{token}/{lon},{lat}/realtime.json` |
| host | 用户可配（2024 起新账号为专属 API Host；默认 devapi.qweather.com），存非密配置文件 | 固定 api.caiyunapp.com |
| 成功判定 | `code=="200"` | `status=="ok"` 且 `realtime.status=="ok"` |
| text | `now.text`（官方中文），罕见词 PC 侧归一化到图集词表（大暴雨→暴雨等），未知词原样透传（设备逐字回退内置字库） | `skycon` 经 PC 内置 20 项映射 → 中文 |
| temp | `now.temp`（整数字符串，原样） | `realtime.temperature`（浮点）PC 四舍五入成整数字符串 |
| 失败 | 源置 error → Null → 组件显示"等待数据"；Key 未配置 → 同样 error，错误串为静态文案 | 同左 |

客户端模式复用 app_weather.rs 既有做法：`no_proxy()` + `media_dns::resolve` DNS 钉住 + `resolve_to_addrs` + gzip + connect 8s/total 15s + 库 UA。

### S2.3 Key 存取（新模块 weather_keys.rs）

- keyring 服务名 `com.petmanager.desktop.weather`，条目 `qweather` / `caiyun`（复用 auth_provider.rs 的 keyring 模式；Windows=系统凭据库）。
- 和风 API Host 非密，存 `{app-data}/weather-provider.json`（deny_unknown_fields，损坏时报错不覆盖）。
- Key 规则：非空、≤128 字节；存储失败明确报错；状态命令只返回 configured 布尔（**永不回显 Key**）。
- Tauri 命令：`weather_key_status()`、`save_weather_key(provider, value, qweather_host)`（value 空 = 删除凭据）。

### S2.4 设置页（ApiSettings.jsx）

新增"天气数据源"区块（语音/视频设置同页惯例）：和风 Key（密码型输入）、和风 API Host（文本，占位提示默认值）、彩云 Token（密码型输入），各带保存按钮与"已配置/未配置"状态徽标；保存调用 `save_weather_key`，状态来自 `weather_key_status`。绝不回显已存 Key，占位符提示"已配置，留空保持不变"。

### S2.5 校验器同步（Python app_composition.py）

与 Rust 逐条对齐：OPERATIONS 加 `qweather/caiyun: {'lat','lon','refresh_sec'}`；v1 门禁加两个 kind；lat/lon/refresh 数值校验同 S2.1。契约向量：若 contracts 有 composition 套件则补用例，无则跳过（两侧 validate 单测覆盖）。

### S2.6 组件侧（desk-companion-clock v6）

- application.json：`wx+wt` 两源换成单源 `wx: {"kind":"qweather","lat":29.87,"lon":121.54,"refresh_sec":900}`；
  `wxa`=text（官方中文直出）、`wxt`=温度段（text 缺→""，temp 缺→""，否则 " {temp}℃"）；
  源数 8→5（clock/wx/wd/wk/fmt）。bindings/设备 runtime 不变。
- 图集扩展：和风词表超出当前 24 字 → cjk 图集改 7 列×4 行=224×128（宽 224≤240 免 wide-atlas），
  新增 小中大暴夹冰雹雾霾沙尘浮强对流 共 14 字（去 年/等待数据——后者走 binding fallback 由内置字库渲染）；
  pet 相应缩至 178×178（像素预算 97220/98304）。
- 已知边界：PC 端未配置 Key / 上游失败 / 断连 → 组件显示"等待数据"（既有降级链路不变）。

## [S3] Scope

- In scope：component_composition.rs 新源+取数+归一化+单测；weather_keys.rs 新模块；lib.rs 注册；
  app_composition.py 同步；ApiSettings.jsx 天气区块；desk-companion-clock v6（application.json + 图集）；
  skill composition.md 参考同步；契约向量（如适用）。
- Out of scope：固件/设备协议（纯 PC 侧变更，设备只见投影变量）；geocoding（坐标由包声明）；
  逐小时/逐日预报；其他组件的接入；QWeather 付费档特判。

## Tasks

- [x] T1: weather_keys.rs 新模块（keyring + host 文件 + weather_key_status/save_weather_key 命令） (depends: none)
- [x] T2: component_composition.rs 源变体 + validate + Job.provider 取数 + 归一化映射 + 单测 (depends: none)
- [x] T3: lib.rs 注册 mod 与命令 (depends: T1)
- [x] T4: app_composition.py 同步 + 校验自测 (depends: T2 设计定稿)
- [x] T5: ApiSettings.jsx 天气数据源区块 + build:web + npm test (depends: T1)
- [x] T6: desk-companion-clock v6 图集扩展 + application.json + 校验（发布待新 App 安装后执行） (depends: T2,T4)
- [x] T7: skill composition.md 参考更新 (depends: T2,T4)
- [x] T8: Rust 测试（run-tests-windows.mjs + CARGO_TARGET_DIR 暖缓存）+ 全量验证 (depends: T2,T3,T4,T5)
- [ ] T9: 独立审查 (depends: T8)
- [ ] T10: 合并 main（本轮执行） (depends: T9)

## [S4] Acceptance

- [ ] 两个新源在 Rust/Py 校验器行为一致：合法声明通过；v1 引擎、超范围坐标、refresh_sec<900、未知字段拒绝
- [ ] Key 全链路不出现：包文件、快照、日志、错误文案 grep 无 key 内容；keyring 条目正确
- [ ] 未配置 Key → 源 error → 设备"等待数据"；配置后取数成功 → {"text","temp"} 归一化值正确（各含 fixture 单测）
- [ ] 设置页可保存/覆盖/清除两个 Key，状态徽标正确；build:web 通过；npm test 全绿
- [ ] Rust 测试无新增失败（对照 ~14 个 PRE-EXISTING 基线）；cargo check 差异仅限 ring PRE-EXISTING
- [ ] 桌搭子时钟 v6 校验/composition/smoke 全过，真实和风取数（用户配 Key 后）显示中文天气+整数温度
- [ ] 交付说明含：设置页填 Key 步骤、和风 API Host 说明（新账号专属域名）、组件重新同步步骤
