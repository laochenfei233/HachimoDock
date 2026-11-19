---
feature: app-update-panel
status: delivered
updated: 2026-11-20
branch: feat/app-update-panel
commits: f7dc9d9..b4baf19
---

# 应用更新板块（App Update Panel）

## Report

**What was built** — 设置 tab 底部新增「应用更新」卡片（`pc/src/AppUpdateCard.jsx`）。打开设置页自动查询一次 `api.github.com/repos/laochenfei233/HachimoDock/releases/latest`，与 `CARGO_PKG_VERSION` 比较：仓库尚不存在（404）或网络失败时显示「暂无发布版本」空态而非错误；发现新版本时显示版本号、发布日期与发布说明，提供应用内下载（`.part` 临时文件 + 原子改名 + `app-update-download-progress` 进度事件 + 直连失败后一次 `gh-proxy.com` 镜像回退 + 大小护栏）与「立即安装」（仅启动 updates 目录内的 `*.exe`，macOS 引导到发布页）。release 存在但没有本平台安装包时退化为「前往发布页」（经 `open_external_url` 打开）。

原生命令 `app_update_check / app_update_download / app_update_install` 位于 `pc/src-tauri/src/app_update.rs`，全部注册进 `generate_handler!` 与 `local-app-commands.json`（community-bridge 一致性测试强制对齐）。check 为 async + `spawn_blocking`（避免非异步命令阻塞主线程）；download 用 `try_lock` 拒绝并发下载。

**Verification**

- `npm test`（worktree pc/）：1966 pass / 0 fail（含 3 个新 `AppUpdateCard.test.js` 断言）。
- `npm run build:web`：pass（需工作区本地 TEMP，全局 Temp 拒绝 esbuild 清理）。
- `cargo check`：exit 0（clang-cl 覆盖本机 cc-rs/cl.exe exit-2 问题：vcvars64 + `CC_x86_64-pc-windows-msvc=clang-cl`，见记忆 hachimodock-cargo-clang-cl-workaround）。
- 纯逻辑单测（版本比较 8 断言 + 资产选择）在独立 crate 通过；完整 lib 测试二进制在本机 Win10 19044 无法启动（STATUS_ENTRYPOINT_NOT_FOUND，环境限制）。
- `test:bridge`：20 失败 = 上游 139c993 在本机的相同基线（已对比验证），与本特性无关。

**Journey log**

- 合并上游 v0.1.230→v0.1.245（42 文件冲突）先于本特性完成；合并本身另修了 voice_chat_settings 结构体字段重复与 provider String 类型（main 分支 f7dc9d9）。
- 本机 cl.exe 在 cc-rs 下静默 exit 2：手动跑同一 cl 命令成功、cargo 下全失败。换成 clang-cl 作为 CC 后完全通过——不要再用「cargo check 本机无法验证」的旧结论。
- 本地 `generated-runtime` 需 ffmpeg-8.1.3.tar.xz（上游审计源升级）；GitHub API tarball 字节哈希不匹配审计值，只能以 8.1.2 改名占位等用户重建 8.1.3（prepare-desktop-resources.mjs 的哈希校验会在真打包时拦截占位文件）。
- Review 修正了四个实现初版问题：同步 check 命令会在目标网络下冻结主线程；`window.open` 在 Tauri v2 webview 是死按钮；无匹配资产被错误折叠进空态；`published_at` 拉取了但没渲染。
- Worktree 里 gitignored 资源用 junction 最省事，但会被公共构建的 symlink 门禁拒绝——资源目录要用真实拷贝，只有 node_modules 可保持 junction。

## [S1] Problem

客户端从上游同步到 0.1.245 后，用户没有应用内的方式知道 `laochenfei233/HachimoDock` 仓库发布了新版本，更不能在应用内下载和安装。当前只能手动去 GitHub Release 页面对照版本号。

## [S2] Design

### S2.1 更新源与数据流

- 唯一数据源：`GET https://api.github.com/repos/laochenfei233/HachimoDock/releases/latest`（GitHub REST v3，无需鉴权）。
- 该仓库当前在 GitHub 上尚不存在（404）。API 404/网络失败时面板显示「暂无发布版本」，**不视为错误**；用户建仓发版后面板自动工作。
- 响应解析字段：`tag_name`、`name`、`published_at`、`body`（发布说明，纯文本展示）、`assets[]`（`name`/`browser_download_url`/`size`）。
- 资产选择：Windows 优先匹配名称含 `Windows` 且以 `.exe` 结尾的安装包（`*_Windows-x64-setup.exe`，对应 `npm run build:win` + `bundle:win:collect` 产物命名）；macOS 匹配 `.dmg`。无匹配资产时保留 release 元数据并以「前往发布页」回退（实现以 `has_release`/`installable` 字段区分「无 release」与「release 无本平台资产」两种态）。

### S2.2 版本比较

- 当前版本取 `env!("CARGO_PKG_VERSION")`（与 `tauri.conf.json` / `package.json` 的 `0.1.245` 同源）。
- tag 形如 `v0.1.246`：剥离 `v` 前缀后按 `.` 分段数值比较；段数不齐按 0 补齐；`-` 预发布后缀剥离后比较核心段；任何一段无法解析为数字则视为无法比较（不提示更新，仅展示版本号）。

