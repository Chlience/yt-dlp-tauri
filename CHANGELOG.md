# Changelog

All notable changes to this project will be documented in this file.

## 0.2.0 - 2026-09-05

### 中文

- 新增网络代理设置：系统／环境代理、直接连接和自定义 HTTP(S)／SOCKS 代理，用于视频／播放列表解析及下载；配置持久保存，已入队请求保留原配置，重试读取最新配置。
- 通知在页面底部独立显示，多条通知和长错误可滚动查看，保留解析与下载操作空间；请求详情支持 Esc 关闭并恢复键盘焦点。
- 新版界面分为新建下载、下载队列和设置，保留中英文切换及工具管理能力。
- 支持播放列表和分集的分页解析、全选已加载条目、反选与序号范围选择；加载中断后保留已有结果并可继续加载。
- 每条选中视频作为独立下载请求，分别显示进度、取消、重试和打开输出；默认同时下载 1 条，可调整为 1–3 条，失败不阻塞后续请求。
- 支持统一的分辨率上限和仅音频模式；播放列表输出到独立子目录，文件名保留原始序号。
- 队列由后端管理并保留至应用关闭；停止启动新请求时，正在运行的请求继续执行。同名输出串行处理，不覆盖已有文件。
- 每个请求使用独立的临时 Cookie 文件；队列存在未结束请求时禁止修改下载工具，重试使用当前工具和 Cookie 配置。
- 启动失败时显示具体错误并支持重试；安装和重装仅显示一次结果通知。
- 拆分翻译和工具链设置模块，清理未使用文案及重复校验，让 manifest 选择测试覆盖生产逻辑。
- 修复修改 URL 或重新解析失败后仍可使用旧下载状态的问题；工具更新提示不再禁用当前可用工具链。
- 已激活工具链缺少可执行文件时仍可检查并重装；受管工具在版本探测前先校验 SHA-256。
- 一行 Cookie 绑定选择文件时的精确 URL 来源，跨站需重新选择；Netscape 文件继续使用自身域名规则。
- 修复下载启动前取消失效的问题；视频解析支持取消和 120 秒超时，统一回收工具子进程并并发读取输出管道。

### English

- Add persistent network proxy settings for video/playlist parsing and downloads: system/environment, direct, and custom HTTP(S)/SOCKS proxies. Queued requests keep their captured setting; retries use the current setting.
- Reserve a scrollable notification area below page content so stacked notices and long errors keep download controls accessible; close request details with Escape and restore keyboard focus.
- Introduce separate New download, Download queue, and Settings pages while retaining bilingual UI and tool management.
- Parse playlists and episodes in pages, select loaded items, invert selections, and choose item-number ranges; preserve partial results and resume loading after interruption.
- Create an independent request for each selected video, with its own progress, cancel, retry, and output actions; run one request by default with a 1–3 concurrency setting, continuing after individual failures.
- Add per-video resolution limits and audio-only output, with playlist subdirectories and filenames that preserve original item numbers.
- Keep the queue in the backend for the current app session; stopping new requests lets running downloads finish. Serialize matching output names without overwriting existing files.
- Isolate each request's temporary Cookie file, block tool changes while requests remain unfinished, and use current tools and Cookie selection when retrying.
- Display startup errors with a retry action, and report installation and reinstallation results once.
- Separate translations and toolchain settings, remove unused messages and redundant validation, and exercise production manifest selection in tests.
- Discard stale video previews after URL changes or failed parsing, and keep the current working toolchain usable when an update is available.
- Allow verification and reinstallation when an active toolchain is missing an executable, and verify managed executable hashes before running version probes.
- Bind one-line Cookie headers to the exact URL origin selected by the user, requiring reselection across origins while preserving Netscape domain rules.
- Preserve cancellation before download startup, add metadata cancellation and a 120-second timeout, and share process-tree cleanup with concurrent output draining across tool commands.

## 0.1.13 - 2026-07-14

### 中文

