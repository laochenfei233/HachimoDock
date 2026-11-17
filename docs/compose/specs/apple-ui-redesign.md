---
feature: apple-ui-redesign
status: delivered
updated: 2026-11-18
branch: feat/apple-ui-redesign
commits: 2ce63a5..3b2a316
---

# Apple 风格前端重设计 + 全套 Logo 替换

## Report

**What was built** — PC 前端整体切换 Apple 风格 + iOS 26 Liquid Glass 空气感设计语言。第一轮（bdfe77a..149a122）：浅色调色板按新橙猫 logo 采样重建（accent #F1740A），`:root[data-theme="dark"]` 深色 token 块，`lib/theme.js` 三态主题（auto/light/dark，localStorage 持久化 + 系统跟随 + index.html 内联 bootstrap 防闪白），设置页新增「外观」分组与 IA 重排（说明降为脚注、概览条去橙），logo 全套替换（侧边栏 mark/favicon/tauri icons 50 文件），全部遗留硬编码色收敛到 token。第二轮 A2（53e9098+3f07d41）：响应用户"边缘太挤、太压迫"的反馈转向 Liquid Glass——圆角系统放宽（8/12/16/20），玻璃材质 token（卡片/弹窗/toast 半透明 + 顶部镜面内高光 + 环境光晕画布），全面放宽间距（卡片 20/24 内边距、页面 gap 20、provider 网格 gap 20），provider 卡片 `align-items: start` 取代强制等高消除死空间，输入框改 iOS 填充式，主按钮加镜面高光与着色投影。关键工程决策：**内容卡只保留半透明不加 backdrop-filter**——backdrop-filter 祖先会成为 position:fixed 后代的包含块，会把仪表盘弹窗困进卡片盒；blur 只留给侧边栏/弹窗/toast 四个 chrome 浮层。`prefers-reduced-motion` / `prefers-reduced-transparency`（浅深两套）全量降级。

**Verification** — `npm test` 1834/1834 全绿（每轮提交后均跑）；`npm run build:web` + CSP 检查通过；Playwright 双主题 × 设置页（含 provider 区域）/设备/画廊/组件中心/智能家居截图目检。审查子代理三轮：R1 NEEDS_FIX（深色浅色状态面 + smart-home.css）→ 修复；R2 APPROVE（含两个装饰性残留，已修）；A2-R1 NEEDS_FIX（**backdrop-filter 包含块陷阱** + 深色 reduced-transparency 优先级漏洞）→ 修复；A2-R2 APPROVE。

**Journey log** —
- **backdrop-filter 会成为 position:fixed 后代的包含块**：给通用 `.card` 加 blur 后，渲染在卡片内部的仪表盘弹窗（AgentAppearancePickerModal 等 fixed 元素）会以卡片盒为定位基准。教训：blur 只上 chrome 浮层（侧边栏/弹窗/toast），内容层玻璃感用"半透明 + 光晕 + 边缘高光"实现，不加 blur。
- 全局 sed 颜色替换会把 token 定义里的旧值也换掉（产生 `--neutral-soft: var(--neutral-soft)` 自引用），靠源码文本断言测试暴露；机械替换后必做 used-vs-defined 差集 + 自引用扫描。
- `smart-home.css` 是独立于 styles.css 的第二张样式表，首轮颜色收敛整体漏掉，靠深色全页截图暴露；颜色收敛前先清点 `ls pc/src/*.css` 全集。
- `prefers-reduced-transparency` 里 `:root` 重置打不过 `:root[data-theme="dark"]`（0,1,0 vs 0,2,0），深色降级必须在 media query 内另开 dark 子块。
- 项目里存在引用未定义 token 的死代码（--text-primary 等 5 处靠浅色 fallback 活了很久，深色立刻不可读）。
- 每页有自己的首次引导弹窗挡 Playwright 点击，导航点击前后都要尝试关闭"知道了"。
- 再次确认：`npm test` 只按文本读源码，JSX 语法问题必须 `npm run build:web` 验证。