### S2.3 原生命令（Tauri，均挂 `local-app-commands` 能力）

- `app_update_check() -> AppUpdateStatus`（async + spawn_blocking）：拉取 release 并比较；返回扁平结构 `{ current_version, latest_version, release_name, release_notes, release_url, published_at, asset_name, asset_url, asset_size, update_available, has_release, installable }`；无 release 时返回 `has_release: false` 的空态。
- `app_update_download() -> Result<String>`：重新拉取 release、选择资产，下载到 `app_local_data_dir()/updates/<asset-name>`，通过 `app-update-download-progress` 事件周期性发射 `{ percent, downloaded, total }`；返回落盘绝对路径。reqwest 流式读取（`stream` feature 已启用），写入 `.part` 临时名，完成后原子改名，避免半包被安装；`try_lock` 拒绝并发下载。
- 下载网络失败自动重试一次：直连失败后改用镜像前缀 `https://gh-proxy.com/` 拼接原始 URL（用户网络直连 github.com 资产不可达是常态，无镜像回退则功能在目标网络下永远失败；此为单常量、约 10 行的回退，不是配置面）。
- `app_update_install(path: String) -> Result<()>`：仅 Windows——`std::process::Command::new(path).spawn()`（NSIS per-user 安装器自处理提权/关闭旧进程），路径经 canonicalize + updates 目录包含性校验 + `.exe` 后缀校验；macOS 上该命令返回明确错误（macOS 走「前往发布页」）。
- 新命令全部注册进 `tauri::generate_handler!` 并加入 `permissions/local-app-commands.json`（community-bridge 测试强制两者一致）。

### S2.4 前端区块（ApiSettings.jsx 底部，独立组件 AppUpdateCard.jsx）

- 设置 tab 内新增「应用更新」卡片：当前版本号、检查状态、「检查更新」按钮。
- 打开设置页自动检查一次（组件挂载时，失败静默降级为空态文案）；手动按钮可重新检查（带 toast 反馈）。
- `update_available` 且平台可安装时显示：最新版本号、发布时间（日期部分）、发布说明（`body` 原文）、「下载并安装」按钮。
- 下载中显示百分比进度（订阅 `app-update-download-progress`）；完成后按钮变「立即安装」调 `app_update_install`，toast 提示按安装器引导完成、安装期间不要关闭应用。
- 复用现有 UI 词汇（`ui-field`、`btn-primary`、toast 栈、`api-settings__result`），样式沿用设置页现有 token，不新增设计语言。

## [S3] Scope

- In scope：
  - Rust `app_update.rs` 模块（check/download/install 命令、进度事件、版本比较 + 单元测试）。
  - ApiSettings.jsx 设置页更新卡片（独立 AppUpdateCard 组件）+ 前端源码断言测试。
  - 命令注册 + 权限白名单同步 + `pc/.folder.md`、`pc/src/.folder.md` 目录文档条目。
- Out of scope：
  - 自动定时检查/启动时强制检查（仅打开设置页检查一次 + 手动按钮）。
  - Tauri 官方 updater 插件、签名校验、静默升级、断点续传、差分更新。
  - macOS 应用内安装（dmg 只引导到发布页；`installable` 字段门控）。
  - 发布自动化：`laochenfei233/HachimoDock` 仓库本身需要用户在 GitHub 建仓并上传 release 资产，本特性只消费它。
  - 仓库没有 `pc/src-tauri/.folder.md`（实现时确认），目录文档落在既有两份 .folder.md 中。

## Tasks

- [x] T1: Rust `app_update.rs`：check/download/install 命令、进度事件、版本比较 + 单元测试 (depends: none)
- [x] T2: 命令注册 + `local-app-commands.json` 白名单 + 目录文档 (depends: T1)
- [x] T3: ApiSettings.jsx 更新卡片（自动检查/进度/安装/toast）+ 前端测试 (depends: T1)
- [x] T4: 全量验证 npm test / build:web / cargo check（clang-cl） (depends: T1-T3)

## [S4] Acceptance

- [x] `app_update_check` 对 tag `v0.2.0` vs 当前 `0.1.245` 判定 `update_available=true`；对 `v0.1.245` 判定 false（Rust 单测，standalone crate 验证）。
- [x] API 404/网络错误时 check 命令返回空态而非 Err，前端显示「暂无发布版本」（`app_update.rs` fetch 路径 + `empty_status` 单测 + AppUpdateCard 渲染断言）。
- [x] 三条命令均在 `generate_handler!` 与 `local-app-commands.json` 中（community-bridge 一致性测试通过，npm test 全绿佐证）。
- [x] 下载写入 `.part` 临时文件、完成后改名，进度事件百分比单调不越界（实现审查确认；比较/资产选择有单测）。
- [x] 设置页渲染「应用更新」卡片并自动检查一次；前端测试断言卡片、命令与流程存在（AppUpdateCard.test.js 3 项）。
- [x] `npm test` 全绿（1966/0）；`build:web` 通过；`cargo check` 通过（clang-cl 绕行本机 cl.exe 问题）。