- Settings 支持在应用管理工具链与本地工具链之间切换；本地模式可从 `PATH` 自动检测工具，也可分别选择 yt-dlp、FFmpeg 目录和 Deno 的绝对路径。
- 本地模式要求 FFmpeg 与 FFprobe 位于同一目录，并通过版本探测和确定性媒体测试验证整套工具的运行兼容性；本地文件的版本、哈希和更新由用户管理。
- 本地工具未检测到时显示简洁的 `Not Found` 状态。

### English

- Added a Settings switch between the app-managed and local toolchains, with `PATH` auto-detection and absolute-path selection for yt-dlp, the FFmpeg directory, and Deno.
- Required FFmpeg and FFprobe to share a directory and verified the complete local toolchain through version probes and a deterministic media test, while leaving local versions, hashes, and updates under user control.
- Displayed a concise `Not Found` status when a local tool cannot be detected.

## 0.1.12 - 2026-07-12

### 中文

- 工具更新改用项目托管的不可变归档和独立 stable channel，应用无需发版即可获得经过验证的 yt-dlp、Deno、FFmpeg 和 FFprobe revision。
- 完整工具链会先下载到 staging revision，完成来源、归档、可执行文件哈希和兼容性检查后再原子激活；失败更新会保留当前可用 revision。
- Settings 会显示当前激活的工具链 revision；应用保留对 v0.1.11 平铺工具目录和 release manifest 的迁移兼容，首次成功激活 revision 后自动使用新的目录布局。
- 新增统一的工具发现、Freshness、原生兼容性验证、归档发布、Canary 和回滚流程，工具更新继续经过维护者 PR 审核。
- 将应用管理的 `yt-dlp` 更新到 `2026.07.04`，并对 GitHub API 请求使用认证，减少 extractor 过期和定时任务限流导致的失败。
- 应用安装包和受管工具链聚焦 Windows 10/11 x64，发布产物为 NSIS 安装包。

### English

- Moved tool updates to a project-controlled immutable archive and independent stable channel so validated yt-dlp, Deno, FFmpeg, and FFprobe revisions can ship without an application release.
- Staged complete toolchain revisions before atomically activating them after source, archive, executable hash, and compatibility checks; failed updates preserve the current working revision.
- Displayed the active toolchain revision in Settings and preserved migration compatibility with v0.1.11 flat tool directories and its release manifest, switching layouts after the first successful activation.
- Added unified discovery, freshness, native compatibility validation, archive publication, Canary, and rollback workflows while keeping tool updates behind maintainer-reviewed pull requests.
- Updated the app-managed `yt-dlp` to `2026.07.04` and authenticated GitHub API requests to reduce failures from stale extractors and scheduled rate limits.
- Focused application packaging and the managed toolchain on Windows 10/11 x64 with an NSIS installer.

## 0.1.11 - 2026-06-24

### 中文

- 工具更新检查改由 Rust 后端下载 release 附带的 `tools-manifest.json`，避免 WebView 因 GitHub release asset 缺少 CORS 头显示 `Failed to fetch`。

### English

- Moved tool update manifest downloads to the Rust backend so GitHub release assets without CORS headers no longer surface as `Failed to fetch` in the WebView.

## 0.1.10 - 2026-06-24

### 中文

- 更新后首次启动会弹出当前版本的更新说明，Settings 中也可手动打开更新说明。
- UI 翻译文案会自动去掉句末句号，避免显示“下载完成。”这类提示。
- 顶部状态提示改为右上角 toast 通知，成功和警告会自动收起，错误会保留到手动关闭。

### English

- Added a post-update release notes dialog for the current version, with a manual Release notes entry in Settings.
- UI translation copy now removes sentence-ending full stops so prompts such as "Download completed." render without the final period.
- Replaced the inline top status panel with top-right toast notifications; success and warning toasts auto-dismiss while errors stay until dismissed.

## 0.1.9 - 2026-06-24

### 中文

