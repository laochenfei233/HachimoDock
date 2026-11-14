---
feature: desk-companion-clock
status: delivered
updated: 2026-11-12
branch: feat/desk-companion-clock
commits: 1586fec (base)；分支仅含本 spec 文档提交，组件包交付于 ~/.claw-pet/components/library
---

# 桌搭子时钟（desk-companion-clock）

## Report

**What was built** — desk-companion-clock：host:true 的 composition v2 应用工具。纯黑背景（surface.background=0）上，左侧时钟簇居中显示 PC 本地时区的 HH:MM（分钟补零，96px/weight600 白色）、上方中文日期（YYYY年M月D日，灰）、下方天气与气温（Open-Meteo 宁波坐标，WMO 码映射中文天气文案 + 温度℃，灰）；右侧 200×200 桌宠 PNG（设备当前形象 builtin-terrier 西高地白梗的静态帧，扒桌沿姿势）。SW1 手动刷新天气（host.refresh→wx:refresh）。天气缺失/失败时天气行显示"等待数据"，时间日期不受影响。

**Update (v5, 2026-11-14)** — 用户问"等待数据"原因并要求温度整数。诊断：API 本机 curl 直连正常
（17.8℃），时间正常说明组合计划与 USB 快照链路活着，仅 wx json-get 处于取数失败/退避态
（首次取数撞上 PC 开机网络未就绪是最可能场景，refresh_sec 1800 的退避把盲区放大到 30 分钟）。
修复：refresh_sec→900；温度整数化走 wttr.in temp_C 整数字符串（混合双源，引擎不能算浮点是硬边界）。
hash 825946ee590881a5（jobId 20261114T132236727707Z-9fd63bb3）。

**Update (v4, 2026-11-13)** — 用户指定日期行格式 `M月D日 星期x`。clock 源无 weekday，新增 wd/wk
computed 源实现 Sakamoto 算法（6 用例引擎验证全对，含闰年 2/29 与跨年分支）；cjk 图集去"年"加
"星期一~六"（192×128），pet 缩 190×190 腾预算（97540/98304）。校验 OK + smoke CONTRACT_OK，
hash dee12e8a4dfaad56（jobId 20261113T085735113672Z-806e5ebb）。

**Update (v3, 2026-11-12)** — 用户反馈时间边缘模糊、字体要更大、桌宠不能动。修复：① 高清字形图集
（时间 96px=64px 图集 1.5x 双线性，日期/天气 28/30→32px 1:1）根因是内置点阵字库放大；② 桌宠加
渲染器驱动 float 浮动（host 组件无 tick 的动画正解）；图集 alpha 首版被 paste 蒙版破坏（alpha 全 0）
——改为画布直绘 + 逐字 alpha 断言。v3 校验 OK + smoke CONTRACT_OK，hash 64f21ec1a6078572
（jobId 20261112T123747417209Z-a36731a6）。

**Verification** — validate_generated_widget.py → OK exit 0（独立审查者复跑确认）；app_services.application_errors → []（composition v2 全量校验）；smoke_test_widget_game.py → CONTRACT_OK exit 0；PC 同源 app_expr 表达式模拟 4 案例（9:05/14:00 补零、2026年11月12日、多云 13.4℃、雨 22.0℃、缺失→等待数据）全部符合设计；独立 subagent 审查 Spec 合规/正确性/一致性三维 PASS，唯一 minor（RGB565 灰色算错为紫红）已修复（44373=0xAD55→RGB 173,170,173）并复验通过。真机 USB 验收未做（组件包未经设备实机显示/联网验收）。

**Journey log** —
1. pc/application.json 的 composition 引擎与 weather 服务（pc-app-services-v2）二选一，不能同包共存 → 选 composition v2：clock 源 + json-get Open-Meteo 一包同时提供时间与天气。
2. 固件 var_bind 对 int 不补零（%ld）→ 全部格式化上移 PC computed 表达式，设备只渲染字符串。
3. 校验器 graphics 失败信息是通用文案 → 本地重放替换 except 拿到真异常：graphics v1 的 surface.background、图片 fps、节点 color 均为必填。
4. computed 源求值失败会整体置 Null → 不能让 fmt 因天气缺失而失败（否则时间/日期一起变占位符）；用 coalesce 保持 fmt 健康，再把天气文案拆 wxa/wxt 两个源，等待态不再出现"℃"尾巴。
5. RGB565 灰色手算把绿色通道写成 <<6（溢入红色位）→ 渲染成紫红；改用标准灰 0xAD55。

## [S1] Problem

用户要在 P4 桌宠设备上有一个常驻"桌搭子"组件：纯黑背景、中间大号当前时间（到分）、上方日期、下方天气与气温、右侧桌宠形象，让设备在桌面充当时钟天气挂钟。

