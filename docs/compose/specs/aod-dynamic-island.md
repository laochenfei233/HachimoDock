---
feature: aod-dynamic-island
status: delivered
updated: 2026-11-12
branch: feat/aod-dynamic-island
commits: 1586fec..f293d2d
---

# 息屏灵动岛:空闲息屏页与可配置信息项

## Report

**交付内容** — 设备空闲(无触摸/按键)超过可配置时长(默认 5 分钟,0=禁用)后自动进入息屏页:背光 PWM 调至 15%、屏幕纯黑、顶部居中灵动岛胶囊显示至多两项可配置信息(时间/日期/天气/Agent 状态,出厂默认 时间+日期,两项皆无则纯黑纯息屏);任意触摸或按键仅唤醒(恢复 prev_page 与背光 100),同一物理交互的后续队列事件被吞——按键/旋钮/摇杆按 300ms 宽限窗、触摸按笔画闩锁(吞到抬起/取消,5s 绝对兜底)且闩锁只约束触摸侧;AOD 激活中页面被外部切换时保留新页只退出调暗态;对话/资产传输/OTA/音频播放/DSH 审批期间不自动息屏,PC 显式 enter 仅排除诊断页。配置经 `display/aod` topic(query/set/enter,RPC 回执 `display/aod-state`)由 PC 设置卡片下发,NVS 持久化(`p4_display/aod_v1`);天气数据由 PC 复用 hachimi-weather 服务声明与 app_weather 缓存,经心跳可选 `payload["aod"]` 搭载(内容变化或 1 小时到期才携带);固件 hello capabilities 上报 `displayAod:"p4-display-aod-v1"`。PC 端新增 `usb_display_aod` 命令(Rust 校验镜像 master_volume:board 绑定/generation/字段封闭/回执回显)与"息屏灵动岛"设置卡片(超时下拉+两槽显示项+立即息屏),能力不匹配时禁用。顺带修复 main 遗漏:`prism_activate_session` 未登记 local-app-commands.json(community-bridge 契约测试在 main 同样失败)。

**Verification** — `node scripts/run-node-tests.mjs src` 1825/1825(含新增 aod-controller.test.js 8 用例与修复白名单后的 community-bridge);`python firmware/tests/protocol_contract_test.py` rc=0;`python -m pytest firmware/tests/p4_display_aod_test.py` 6 静态过 + 3 行为用例本机无 cc 跳过(三个均以 MSVC cl /std:c11 /W4 /WX 真编译执行通过:apply_config 校验/编码、local_time 日期换算、wake_grace 唤醒宽限/笔画/兜底);`rustfmt --check` 仅对新增 display_aod.rs/aod_weather.rs;`cargo check --lib` PRE-EXISTING 失败(ring 0.17.14 vs MSVC 14.52,未改动的 main 同样失败),Rust 增量经两轮独立评审人工核对类型。`cargo`/`idf.py` 固件目标编译与真机验收不在本机能力内,待 CI/烧录验证。

**Journey log** —
- LCD 息屏调暗的隐藏坑:开机 reveal 用 `force_lcd_backlight_gpio` 把背光脚改成普通 GPIO,LEDC 占空更新不可见;必须用与 BSP 同参的 `ledc_channel_config` 一次调用重挂载+设占空。
- 唤醒吞事件要按"物理交互"而非"队列事件"建模:一次 tap = DOWN..UP+合成手势;闩锁必须带超时兜底且只约束触摸侧,否则 ghost contact 会把整机输入吞到重启。
- 本仓库 lib.rs/usb_serial.rs 等存量 Rust 非 rustfmt-clean且有大量源码文本断言测试:对存量文件只能目标化编辑,`rustfmt` 会沿 mod 树递归重排并打碎 155 个文件的断言。
- 行为测试中的时间语义要对齐设备口径:miniapp 墙钟是 unix+时区偏移的"墙上钟纪元秒"(calendar.timegm),不是时刻的 UTC 时间戳——差 8 小时的断言差点当固件 bug。
- MSVC 可当固件 host 测试的本机替代 `cc`:bat 包一层 vcvars64 + `/utf-8`(中文注释在 cp936 下触发 C4819)+ `%errorlevel%` 精确判零(fail-fast 返回负数,`if errorlevel 1` 判不出)。