- Settings 工具链操作改为验证工具、检查工具更新、安装、更新和重新安装，不再使用含义模糊的修复工具主操作。
- 工具更新检查现在只读取 `yt-dlp-tauri` 最新 GitHub Release 附带的 `tools-manifest.json`，并继续按 SHA-256 安装受管工具。
- Release workflow 会把 `tools-manifest.json` 上传为发布资产，供应用内工具更新检查使用。

### English

- Reworked Settings toolchain actions around verify, check tool updates, install, update, and reinstall, removing the ambiguous repair primary action.
- Tool update checks now read only the `tools-manifest.json` attached to the latest `yt-dlp-tauri` GitHub Release and continue installing managed tools with SHA-256 verification.
- The Release workflow now uploads `tools-manifest.json` as a release asset for in-app tool update checks.

## 0.1.8 - 2026-06-24

### 中文

- 工具链检查现在会按 `tools-manifest.json` 的 SHA-256 校验本地工具，可识别可运行但已不匹配当前固定清单的旧工具。
- Settings 中的工具链主按钮会根据状态显示为安装、更新或修复工具。
- 工具下载进度改为显示当前文件的真实下载百分比，修复 Windows 修复工具链时一开始显示 99% 的问题。
- 将 GitHub Actions 官方 action 和 CI 构建 Node.js 版本升级到 Node 24。

### English

- Tool checks now verify local tools against the `tools-manifest.json` SHA-256 pins so runnable but stale tools are detected.
- The Settings toolchain primary action now switches between installing, updating, and repairing tools based on local state.
- Tool download progress now reports the current file's real download percentage, fixing Windows repair flows that started at 99%.
- Upgraded GitHub Actions official actions and CI build Node.js to Node 24.

## 0.1.7 - 2026-06-23

### 中文

- 工具安装改用应用内 Rust HTTP 下载，并根据 `Content-Length` 与已下载字节显示真实下载进度。
- 将 Windows `ffmpeg`/`ffprobe` 更新到可下载的固定上游构建，修复旧 release asset 返回 404 导致安装失败。
- 新增工具 manifest 下载 URL 健康检查，定时发现上游 asset 失效。
- 工具下载遇到瞬时网络错误或临时 HTTP 错误时会自动重试，减少大文件下载中断导致的安装失败。

### English

- Replaced tool installation downloads with in-app Rust HTTP streaming and real progress from `Content-Length` plus downloaded bytes.
- Updated Windows `ffmpeg`/`ffprobe` to a downloadable pinned upstream build, fixing install failures from the old release asset returning 404.
- Added a tool manifest source URL health check so scheduled checks catch unavailable upstream assets.
- Tool downloads now retry transient network errors and temporary HTTP failures to reduce install failures during large downloads.

## 0.1.6 - 2026-06-23

### 中文

- 将应用管理的 `yt-dlp` 更新到 `2026.06.09`，减少站点 extractor 过期导致的解析失败。
- 视频信息解析失败时优先显示 `yt-dlp` 的 `ERROR:` 行，避免版本过期警告遮挡真正错误。
- 新增定时检查上游 `yt-dlp` release 的 GitHub Actions workflow。

### English

- Updated the app-managed `yt-dlp` to `2026.06.09` to reduce metadata failures from stale site extractors.
- Preferred `yt-dlp` `ERROR:` lines when metadata parsing fails so version-age warnings do not hide the real error.
- Added a scheduled GitHub Actions workflow that checks the pinned manifest against the latest upstream `yt-dlp` release.

## 0.1.5 - 2026-05-27

### 中文

- Cookie 文件支持标准 Netscape `cookies.txt`，也支持从浏览器请求头复制的一行 `Cookie: a=b; c=d` 或 `a=b; c=d`。

### English

- Cookie files now support standard Netscape `cookies.txt` plus one-line browser Cookie headers such as `Cookie: a=b; c=d` or `a=b; c=d`.

## 0.1.4 - 2026-05-27

### 中文