## [S1] Problem

- 用户认为当前前端整体观感不佳：橙色大面积使用显得突兀、控件风格不统一，设置页信息组织不合理（分组混乱、视觉跳跃）。
- 品牌形象更新：应用 logo 需替换为新版橙猫图标（1024×1024 PNG，透明圆角方块底）。
- 缺少深色模式，用户已确认本轮同时交付深浅双主题。
- （A2 反馈）第一轮交付后用户指出：卡片间距过挤、卡内内容贴边、provider 网格等高拉伸产生大量死空间；要求整体转向 iOS 26 Liquid Glass 风格（改变布局、更优美）。

## [S2] Design

设计语言：Apple HIG 为骨架 + Liquid Glass 材质（半透明浮层、镜面边缘高光、环境光晕画布、放宽的圆角与呼吸感），品牌色取自新 logo 采样（亮橙 #FB740C、深橙圈 #BB4509、奶油白 #FEEFDC）。橙色只用于可交互/激活元素（Apple 用色纪律），不再大面积铺底。

### S2.1 设计 token（浅色 + 深色）

- 浅色：画布 #F5F5F7、卡片 #FFFFFF、主文本 #1D1D1F、次级 #6E6E73、三级 #8E8E93（Apple 网页端灰阶）；accent #F1740A、accent-strong #C25508、accent-soft 奶油 #FFF3E6；语义色对齐 iOS（success/info/warning/danger 各有浅色文字安全档）。
- 深色：画布 #1C1C1E、卡片 #2C2C2E、主文本 #F5F5F7、次级 #CFCFD4、三级 #98989E；accent #FF9F0A（systemOrange dark）。
- 字体栈保留 MiSans 首位（CJK 主导的 UI，尺寸最稳），尾部补 "Microsoft YaHei UI" 兜底；排版纪律按尺寸调 tracking（大标题 -0.02em）。
- 深色模式机制：`lib/theme.js` 三态（跟随系统/浅色/深色），写 `data-theme` 到 `<html>` + localStorage；"auto" 时监听 `prefers-color-scheme`。设置页「外观」分组承载三态分段控件。`index.html` 补 `color-scheme` meta 与内联主题 bootstrap。

### S2.2 Logo 全套替换

- 源图存 `pc/art-source/`；`pc/src/assets/logo/hachimodock-mark.png`（256px）替换侧边栏 `pet-manager-mark.svg`；favicon 入 `pc/public/favicon.png` 并在 `index.html` 声明；`npx tauri icon` 重生成 `pc/src-tauri/icons/` 全套。

### S2.3 基础组件 Apple 化（styles.css 原语层）

- 侧边栏：半透明材质（blur 40px + rgba 表面），激活项橙色圆角选中块（macOS 系统设置样式）。
- 卡片：inset grouped + hairline 分隔，组标题在卡外、脚注在卡内底部次级色。
- 控件：按钮/输入/开关/分段控件统一按压反馈（:active scale，按钮 .97、开关滑块 .88）；弹窗 materialize（scale + opacity + 背景模糊）；全局 `prefers-reduced-motion` 退化。

### S2.4 设置页重设计（IA + 视觉）

- ApiSettings.jsx 重排为 Apple 系统设置式分组：概览状态条（含安全存储提示）→ 语音（识别/合成）→ 对话大模型 → 形象生成 → 天气数据源 → 外观（主题三态）。使用说明降为卡片底部 hairline 脚注；联网检索开关并入表单。
- 保存语义不变（草稿 + 显式保存行），仅重排与重绘；类名避开已被形象生成网格占用的 `__provider`。

### S2.5 全页面一致性

- 其余页面通过原语层自动继承新语言；`:root` 外硬编码 hex 与关键 rgba 收敛到 token；独立 `smart-home.css` 整体重写为 token 版；实时对话/固件/OTA 弹窗等状态面全部随主题。