## [S2] Design

### S2.1 组件形态与画面

- `kind: "tool"`，runtime `engine: "p4-bounded-runtime-v4"`，`host: true` 应用壳：
  `surface.engine="p4-app-surface-v1"` + `surface.graphics="p4-app-graphics-v1"` +
  `surface.bindings="p4-variable-bindings-v1"` + `host_context="p4-host-context-v1"` +
  `input.engine="p4-input-v1"`。`visualStyle: "clean"`、`visualPalette: "mono"`。
- 640×480 逻辑画布，4 个元素节点（纯黑背景由必填的 `surface.background: 0` 提供，不是节点）：
  1. 日期文本（上，居中于左侧时钟簇 cx≈220，28px，灰 44373，RGB565 0xAD55→RGB 173,170,173）；
  2. 时间文本（中，96px，白 0xFFFF，var_bind timeStr，"HH:MM"，分钟补零；字形来自 64px 图集，
     固件双线性采样 1.5x，解决内置 16/32px 点阵放大 3x 的边缘模糊）；
  3. 天气文本（下，32px，灰 44373，"晴 13.4℃"格式，CJK 走 32px 图集 1:1 渲染）；
  4. 桌宠 image 节点（右侧 x≈440，200×200 方形节点）。
- runtime vars 仅 3 个 string：`timeStr`、`dateStr`、`wxStr`。固件 var_bind 对 int 不补零，
  所以所有格式化在 PC composition 表达式完成，设备只渲染字符串。

### S2.2 数据来源（pc/application.json，engine "pc-app-composition-v2"）

- `clock` 源：PC 本地时区 hour/minute/year/month/day。
- `wx` 源：json-get Open-Meteo（免鉴权、纯 HTTPS GET、符合 json-get 域名白名单边界）：
  `https://api.open-meteo.com/v1/forecast?latitude=29.87&longitude=121.54&current=temperature_2m,weather_code&timezone=auto`，
  `hosts: ["api.open-meteo.com"]`，`refresh_sec: 1800`。
  城市宁波（29.87,121.54）——依据用户本机 component-data/city-radio 数据中"宁波"出现 28 次。
- 8 个源（v2 上限正好用满；v5 起混合双源，refresh_sec 900=Open-Meteo 官方 15 分钟数据节拍，
  也把 PC 开机竞态下首次取数失败的最长盲区从 30 分钟压到 5 分钟）：
  - `wx` json-get Open-Meteo（宁波 29.87,121.54，current=temperature_2m,weather_code）→ 天气文案
  - `wt` json-get wttr.in/Ningbo?format=j1 → `current_condition/0/temp_C` 本身就是**整数字符串**（"18"/"-3"）
  - `wxa` WMO 码 if 链（首分支内联 coalesce(-999)：等待数据 / 晴 / 多云 / 阴 / 雾 / 雨 / 雪 / 阵雨 / 阵雪 / 雷雨）
  - `wxt` 温度段：wx 无码→""；wttr temp_C 缺失→""（隐藏，不显示 "晴 —℃"）；否则 " " + temp_C + "℃"
  - `wd`/`wk` Sakamoto 星期（见下）；`fmt` = {time 补零, date: M月D日 星期x, wx: wxa+wxt}
  - 降级矩阵（PC 同源 evaluate 验证）：双源挂→"等待数据"；仅 wttr 挂→"雨"（无温度）；仅 Open-Meteo 挂→"等待数据"；负温度→"雪 -3℃"
  - 温度取整的设计依据：表达式引擎 `integer()` 拒绝浮点、`slice` 仅支持数组（读 app_expr.py 证实），
    包内无法对 Open-Meteo 的 17.8 做任何运算/截断；绑定投影 float→int 也走 as_i64() 失败落 fallback。
    因此整数温度必须由数据源直接提供——wttr.in temp_C 恰为整数字符串。
- `wd`/`wk` computed 源（v4）：clock 无 weekday 字段，用受限表达式实现 Sakamoto 算法——
  wd = (y' + y'/4 − y'/100 + y'/400 + t[month−1] + day) mod 7（y' = year − (month<3)，t = array 12 项，
  get 按月取偏移）；wk = eq 链映射"星期日..星期六"。源数正好 8（v2 上限）；闰年/跨年分支经
  PC 同源 evaluate 引擎 6 用例验证（2026-11-13 星期五、2028-02-29 星期二、2024-02-29 星期四等）。
- `bindings` 精确覆盖 3 个变量，各带 fallback：timeStr→"--:--"、dateStr→"—"、wxStr→"等待数据"。

### S2.3 交互

