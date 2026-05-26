# yt-dlp-tauri

一个基于 Tauri 2 的轻量桌面下载器，底层使用 `yt-dlp`。粘贴链接、预览信息、选择清晰度，然后下载 MP4 友好的文件，不需要手写命令行。

[English](./README.md)

## 功能

- 通过 `yt-dlp` 解析视频信息。
- 展示标题、封面、来源 URL、时长、描述和清晰度选项。
- 下载时显示实时进度、速度、ETA，并支持取消。
- 选择、保存、重置和打开输出目录。
- 在应用内安装或修复当前 target 的工具链。
- 按固定 manifest 的 SHA-256 校验工具。
- 支持中英文界面切换。
- 写入本地运行日志。

## 状态

这个项目已经整理到适合公开源码仓库的状态，但发布打包路径仍然保持克制：

- 当前已填充的工具 target：`win-x64`。
- 计划中的 manifest target：`win-arm64`，等所有工具 URL 和 hash 都固定后再补齐。
- 打包目标：NSIS installer。
- 仓库不提交工具二进制。应用会把工具安装到 app data 工具缓存中，开发 checkout 也可以通过 `scripts/download-tools.ps1` 还原工具。

## 技术栈

| 层 | 选择 |
| --- | --- |
| 桌面运行时 | Tauri 2 |
| 后端 | Rust |
| 前端 | Vanilla TypeScript + Vite |
| UI | 产品型桌面界面 |
| 工具链 | 应用管理的 Windows `yt-dlp.exe`、`ffmpeg.exe`、`ffprobe.exe`、`deno.exe` |

## 从源码构建

真实应用构建请在 Windows 上执行。WSL 可以跑很多检查，但发布安装包应在 Windows + Rust MSVC toolchain 环境中构建。

依赖：

- Windows 10/11
- WebView2 Runtime
- Node.js 20+ 或 22+
- Rust stable，安装 MSVC toolchain
- PowerShell 5+ 或 PowerShell 7+

安装依赖：

```powershell
npm install
```

可选：为开发 checkout 预先还原工具：

```powershell
.\scripts\download-tools.ps1
```

普通使用不需要先执行这个脚本。如果应用检测到工具缺失，打开应用，进入 Settings，点击 `Install tools` 即可。

开发运行：

```powershell
npm run tauri dev
```

构建安装包：

```powershell
npm run tauri build
```

当前配置的 bundle target 是 `nsis`；输出位于 `src-tauri\target\release\bundle\nsis\`。

## 验证

前端构建：

```powershell
npm run build
```

Rust 后端测试：

```powershell
cargo test --manifest-path .\src-tauri\Cargo.toml --lib
```

Rust 后端检查：

```powershell
cargo check --manifest-path .\src-tauri\Cargo.toml
```

## 运行时数据

视频默认下载到：

```text
%USERPROFILE%\Downloads\yt-dlp-tauri\
```

应用状态和日志位于：

```text
%LOCALAPPDATA%\yt-dlp-tauri\state\
%LOCALAPPDATA%\yt-dlp-tauri\logs\app.log
```

开发 checkout 工具可以位于：

```text
src-tauri\Tools\win-x64\yt-dlp\yt-dlp.exe
src-tauri\Tools\win-x64\ffmpeg\bin\ffmpeg.exe
src-tauri\Tools\win-x64\ffmpeg\bin\ffprobe.exe
src-tauri\Tools\win-x64\deno\deno.exe
```

安装后的应用会把工具写入 app data 目录：

```text
%LOCALAPPDATA%\yt-dlp-tauri\Tools\win-x64\
```

工具版本、来源 URL、target 名称和 SHA-256 哈希记录在 [`src-tauri/tools-manifest.json`](./src-tauri/tools-manifest.json)。

## 项目结构

```text
index.html                    应用界面结构
src/main.ts                   Tauri 命令调用、i18n 和 UI 状态
src/styles.css                桌面 UI 样式
src-tauri/src/lib.rs          Rust 后端命令和 yt-dlp 进程控制
src-tauri/tauri.conf.json     Tauri 应用与打包配置
scripts/download-tools.ps1    可选的开发工具链还原脚本
THIRD-PARTY-NOTICES.md        第三方工具来源和再分发说明
```

## 发布前检查

发布 release 前：

1. 运行上面的验证命令。
2. 在 Windows 上构建 NSIS 安装包。
3. 确认 `src-tauri/tools-manifest.json` 使用固定 release URL，不使用 `latest`。
4. 确认生成目录和还原出来的工具没有被 staged。
5. 随 release 保留 GPL 许可证和第三方声明。

## 法律说明

本项目使用 GPL-3.0 许可证。应用会下载并使用第三方命令行工具，这些工具有各自的许可证和再分发义务。详见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。

本项目不隶属于 `yt-dlp`、FFmpeg、Deno 或 Tauri。
