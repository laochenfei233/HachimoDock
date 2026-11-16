---
feature: apple-ui-redesign
status: delivered
updated: 2026-11-17
branch: feat/apple-ui-redesign
commits: 2ce63a5..40e448a
---

# Apple 风格前端重设计 + 全套 Logo 替换

## Report

**What was built** — PC 前端整体切换 Apple 风格设计语言：styles.css 以新橙猫 logo 采样重建浅色调色板（accent #F1740A、Apple 网页灰阶文本体系），新增 `:root[data-theme="dark"]` 深色 token 块与半透明侧边栏材质 token，所有遗留硬编码品牌色/语义色（hex 与 rgba）收敛到 token 或 color-mix，两套主题共享同一组 token 名。`lib/theme.js` 三态主题（跟随系统/浅色/深色）：持久化到 localStorage、auto 时监听系统切换、`index.html` 内联 bootstrap 保证深色首帧不闪白，设置页新增「外观」分组承载三态分段控件。

Logo 全套替换：`art-source/hachimodock-logo-1024.png` 派生侧边栏 256px mark（App.jsx 引用替换）、favicon，`npx tauri icon` 重生成 src-tauri/icons 全套（50 个文件，含 ico/icns 与 android/ios 集）。设置页按 Apple 系统设置式重排：使用说明降为卡片底部 hairline 脚注、联网检索开关并入表单、概览条去橙回归平静白卡、保存/草稿/凭据语义不变。侧边栏激活项改 macOS 式橙色圆角选中块；按钮/分段/开关统一 :active 按压反馈；弹窗 materialize 入场；全局 prefers-reduced-motion / prefers-reduced-transparency 降级。独立的 smart-home.css 整体重写为 token 版；实时对话、固件/OTA、设备诊断等状态面全部随主题。

**Verification** — `npm test`：1834/1834 全绿（基线 1833 + 新增外观主题回归测试，含 check:provenance）；`npm run build:web`：vite build + check:release-csp 17 个资产通过；Playwright 对 dev:web 截取浅/深两主题 × 5 页面（设置/设备/画廊/组件中心/智能家居）共 10 张截图目检。审查子代理两轮：第一轮 NEEDS_FIX（深色浅色状态面集群 + smart-home.css 漏网）→ 修复后第二轮 APPROVE（残留两个装饰性 one-liner 已随 40e448a 修复并重跑验证）。

**Journey log** —
- 全局 sed 颜色替换会把 token 定义里的旧值也换掉，产生 `--neutral-soft: var(--neutral-soft)` 自引用；源码文本断言测试的失败输出暴露了它。教训：机械替换后必须做「引用 token vs 定义 token」差集扫描 + 自引用扫描。
- `smart-home.css` 是独立于 styles.css 的第二张样式表，首轮颜色收敛整体漏掉，靠深色全页截图暴露。教训：颜色 token 化前先 `ls *.css` 清点样式表全集。
- 项目里存在引用未定义 token 的死代码（`--text-primary` 5 处靠浅色 fallback 侥幸可读，深色立刻不可读）；修复顺带把裸 `--control-height` 等 3 处死引用一并归位。
- 每个页面有自己的首次访问引导弹窗（backdrop 拦截点击），Playwright 遍历导航需在点击前后都尝试关闭「知道了」。
- 再次确认既有经验：`npm test` 只按文本读源码，JSX 语法问题必须 `npm run build:web` 验证。

## [S1] Problem

- 用户认为当前前端整体观感不佳：橙色大面积使用显得突兀、控件风格不统一，设置页信息组织不合理（分组混乱、视觉跳跃）。
- 品牌形象更新：应用 logo 需替换为新版橙猫图标（1024×1024 PNG，透明圆角方块底）。
- 缺少深色模式，用户已确认本轮同时交付深浅双主题。

## [S2] Design

设计语言：Apple HIG 为骨架（inset grouped 卡片、半透明侧边栏材质、大标题层级、系统性按压/动效反馈），品牌色取自新 logo 采样（亮橙 #FB740C、深橙圈 #BB4509、奶油白 #FEEFDC）。橙色只用于可交互/激活元素（Apple 用色纪律），不再大面积铺底。

### S2.1 设计 token（浅色 + 深色）

