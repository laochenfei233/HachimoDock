---
feature: app-update-panel
status: designed
updated: 2026-11-20
branch: feat/app-update-panel
commits: 8a1c77c..<head-sha> # filled at delivery
---

# 应用更新板块（App Update Panel）

## Report

## [S1] Problem

客户端从上游同步到 0.1.245 后，用户没有应用内的方式知道 `laochenfei233/HachimoDock` 仓库发布了新版本，更不能在应用内下载和安装。当前只能手动去 GitHub Release 页面对照版本号。

## [S2] Design

### S2.1 更新源与数据流

- 唯一数据源：`GET https://api.github.com/repos/laochenfei233/HachimoDock/releases/latest`（GitHub REST v3，无需鉴权）。
- 该仓库当前在 GitHub 上尚不存在（404）。API 404/网络失败时面板显示「暂无发布版本」，**不视为错误**；用户建仓发版后面板自动工作。
- 响应解析字段：`tag_name`、`name`、`published_at`、`body`（发布说明，纯文本展示）、`assets[]`（`name`/`browser_download_url`/`size`）。
- 资产选择：Windows 优先匹配名称含 `Windows` 且以 `.exe` 结尾的安装包（`*_Windows-x64-setup.exe`，对应 `npm run build:win` + `bundle:win:collect` 产物命名）；macOS 匹配 `.dmg`。无匹配资产时按钮退化为「前往发布页」。

### S2.2 版本比较

- 当前版本取 `env!("CARGO_PKG_VERSION")`（与 `tauri.conf.json` / `package.json` 的 `0.1.245` 同源）。
- tag 形如 `v0.1.246`：剥离 `v` 前缀后按 `.` 分段数值比较；段数不齐按 0 补齐；任何一段无法解析为数字则视为无法比较（不提示更新，仅展示版本号）。

### S2.3 原生命令（Tauri，均挂 `local-app-commands` 能力）

- `app_update_check() -> AppUpdateStatus`：拉取 release 并比较；返回 `{ current_version, latest_version, release_name, release_notes, release_url, published_at, asset { name, url, size }, update_available }`；无 release 时返回 `{ update_available: false, latest_version: "" }` 型的空态。
- `app_update_download() -> Result<String>`：下载选中的安装包到 `app_local_data_dir()/updates/<asset-name>`，通过 `app-update-download-progress` 事件周期性发射 `{ percent, downloaded, total }`；返回落盘绝对路径。reqwest 流式读取（`stream` feature 已启用），写入 `.part` 临时名，完成后原子改名，避免半包被安装。
- 下载网络失败自动重试一次：直连失败后改用镜像前缀 `https://gh-proxy.com/` 拼接原始 URL（用户网络直连 github.com 资产不可达是常态，无镜像回退则功能在目标网络下永远失败；此为单常量、约 10 行的回退，不是配置面）。
- `app_update_install(path: String) -> Result<()>`：仅 Windows——`std::process::Command::new(path).spawn()`（NSIS per-user 安装器自处理提权/关闭旧进程），不做任何输出捕获与等待；macOS 上该命令返回明确错误（macOS 走「前往发布页」）。
- 新命令全部注册进 `tauri::generate_handler!` 并加入 `permissions/local-app-commands.json`（community-bridge 测试强制两者一致）。

### S2.4 前端区块（ApiSettings.jsx）

- 设置 tab 内新增「应用更新」卡片：当前版本号、检查状态、「检查更新」按钮。
- 打开设置页自动检查一次（组件挂载时，失败静默降级为空态文案）；手动按钮可重新检查。
- `update_available` 时显示：最新版本号、发布时间、发布说明（`body` 原文，等宽/普通文本均可）、「下载并安装」按钮。
- 下载中显示百分比进度（订阅 `app-update-download-progress`）；完成后按钮变「立即安装」调 `app_update_install`，toast 提示按安装器引导完成、安装期间不要关闭应用。
- 复用现有 UI 词汇（`ui-field`、`btn-primary`、toast 栈、`resultToneClass`），样式沿用设置页现有 token，不新增设计语言。

## [S3] Scope

- In scope：
  - Rust `app_update.rs` 模块（check/download/install + 进度事件 + 版本比较 + 单元测试）。
  - ApiSettings.jsx 设置页更新卡片（自动检查、下载进度、安装）+ 前端源码断言测试。
  - 命令注册 + 权限白名单同步。
  - `pc/.folder.md`、`pc/src/.folder.md`、`pc/src-tauri/.folder.md` 目录文档按房屋惯例追加条目。
- Out of scope：
  - 自动定时检查/启动时强制检查（仅打开设置页检查一次 + 手动按钮）。
  - Tauri 官方 updater 插件、签名校验、静默静默升级、断点续传、差分更新。
  - macOS 应用内安装（dmg 只引导到发布页）。
  - 发布自动化：`laochenfei233/HachimoDock` 仓库本身需要用户在 GitHub 建仓并上传 release 资产，本特性只消费它。

## Tasks

- [ ] T1: Rust `app_update.rs`：check/download/install 命令、进度事件、版本比较 + 单元测试 (depends: none)
- [ ] T2: 命令注册 + `local-app-commands.json` 白名单 + 目录文档 (depends: T1)
- [ ] T3: ApiSettings.jsx 更新卡片（自动检查/进度/安装/toast）+ 前端测试 (depends: T1)
- [ ] T4: 全量验证 npm test / build:web / cargo check（vcvars64） (depends: T1-T3)

## [S4] Acceptance

- [ ] `app_update_check` 对 tag `v0.2.0` vs 当前 `0.1.245` 判定 `update_available=true`；对 `v0.1.245` 判定 false（Rust 单测）。
- [ ] API 404/网络错误时 check 命令返回空态而非 Err，前端显示「暂无发布版本」（代码路径 + 单测）。
- [ ] 三条命令均在 `generate_handler!` 与 `local-app-commands.json` 中（community-bridge 一致性测试通过）。
- [ ] 下载写入 `.part` 临时文件、完成后改名，进度事件百分比单调不越界（Rust 单测覆盖比较/命名逻辑，进度逻辑代码审查）。
- [ ] 设置页渲染「应用更新」卡片并自动检查一次；前端测试断言卡片、按钮与命令名存在。
- [ ] `npm test` 全绿（除 2 个固件 staging 相关测试待 `stage-release-firmware.py` 完成后复核）；`cargo check` 通过（ring 的 PRE-EXISTING 失败用 vcvars64 规避）。