## [S1] 问题

设备当前没有息屏能力:背光开机后常亮,屏幕永远显示 main/components/app 三页之一。用户希望设备空闲时进入"息屏页面",以类似 iPhone 灵动岛的形式在屏幕顶部显示时间、日期、天气等信息;信息项最多显示两项,且可在 PC 管理端自行配置。

用户请求引用了 petui skill;本需求是固件系统级页面而非 `.clawpkg` 组件(组件只有在组件中心打开才渲染,不能承载息屏页),故不走 petui 组件发布流程,按固件+PC 端特性实现。

## [S2] 设计

Grill 阶段用户未应答,两个决策轴按推荐项落定:
1. **息屏机制**:空闲超时自动息屏 + 触摸/按键唤醒 + PC"立即息屏"手动触发;超时时长 PC 可配(0=从不)。
2. **信息项候选**:时间 / 日期 / 天气 / Agent 状态共 4 项,最多显示 2 项,PC 可配;默认 时间+日期。

### S2.1 固件:息屏状态机(新模块 pet_p4_display_aod)

- 新文件 `firmware/main/pet_p4_display_aod.c/.h`(加入 CMakeLists 源列表),内聚:配置、持久化、状态机、天气缓存。
- 配置:`timeout_min`(uint16,0=禁用,上限 1440)、`items[2]`(枚举 `none/time/date/weather/agent`,去重)。NVS 持久化照 `pet_p4_audio_volume.c` 的 durable/boot 模式。出厂默认:timeout=5,items={time,date}。
- 输入打点与唤醒吞咽:`pet_p4_input.c`/`pet_p4_touch.c` 队列循环首行调 `pet_p4_display_aod_consume_input()` / `pet_p4_display_aod_consume_touch(state, stroke_end)`,记录 `last_input_ms`;AOD 激活时吞掉事件并唤醒。
- 状态机入口 `pet_p4_display_aod_process(now_ms, &g_state)`,在 `pet_p4_main.c` 主循环 `pet_p4_input_process` 之后(持 `g_state_mutex` 内)调用:
  - 自动进入条件:未激活 && timeout_min>0 && now-last_input≥timeout && `!pet_p4_conversation_active` && 无 asset/OTA 传输 && `!pet_p4_audio_playback_active` && `!pet_p4_audio_music_active` && screen_page 非 `aod`/`touch_test`。进入:记录 prev_page → `screen_page="aod"` → 背光降至 `PET_P4_AOD_BRIGHTNESS_PERCENT`(15)。
  - 退出:激活时任一输入事件 → 恢复 prev_page → 背光恢复 100。touch_test 自动回 main 的既有模式(`pet_p4_main.c` while 循环内)为参照。
  - 唤醒宽限(评审修复):一次物理交互由多条队列事件构成(触摸 DOWN..UP+合成手势、旋钮多格、摇杆 REPEAT)。唤醒只消费第一条;其后 300ms 宽限窗(`PET_P4_AOD_WAKE_GRACE_MS`)内继续吞事件。触摸侧叠加笔画闩锁:吞到抬起/取消为止(`pet_p4_display_aod_consume_touch(state, stroke_end)`),闩锁带 5s 绝对上限(`PET_P4_AOD_STROKE_MAX_MS`,ghost contact 卡死时自动失效恢复分发),且只约束触摸侧——按键/旋钮/摇杆是离散事件,不被笔画连带吞掉。
  - 外部改页(评审修复):AOD 激活中页面被外部切换(PC `control/screen-page`、媒体自动切 app)时,只退出调暗态(背光恢复 100、清 prev_page),保留外部新页;不得回滚 prev_page。
  - PC 显式 enter(`operation:"enter"`)绕过自动门控(对话/传输中也可进),但 touch_test 页除外。
- 背光:`pet_p4_lcd.c` 增 `pet_p4_lcd_set_brightness(percent)` 薄封装;开机 reveal 已把背光脚改为普通 GPIO(断开 LEDC 路由),实现用与 BSP 同参的 `ledc_channel_config`(timer 1 / 10-bit / 5 kHz)一次调用完成重挂载+占空设置,进/出息屏是唯一运行期调用点。