- 浅色：画布 #F5F5F7、卡片 #FFFFFF、主文本 #1D1D1F、次级 #6E6E73、三级 #8E8E93（Apple 网页端灰阶）；accent #F1740A、accent-strong #C25508、accent-soft 奶油 #FFF3E6；语义色对齐 iOS（success/info/warning/danger 各有浅色文字安全档）。
- 深色：画布 #1C1C1E、卡片 #2C2C2E、主文本 #F5F5F7、次级 #CFCFD4（Apple rgba(235,235,245,.78) 的实色等价）、三级 #98989E；accent #FF9F0A（实现与规范一致的 systemOrange dark）。
- 字体栈保留 MiSans 首位（CJK 主导的 UI，尺寸最稳），尾部补 "Microsoft YaHei UI" 兜底；排版纪律按尺寸调 tracking（大标题 -0.02em）。
- 深色模式机制：`lib/theme.js` 三态（跟随系统/浅色/深色），写 `data-theme` 到 `<html>` + localStorage；"auto" 时监听 `prefers-color-scheme`。设置页新增「外观」分组承载三态分段控件。`index.html` 补 `color-scheme` meta 与内联主题 bootstrap。

### S2.2 Logo 全套替换

- 源图存 `pc/art-source/`；生成 `pc/src/assets/logo/hachimodock-mark.png`（256px）供侧边栏 import 替换 `pet-manager-mark.svg`；favicon 入 `pc/public/favicon.png` 并在 `index.html` 声明；`npx tauri icon` 从源图重生成 `pc/src-tauri/icons/` 全套（ico/icns/png）。

### S2.3 基础组件 Apple 化（styles.css 原语层）

- 侧边栏：半透明材质（backdrop-filter blur + rgba 表面），激活项橙色圆角选中块（macOS 系统设置样式）；`prefers-reduced-transparency` 退化为实色。
- 卡片：inset grouped（白卡 + 12px 圆角 + hairline 分隔），组标题在卡外、脚注在卡内底部次级色。
- 控件：按钮/输入/开关/分段控件统一按压反馈（:active scale，按钮 .97、开关滑块 .88）；弹窗 materialize（scale + opacity + 背景模糊）；全局 `prefers-reduced-motion` 退化。

### S2.4 设置页重设计（IA + 视觉）

- ApiSettings.jsx 重排为 Apple 系统设置式分组：概览状态条（含安全存储提示）→ 语音（识别/合成）→ 对话大模型 → 图像/视频服务商 → 天气数据源 → 外观（主题三态）。组间留白统一，每组一张 inset 卡；使用说明降为卡片底部 hairline 脚注。
- 保存语义不变（草稿 + 显式保存行），仅重排与重绘；类名避开已被形象生成网格占用的 `__provider`。

### S2.5 全页面一致性

- 其余页面（设备仪表盘/形象画廊/组件中心/智能家居/设备向导/弹窗/toast）通过原语层自动继承新语言，另对 `:root` 外硬编码 hex（28 处）与关键 rgba 收敛到 token，保证深色模式正确。独立的 `smart-home.css` 整体重写为 token 版；实时对话/固件/OTA 弹窗等状态面同样收敛，确保深色下无浅色残留。

## [S3] Scope

- In scope：pc 前端全部页面视觉重设计；设置页 IA 重排；浅/深双主题 + 外观切换；logo 全套替换（应用内 + favicon + Tauri 图标）；`.folder.md` 摘要同步；相关测试更新。
- Out of scope：Rust 原生层、固件、clawpkg 组件内容、行为语义变更（保存/草稿/凭据逻辑）、深色模式下的插画素材重绘。

## Tasks

- [x] T1: token 重构 + 深色模式基础设施（styles.css、theme.js、设置页外观分组、index.html） (depends: none)
- [x] T2: logo 全套替换（art-source、mark、favicon、tauri icons、App.jsx import） (depends: none)
- [x] T3: 原语层 Apple 化（侧边栏/卡片/按钮/开关/输入/分段/弹窗/toast + 动效 + 降级媒体查询） (depends: T1)
- [x] T4: 设置页重设计（IA 重排 + 视觉 + 测试更新） (depends: T1, T3)
- [x] T5: 全页面一致性 + 硬编码颜色收敛（含审查发现的 smart-home.css 与状态面集群） (depends: T3)
- [x] T6: 验证（npm test、build:web、dev:web 浅/深截图目检） (depends: T1–T5)
- [x] T7: 审查子代理 + 修复（两轮：NEEDS_FIX → APPROVE） (depends: T6)

## [S4] Acceptance

- [x] npm test 全绿（1834/1834；基线 1833 + 新增外观主题回归测试）
- [x] npm run build:web 通过（check:public-build-env + vite build + check:release-csp）
- [x] 浅色与深色主题下各主要页面（仪表盘/画廊/组件中心/智能家居/设置）截图目检无突兀色块、无不可读文本（深色下的分段选中段、usage-help、状态面问题已发现并修复）
- [x] 侧边栏品牌 mark、favicon、Tauri 图标均为新橙猫图（50 个图标文件重生成，旧 logo 引用清零）
- [x] 设置页按新 IA 分组呈现，保存/草稿行为不变（现有 ApiSettings 测试语义保留并通过，18/18）
- [x] 外观三态（跟随系统/浅色/深色）切换生效且持久化；reduced-motion/reduced-transparency 降级可用
