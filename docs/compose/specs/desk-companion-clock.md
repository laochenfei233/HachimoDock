---
feature: desk-companion-clock
status: delivered
updated: 2026-11-12
branch: feat/desk-companion-clock
commits: 1586fec (base)；分支仅含本 spec 文档提交，组件包交付于 ~/.claw-pet/components/library
---

# 桌搭子时钟（desk-companion-clock）

## Report

**What was built** — desk-companion-clock：host:true 的 composition v2 应用工具。纯黑背景（surface.background=0）上，左侧时钟簇居中显示 PC 本地时区的 HH:MM（分钟补零，96px/weight600 白色）、上方中文日期（YYYY年M月D日，灰）、下方天气与气温（Open-Meteo 宁波坐标，WMO 码映射中文天气文案 + 温度℃，灰）；右侧 200×200 哈基米风金毛 PNG 桌宠。SW1 手动刷新天气（host.refresh→wx:refresh）。天气缺失/失败时天气行显示"等待数据"，时间日期不受影响。

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
  2. 时间文本（中，96px weight 600，白 0xFFFF，var_bind timeStr，"HH:MM"，分钟补零）；
  3. 天气文本（下，30px，灰 44373，"晴 13.4℃"格式）；
  4. 桌宠 image 节点（右侧 x≈440，200×200 方形节点）。
- runtime vars 仅 3 个 string：`timeStr`、`dateStr`、`wxStr`。固件 var_bind 对 int 不补零，
  所以所有格式化在 PC composition 表达式完成，设备只渲染字符串。

### S2.2 数据来源（pc/application.json，engine "pc-app-composition-v2"）

- `clock` 源：PC 本地时区 hour/minute/year/month/day。
- `wx` 源：json-get Open-Meteo（免鉴权、纯 HTTPS GET、符合 json-get 域名白名单边界）：
  `https://api.open-meteo.com/v1/forecast?latitude=29.87&longitude=121.54&current=temperature_2m,weather_code&timezone=auto`，
  `hosts: ["api.open-meteo.com"]`，`refresh_sec: 1800`。
  城市宁波（29.87,121.54）——依据用户本机 component-data/city-radio 数据中"宁波"出现 28 次。
- 4 个 computed 源（受限表达式 concat/str/if/lt/coalesce，DAG：w←wx，wxa/wxt←w，fmt←clock+wxa+wxt）：
  - `w` = coalesce(weather_code, -999)
  - `wxa` = WMO 码 if 链：<0 等待数据 / <1 晴 / <3 多云 / <4 阴 / <50 雾 / <71 雨 / <78 雪 / <83 阵雨 / <87 阵雪 / 否则 雷雨
  - `wxt` = 等待态空串；否则 " " + str(coalesce(temperature_2m,"—")) + "℃"
  - `fmt` = object{time, date, wx: wxa+wxt}；time = `str(hour) + ":" + (minute<10 ? "0" : "") + str(minute)`；date = `str(year) + "年" + str(month) + "月" + str(day) + "日"`
  - fmt 不依赖 wx 的缺失字段失败（coalesce 保 fmt 健康，时间/日期不受天气影响）；等待态不出现"℃"尾巴。
- `bindings` 精确覆盖 3 个变量，各带 fallback：timeStr→"--:--"、dateStr→"—"、wxStr→"等待数据"。

### S2.3 交互

- 唯一动作 `host.refresh` → `wx:refresh`（json-get 手动刷新）；SW1 短按，label "刷新天气"。
- transition `{"from":"*","on":"host.refresh"}`。
- 无 scene、无 tick（host 组件禁用设备 tick/persist）、无 sfx；不绑定 SW3，不声明退出/系统导航动作。

### S2.4 素材

- `assets/pet.png`：哈基米风金毛小狗，静态单帧（host 组件无 tick，无动画），透明背景，
  目标约 200×200（P4I1 单图 ≤240 边长、总像素 ≤98304 预算内），PIL 4x 超采样绘制后缩小。
- 绘制脚本留在组件目录之外（`generated/_scratch/`），包内只保留最终 PNG。

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
- [ ] T5: publish_generated_widget.py 原子发布并报告 jobId/版本哈希 (depends: T4)

## [S4] Acceptance

- [ ] validate_generated_widget.py 退出码 0（含 pc/application.json composition v2 与表达式校验）
- [ ] 画面五要素齐备：纯黑背景 / 中间 HH:MM（分钟补零）/ 上方中文日期 / 下方天气+气温 / 右侧 pet PNG
- [ ] 无虚构数据：天气缺失显示"等待数据"；无硬编码实时数值；fallback 全部类型正确
- [ ] buttons.json 仅 1 个动作且与 transitions 对应；不绑定 SW3；description 不写死可改绑键位
- [ ] pet.png 真实存在、非 JPEG 改名、单帧非空、尺寸在 P4I1 预算内、被 surface.images 精确引用
- [ ] 发布成功且正式目录为 ~/.claw-pet/components/library/desk-companion-clock/<version-hash>/
- [ ] 已知边界如实告知用户：真机未验收；换城市/换 pet 形象需重新发布同 ID 新版本