### S2.2 固件:灵动岛渲染(renderer "aod" 分支)

- `pet_p4_renderer.c` 页面分发处(:7321 一带)加 `"aod"` 分支 → `render_aod_page()`:全屏纯黑;顶部居中(距顶 ~44px)圆角药丸,高 ~56px、宽随内容自适应(内边距 + 两项文本宽 + 分隔间距),深灰描边在暗背光下可辨。
- 圆角:矩形主体 + 四角圆形组合(复用 renderer/canvas 现有填充原语;度数符号 `°`(U+00B0)不在中文字体覆盖区(pet_p4_font_cn.c 生成 range),用"实心圆上叠底色小圆"的同心圆环替代,或退化为温度后缀 `C`)。
- 信息项渲染(最多 2,横排,中点分隔;字号用现有 `draw_text_line*` / `draw_text_center`,中文字体 pet_p4_font_cn_16 覆盖所需汉字):
  - `time`:`HH:MM`(scale 2,白),墙钟来自 PC 心跳 clock 锚 `host_wall_clock_estimate_ms`(protocol.c:435)复用 miniapp 换算逻辑(utcOffsetMinutes)。
  - `date`:`M月D日 周X`(scale 1,浅灰;周X/月/日等汉字均在 0x4E00-0x9FFF 覆盖区)。
  - `weather`:`{cond} {temp}`(中文 cond 来自 PC 下发 label;温度整数 + 圆环度符号)。无数据(未收到推送)时该项显示为空占位隐藏。
  - `agent`:view status 枚举 → 中文短标签(休息中/任务中/等待/完成/出错/停止,与 `pet_p4_view.c` 现有回退文案一致)。
  - 两项均 `none` 时不画药丸,仅黑屏 + 调暗(纯息屏)。
- 时钟分钟级变化依赖主循环既有周期渲染(`PET_P4_MAIN_RENDER_INTERVAL_MS`),无需新增刷新机制。

### S2.3 固件:topic 与能力上报

- `pet_p4_protocol.c` 分发链加 `display/aod`(照 audio/volume :4202 模式):
  - `{"operation":"set","timeoutMinutes":N,"items":[...]}`:校验(0..1440 整数;items 长度 0..2、值合法、去重)→ NVS 保存 → 回 `display/aod-state` `{"ok":true,...,"persisted":true}`;非法参数回错。
  - `{"operation":"enter"}`:请求立即息屏 → 回 state。
- `system/heartbeat` 处理(:4317 clock 解析处)增可选 `aod` 对象 `{"tempC":num,"cond":"str"}` → 写入 display_aod 天气缓存(RAM,不持久化,无数据则天气项隐藏)。
- `topic_is_known_but_unsupported`(:532)加 `display/aod` 前缀,旧语义 ack 分类正确。
- hello capabilities 上报点(audioMasterVolume 同处)加 `"displayAod":"p4-display-aod-v1"`。
- `firmware/protocol.md` 增补 `display/aod` 与 heartbeat.aod 文档。

### S2.4 PC:Rust 设置下发(照 master_volume.rs)

- 新 `pc/src-tauri/src/usb_serial/display_aod.rs`:`ENGINE="p4-display-aod-v1"`;`validate_write`(set:operation/requestId/expectedBoardDeviceId + timeoutMinutes 0..=1440 + items ≤2 合法去重;enter:无业务字段);Receipt 校验;一次性 RPC `display/aod` ↔ `display/aod-state`,超时不重放。
- `usb_serial.rs`:`mod display_aod;` + `send_inner_admitted` 加 `display/aod` 的 owned/validate 分支(照 audio/volume :3052)。
- `lib.rs`:`usb_display_aod` 命令(operation "set"/"enter",可选 timeoutMinutes/items)+ invoke_handler 注册(照 :7794/:11853)。

### S2.5 PC:天气数据搭载心跳

