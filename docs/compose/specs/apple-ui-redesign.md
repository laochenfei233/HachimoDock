---
feature: apple-ui-redesign
status: in-progress
updated: 2026-11-17
branch: feat/apple-ui-redesign
commits: 2ce63a5..(delivery)
---

# Apple 风格前端重设计 + 全套 Logo 替换

## Report

（交付时填写）

## [S1] Problem

- 用户认为当前前端整体观感不佳：橙色大面积使用显得突兀、控件风格不统一，设置页信息组织不合理（分组混乱、视觉跳跃）。
- 品牌形象更新：应用 logo 需替换为新版橙猫图标（1024×1024 PNG，透明圆角方块底）。
- 缺少深色模式，用户已确认本轮同时交付深浅双主题。

## [S2] Design

设计语言：Apple HIG 为骨架（inset grouped 卡片、半透明侧边栏材质、大标题层级、系统性按压/动效反馈），品牌色取自新 logo 采样（亮橙 #FB740C、深橙圈 #BB4509、奶油白 #FEEFDC）。橙色只用于可交互/激活元素（Apple 用色纪律），不再大面积铺底。

### S2.1 设计 token（浅色 + 深色）

- 浅色：画布 #F5F5F7、卡片 #FFFFFF、主文本 #1D1D1F、次级 #6E6E73、三级 #8E8E93（Apple 网页端灰阶）；accent #F1740A、accent-strong #C25508、accent-soft 奶油 #FFF3E6；语义色对齐 iOS（success/info/warning/danger 各有浅色文字安全档）。
- 深色：画布 #1C1C1E、卡片 #2C2C2E、主文本 #F5F5F7、次级 rgba(235,235,245,.6)；accent 提亮 #FF9F0A。
- 字体栈保留 MiSans 首位（CJK 主导的 UI，尺寸最稳），尾部补 "Microsoft YaHei UI" 兜底；排版纪律按尺寸调 tracking（大标题 -0.02em）。
- 深色模式机制：`lib/theme.js` 三态（跟随系统/浅色/深色），写 `data-theme` 到 `<html>` + localStorage；"auto" 时监听 `prefers-color-scheme`。设置页新增「外观」分组承载三态分段控件。`index.html` 补 `color-scheme` meta。

### S2.2 Logo 全套替换

- 源图存 `pc/art-source/`；生成 `pc/src/assets/logo/hachimodock-mark.png`（256px）供侧边栏 import 替换 `pet-manager-mark.svg`；favicon 入 `pc/public/favicon.png` 并在 `index.html` 声明；`npx tauri icon` 从源图重生成 `pc/src-tauri/icons/` 全套（ico/icns/png）。

### S2.3 基础组件 Apple 化（styles.css 原语层）

- 侧边栏：半透明材质（backdrop-filter blur + rgba 表面），激活项橙色胶囊；`prefers-reduced-transparency` 退化为实色。
- 卡片：inset grouped（白卡 + 12px 圆角 + hairline 分隔），组标题在卡外、脚注在卡内底部次级色。
- 控件：按钮/输入/开关/分段控件统一按压反馈（:active scale .97, 120ms）；弹窗 materialize（scale + opacity + 背景模糊）；全局 `prefers-reduced-motion` 退化。

### S2.4 设置页重设计（IA + 视觉）

- ApiSettings.jsx 重排为 Apple 系统设置式分组：概览状态条 → 语音（识别/合成）→ 对话大模型 → 图像/视频服务商 → 安全存储说明 → 外观（主题三态）。组间留白统一，每组一张 inset 卡。
- 保存语义不变（草稿 + 显式保存行），仅重排与重绘；类名避开已被形象生成网格占用的 `__provider`。

### S2.5 全页面一致性

- 其余页面（设备仪表盘/形象画廊/组件中心/智能家居/设备向导/弹窗/toast）通过原语层自动继承新语言，另对 `:root` 外硬编码 hex（28 处）与关键 rgba 收敛到 token，保证深色模式正确。

## [S3] Scope

- In scope：pc 前端全部页面视觉重设计；设置页 IA 重排；浅/深双主题 + 外观切换；logo 全套替换（应用内 + favicon + Tauri 图标）；`.folder.md` 摘要同步；相关测试更新。
- Out of scope：Rust 原生层、固件、clawpkg 组件内容、行为语义变更（保存/草稿/凭据逻辑）、深色模式下的插画素材重绘。

## Tasks

- [ ] T1: token 重构 + 深色模式基础设施（styles.css、theme.js、设置页外观分组、index.html） (depends: none)
- [ ] T2: logo 全套替换（art-source、mark、favicon、tauri icons、App.jsx import） (depends: none)
- [ ] T3: 原语层 Apple 化（侧边栏/卡片/按钮/开关/输入/分段/弹窗/toast + 动效 + 降级媒体查询） (depends: T1)
- [ ] T4: 设置页重设计（IA 重排 + 视觉 + 测试更新） (depends: T1, T3)
- [ ] T5: 全页面一致性 + 硬编码颜色收敛 (depends: T3)
- [ ] T6: 验证（npm test、build:web、dev:web 浅/深截图目检） (depends: T1–T5)
- [ ] T7: 审查子代理 + 修复 (depends: T6)

## [S4] Acceptance

- [ ] npm test 全绿（基线 1833 通过；因结构变化更新的测试除外，总数不低于基线）
- [ ] npm run build:web 通过（check:public-build-env + vite build + check:release-csp）
- [ ] 浅色与深色主题下各主要页面（仪表盘/画廊/组件中心/智能家居/设置）截图目检无突兀色块、无不可读文本
- [ ] 侧边栏品牌 mark、favicon、Tauri 图标均为新橙猫图
- [ ] 设置页按新 IA 分组呈现，保存/草稿行为不变（现有 ApiSettings 测试语义保留并通过）
- [ ] 外观三态（跟随系统/浅色/深色）切换生效且持久化；reduced-motion/reduced-transparency 降级可用