### S2.6 Liquid Glass 空气感（A2 修订）

- 圆角系统放宽：radius-sm 8 / md 12 / lg 16 / xl 20。
- 玻璃材质 token：`--card-material`（浅 rgba(255,255,255,.78) / 深 rgba(44,44,46,.72)，**无 blur**——backdrop-filter 祖先会困住 fixed 弹窗）、`--modal-material`（更实，blur 60px）、`--glass-blur`、`--card-edge-highlight` 顶部镜面内高光；画布加环境光晕（accent/info 低透明度径向渐变，fixed）供玻璃漫射；blur 只上侧边栏/弹窗/toast 四个 chrome 浮层。
- 空气感：卡片 header/body 内边距抬档（20/24）、页面 gap 20；provider 头/字段/脚注内边距放宽（16-20px）。
- provider 卡片竖排（用户拍板）：一行一家全宽卡（grid 单列），卡内字段改横向 auto-fill 网格（minmax(250px,1fr)）保持卡片紧凑；900px/620px 媒体块简化（奇偶修补规则删除，620px 字段收敛单列）。
- 输入框改 iOS 填充式：`--surface-muted` 填充 + 无边框 + 聚焦 accent 描边。
- 主按钮：顶部镜面内高光 + accent 着色投影，hover 增强。
- `prefers-reduced-transparency` 浅深两套全量退化（blur 0 + 实色材质）。

## [S3] Scope

- In scope：pc 前端全部页面视觉重设计；设置页 IA 重排；浅/深双主题 + 外观切换；logo 全套替换；`.folder.md` 摘要同步；相关测试更新；（A2）全站间距/圆角/玻璃材质修订与 provider 网格布局修正。
- Out of scope：Rust 原生层、固件、clawpkg 组件内容、行为语义变更（保存/草稿/凭据逻辑）、深色模式下的插画素材重绘。

## Tasks

- [x] T1: token 重构 + 深色模式基础设施 (depends: none)
- [x] T2: logo 全套替换 (depends: none)
- [x] T3: 原语层 Apple 化 (depends: T1)
- [x] T4: 设置页重设计（IA 重排 + 视觉 + 测试更新） (depends: T1, T3)
- [x] T5: 全页面一致性 + 硬编码颜色收敛（含 smart-home.css 与状态面集群） (depends: T3)
- [x] T6: 验证（npm test、build:web、双主题截图） (depends: T1–T5)
- [x] T7: 审查子代理 + 修复（R1 NEEDS_FIX → R2 APPROVE） (depends: T6)
- [x] T8: Liquid Glass token 与材质（radius 系统、glass token、环境光晕、chrome 浮层接入、降级） (depends: none)
- [x] T9: 空气感布局（卡片间距、provider 网格去死空间、输入填充式、主按钮高光） (depends: T8)
- [x] T10: A2 验证 + 回审（1834 绿、build 过、双主题截图、A2-R1 NEEDS_FIX 修复 → A2-R2 APPROVE） (depends: T8, T9)

## [S4] Acceptance

- [x] npm test 全绿（1834/1834；基线 1833 + 新增外观主题回归测试）
- [x] npm run build:web 通过（check:public-build-env + vite build + check:release-csp）
- [x] 浅色与深色主题下各主要页面截图目检无突兀色块、无不可读文本
- [x] 侧边栏品牌 mark、favicon、Tauri 图标均为新橙猫图
- [x] 设置页按新 IA 分组呈现，保存/草稿行为不变（ApiSettings 测试 18/18）
- [x] 外观三态切换生效且持久化；reduced-motion/reduced-transparency（浅+深）降级可用
- [x] provider 网格与卡片区无贴边挤压：卡间距 20px、字段离卡边 16-20px、无强制等高死空间（A2）
- [x] A2 修订后 npm test / build:web 保持全绿并通过回审（A2-R2 APPROVE；竖排追加 3b2a316 复核亦 APPROVE）