- 新小模块(如 `pc/src-tauri/src/aod_weather.rs`):懒加载 hachimi-weather 的 `pc/application.json` Profile(复用 component_app 既有加载路径),模块内 OnceLock 持 Cache/GeoCache;城市用 `shared_location::weather()` 共享城市,否则 `locate_background` IP 自动。
- `send_inner` 心跳 clock 注入处(usb_serial.rs:3086-3089)并列加一块:`capabilities["displayAod"]==ENGINE` 且 `aod_weather::snapshot()` 有新值时写入 `payload["aod"]`;内部每 60 秒踢一次 `locate/refresh_background`(网络节流由 profile.refreshSec 与服务器缓存头控制,踢频不影响请求率),`current()` 产出(截断后 cond/取整温度)变化或超过 1 小时未携带(`SENT_STALENESS_SEC`)才写入,平时心跳载荷不变。快照函数必须廉价(锁 + 读取,网络全在后台)。PC 侧 `cond` 截断到 10 个字符以对齐固件 `PET_P4_AOD_WEATHER_COND_MAX`(31 字节)上限。

### S2.6 PC:设置 UI

- 新 `pc/src/dashboard/aod-controller.js`(照 device-volume-controller.js 模式:控制器工厂 + 冻结空状态 + generation 防串扰 + 单一 invoke + 回执校验)与 `DeviceAodPanel.jsx`:
  - 超时下拉:从不 / 1 / 5 / 10 / 30 分钟(默认 5)。
  - 两个显示项下拉(候选项:无/时间/日期/天气/Agent 状态),互斥去重由 controller 校验;默认 时间+日期。
  - "立即息屏"按钮(operation "enter")、状态行(可用/已保存/错误)。
  - 能力门控 `usb.capabilities.displayAod === "p4-display-aod-v1"`。
- `DeviceDashboard.jsx` 在设备总音量卡旁加 `<Card title="息屏灵动岛">`。

## [S3] 范围

- 范围内:固件息屏状态机与灵动岛渲染、display/aod topic、capability 上报、heartbeat.aod 天气搭载;Rust 设置命令与校验;PC 设置 UI;host 侧测试(pytest + node --test);protocol.md 增补。
- 范围外:设备端配置 UI;息屏亮度可调设置(固定 15%);锁屏安全(PIN);背光全关真息屏(LCD 关背光则灵动岛不可见,与需求冲突);deep sleep 省电;新字库(全用现有 16px 中文字体)。

## Tasks

- [x] T1: 固件 pet_p4_display_aod 模块(配置+NVS+状态机+天气缓存+输入打点) (depends: none)
- [x] T2: 固件 topic display/aod + heartbeat.aod + capability 上报 + protocol.md (depends: T1)
- [x] T3: 固件 renderer "aod" 分支与灵动岛绘制 (depends: T1)
- [x] T4: 固件主循环接线 + pet_p4_lcd 亮度封装 (depends: T1)
- [x] T5: Rust display_aod.rs + usb_serial 分支 + lib.rs 命令 (depends: T2)
- [x] T6: PC aod_weather 心跳搭载 (depends: T2)
- [x] T7: PC 设置 UI(controller+panel+Card) (depends: T5)
- [x] T8: 测试(固件 pytest 契约套件 + PC controller 单测) (depends: T1..T7)

## [S4] Acceptance

- [x] 固件:`python -m pytest firmware/tests -q` 全绿,新增 `p4_display_aod_test.py` 覆盖:display/aod 分支存在、set 校验(items ≤2、去重、timeout 0..1440、非法拒绝)、enter 绕过自动门控、heartbeat.aod 缓存、renderer "aod" 分支、capability 上报、NVS 默认值(5 分钟,time+date)。
- [x] PC:`node --test pc/src/dashboard/aod-controller.test.js` 及既有 dashboard 套件全绿;controller 校验非法配置、门控 engine。
- [x] Rust 新文件经 `rustfmt --check` 解析干净;`cargo check --lib` 若因 ring/MSVC 失败记 PRE-EXISTING(main 未改动同样失败,prism spec 已记录)。
- [x] `firmware/protocol.md` 含 display/aod 与 heartbeat.aod 说明。
- [x] 代码路径核对:自动进入条件含对话/传输/音频门控;退出恢复 prev_page 与背光 100;两项 none 时不画药丸;天气无数据隐藏该项。