- 新增首页 Cookie 文件选择入口，便于在不同平台或账号之间频繁切换 `cookies.txt`。
- 解析视频信息和下载视频时都会把已选择的 Cookie 文件传给 `yt-dlp`。
- 切换或清除 Cookie 文件后会清空当前解析结果，提示重新解析，避免沿用旧账号状态。

### English

- Added a home-screen Cookie file picker for switching `cookies.txt` across platforms or accounts.
- Passed the selected Cookie file to `yt-dlp` for both metadata parsing and downloads.
- Cleared parsed metadata after changing or clearing the Cookie file so downloads use the current account state.

## 0.1.3 - 2026-05-27

### 中文

- 新增 GitHub Actions 发布打包：从 `v*` tag 生成 Windows NSIS、macOS Intel DMG 和 macOS Apple Silicon DMG 产物。
- 新增 macOS 工具 manifest target，并让后端按平台解析工具路径。
- 在中英文 README 中补充 `yt-dlp` 支持站点列表链接。

### English

- Added GitHub Actions release packaging for Windows NSIS, macOS Intel DMG, and macOS Apple Silicon DMG artifacts from `v*` tags.
- Added macOS tool manifest targets and platform-specific backend tool path resolution.
- Documented the `yt-dlp` supported-sites list in English and Chinese READMEs.

## 0.1.2 - 2026-05-26

### 中文

- 新增从匹配的 `CHANGELOG.md` 版本段落生成 GitHub release notes 的能力。
- 在视频信息解析成功或失败后，补齐元数据进度文案的结束状态。
- 改进 GitHub 更新检查的 API rate limit 错误提示，显示重置时间指导。
- 修复 Bilibili 缩略图预览：对远程封面图片禁用 referrer。

### English

- Added GitHub release notes generation from the matching `CHANGELOG.md` version section.
- Finished the video metadata progress text after successful or failed parsing.
- Improved GitHub update check errors for API rate limits with reset-time guidance.
- Fixed Bilibili thumbnail previews by suppressing referrers on remote cover images.

## 0.1.1 - 2026-05-26

### 中文

- 隐藏工具检查、安装、元数据解析、下载、解压和取消时的后台 Windows 命令窗口。
- 改进工具安装、归档解压和进程失败信息，补充具体路径、退出码和 stderr 细节。
- 对齐 Settings 页脚版本行与更新、项目入口控件。
- 修复缩略图预览：将 HTTP 缩略图 URL 规范化为 HTTPS，并重试备用缩略图候选项。

### English

- Hid background Windows command windows during tool checks, installs, metadata parsing, downloads, extraction, and cancellation.
- Improved tool install, archive extraction, and process failure messages with concrete paths, exit codes, and stderr details.
- Aligned the Settings footer version row with update and project controls.
- Fixed thumbnail previews by normalizing HTTP thumbnail URLs to HTTPS and retrying fallback thumbnail candidates.

## 0.1.0 - 2026-05-26

### 中文

- 将项目重命名为 `yt-dlp-tauri`。
- 新增当前 target 工具链的自动安装。
- 新增简化桌面 UI，支持中英文切换。
- 新增固定版本工具 manifest，并使用 SHA-256 校验。
- 新增手动 GitHub Release 更新检查。
- 新增 Direct / gh-proxy 路由，用于更新检查和 release 链接访问。
- 在 Settings 中新增项目元信息和项目主页入口。
- 新增适合 GitHub 展示的中英文 README。
- 新增 CI 检查：前端测试、前端构建、Rust 测试和 Rust check。

### English

- Renamed the project to `yt-dlp-tauri`.
- Added automatic current-target toolchain installation.
- Added a simplified desktop UI with English and Chinese language switching.
- Added fixed-version tool manifest entries with SHA-256 verification.
- Added manual GitHub Release update checks.
- Added Direct / gh-proxy routing for update checks and release links.
- Added project metadata and a project home link in Settings.
- Added GitHub-ready README files in English and Chinese.
- Added CI checks for frontend tests, frontend builds, Rust tests, and Rust checks.
