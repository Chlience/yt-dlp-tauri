# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

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