- 唯一动作 `host.refresh` → `wx:refresh`（json-get 手动刷新）；SW1 短按，label "刷新天气"。
- transition `{"from":"*","on":"host.refresh"}`。
- 无 scene、无 tick（host 组件禁用设备 tick/persist）、无 sfx；不绑定 SW3，不声明退出/系统导航动作。

### S2.4 素材

- `assets/pet.png`：设备当前形象 **builtin-terrier（西高地白梗）**——用户确认不做系统级
  动态形象读取，直接把当前形象导成静态帧。从 `HachimiDock/terrier-clips/idle.begging.mp4`
  第 60% 帧提取：420×420 裁切（狗+桌沿+动感线）→ 压黑位 BLACK_POINT=30（素材近黑底与
  纯黑画布无缝融合，四角全黑）→ 190×190（v4 起缩小 10% 为星期字形腾图集预算，
  节点 x=445,y=155）。
- 提取脚本留在组件目录之外（`generated/_scratch/extract_pet_from_clip.py`），包内只保留最终 PNG。
  （v1 首版曾用手绘哈基米风金毛占位，hash 05e02cc0e0eb9afc，被本版替代。）
- image 节点声明 `motion: "float"`：渲染器驱动的上下浮动动效，无需设备 tick（host 组件禁 tick）。
- v3 高清字形：surface.typography="p4-app-type-v1" + fonts 两个图集——digits（"0123456789:"，
  cell [48,64]，Noto Sans SC Bold 64px 渲染，192×192）与 cjk32（"年月日晴多云阴雾雨雪阵雷等待数据℃—"，
  cell [32,32]，32px）；v4 cjk32 换为 24 字符 192×128（去"年"、加"星期一~六"；"—"与"-"、"."走内置
  字库回退——内置对 ·°℃–—−… 有原生几何补字）；图集像素预算 97540/98304（pet 190×190）；
  字体授权声明在 `licenses/noto-sans-sc-OFL.txt`（Noto Sans CJK 与思源黑体同源，SIL OFL 1.1）。
  构建脚本 `generated/_scratch/build_atlas.py`。hash 64f21ec1a6078572。

### S2.5 展示降级与诚实边界

- PC 快照 >10 秒无效：设备按宿主契约自行显示不可用；
- 天气请求失败/字段缺失：wxStr 显示 fallback"等待数据"，时间/日期来自 PC 时钟不受影响；
- negative-screen 初始预览与 vars init 一致（"--:--" 等占位，不硬编码看似实时的数值）；
- 真机 USB 验收不在本轮：结构校验 + 离线基线能力通过；设备能力以固件源码上报集为准
  （本仓库固件已上报 widgetHostContext/widgetVariableBindings 等所需能力），同步时由 PC 与固件实际协商。

## [S3] Scope

- In scope：`.clawpkg` 组件包全部文件（component.json、negative-screen.json、buttons.json、
  runtime/widget.json、share.json、assets/pet.png、pc/application.json）、pet PNG 绘制、
  结构校验通过、发布到本地组件库。
- Out of scope：PC/固件代码改动、真机验收、城市切换 UI、多城市、桌宠动画（host 组件无 tick）、
  天气详情页、12 小时制/华氏度。

## Tasks

- [x] T1: 绘制 assets/pet.png（PIL 4x 超采样，透明背景单帧） (depends: none)
- [x] T2: 写组件包 JSON（component.json、negative-screen.json、buttons.json、runtime/widget.json、share.json、pc/application.json） (depends: none)
- [x] T3: validate_generated_widget.py 退出码 0；修复全部结构/素材/表达式错误 (depends: T1,T2)
- [x] T4: Review（独立 subagent 审查组件包与 spec 一致性） (depends: T3)
- [x] T5: publish_generated_widget.py 原子发布并报告 jobId/版本哈希（jobId 20261112T114844957683Z-3e58a2bd，versionHash 05e02cc0e0eb9afc） (depends: T4)

## [S4] Acceptance

- [ ] validate_generated_widget.py 退出码 0（含 pc/application.json composition v2 与表达式校验）
- [ ] 画面五要素齐备：纯黑背景 / 中间 HH:MM（分钟补零）/ 上方中文日期 / 下方天气+气温 / 右侧 pet PNG
- [ ] 无虚构数据：天气缺失显示"等待数据"；无硬编码实时数值；fallback 全部类型正确
- [ ] buttons.json 仅 1 个动作且与 transitions 对应；不绑定 SW3；description 不写死可改绑键位
- [ ] pet.png 真实存在、非 JPEG 改名、单帧非空、尺寸在 P4I1 预算内、被 surface.images 精确引用
- [ ] 发布成功且正式目录为 ~/.claw-pet/components/library/desk-companion-clock/<version-hash>/
- [ ] 已知边界如实告知用户：真机未验收；换城市/换 pet 形象需重新发布同 ID 新版本
