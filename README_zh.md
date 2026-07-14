<h1 align="center">yt-dlp-tauri</h1>

<p align="center">
  <strong>一个由 yt-dlp 和 Tauri 2 驱动的轻量 Windows 桌面下载器。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#配置说明">配置说明</a> ·
  <a href="#验证">验证</a> ·
  <a href="#文档">文档</a>
</p>

<p align="center">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-backend-B7410E?logo=rust" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-typed-3178C6?logo=typescript" />
  <img alt="Vite" src="https://img.shields.io/badge/Vite-build-646CFF?logo=vite" />
  <img alt="Windows" src="https://img.shields.io/badge/Windows-desktop-0078D4?logo=windows" />
</p>

<p align="center">
  <img alt="yt-dlp-tauri 中文界面" src="./docs/assets/readme-zh.png" width="920" />
</p>

---

## 项目是什么？

`yt-dlp-tauri` 是一个基于 `yt-dlp` 的小型桌面下载器，用来避免手写命令行参数。粘贴来自 [yt-dlp 支持站点](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)的视频链接、预览信息、选择清晰度，然后通过专注的桌面界面下载 MP4 友好的文件。

这个项目是 desktop-first 和 local-first 的本地工具。它不是托管下载服务，不提供多用户账号，也不隶属于 `yt-dlp`、FFmpeg、Deno 或 Tauri。

## 功能

- 通过 `yt-dlp` 解析视频信息，并预览标题、封面、时长、来源 URL、描述和清晰度选项。
- 下载时显示实时进度、速度、ETA，支持取消，并保存输出目录。
- 为需要登录态的站点选择 Cookie 文件，支持 Netscape `cookies.txt` 和一行浏览器 Cookie 请求头。
- 在 Settings 中安装、更新、重新安装和校验应用管理的完整工具链 revision。
- 可在应用管理工具链与可信本地工具之间切换，本地工具支持从 `PATH` 检测或使用绝对路径选择。
- 从项目托管的不可变 GitHub Release 资产解析 stable 工具链。
- 完整 staging 并校验所有工具后再原子激活，更新失败时保留当前可用 revision。
- 支持中英文界面切换。
- 检查 GitHub Releases 中的应用更新，并可为更新检查和 release 链接启用 `gh-proxy`。
- 写入本地运行日志，方便查看最近的应用事件。

## 技术栈

| 层 | 选择 |
| --- | --- |
| 桌面运行时 | Tauri 2 |
| 后端 | Rust |
| 前端 | Vanilla TypeScript, Vite |
| UI | 固定尺寸的产品型桌面界面 |
| 工具链 | 应用管理或用户选择的 Windows x64 `yt-dlp`、`ffmpeg`、`ffprobe`、`deno` |
| 安装包 | Windows x64 NSIS |

## 快速开始

真实应用构建请在 Windows 上执行。WSL 可以跑很多检查，发布安装包应在 Windows 上构建，或交给 GitHub Actions release workflow。

### 1. 安装系统依赖

- Windows 10/11 x64 + WebView2 Runtime
- Node.js 24+
- Rust stable，安装对应平台 toolchain
- Windows 上需要 PowerShell 5+ 或 PowerShell 7+

### 2. 安装依赖

```powershell
npm ci
```

### 3. 可选：还原开发工具链

```powershell
.\scripts\download-tools.ps1
```

普通使用不需要先执行这个脚本。如果应用检测到工具缺失，打开应用，进入 Settings，点击 `Install tools` 即可。

### 4. 开发运行桌面应用

```powershell
npm run tauri dev
```

### 5. 构建桌面安装包

```powershell
npm run tauri build
```

当前配置的 bundle target 是 `nsis`。构建产物位于：

```text
src-tauri\target\release\bundle\nsis\
```

## 配置说明

| 项 | 用途 |
| --- | --- |
| `toolchain-policy.json` | 经审核的上游来源、版本选择规则、target 和允许访问的 host。 |
| `toolchain-lock.json` | 自动生成的上游身份、不可变归档描述，以及归档和可执行文件 SHA-256。 |
| `src-tauri/tools-manifest.json` | 自动生成的运行时 revision、项目托管归档 URL、target 和可执行文件哈希。 |
| `TOOLCHAIN_CHANGELOG.md` | 独立于应用 release 的工具版本历史。 |
| `src-tauri/tauri.conf.json` | Tauri 应用元信息、固定窗口尺寸、bundle target、图标和资源。 |
| `scripts/download-tools.ps1` | 可选开发脚本，把 pinned `win-x64` 工具链还原到 checkout 中。 |
| Settings: output folder | 用户侧下载目录选择、保存、重置和打开入口。 |
| Settings: GitHub site | 为更新检查和 release 链接选择 `Direct` 或 `gh-proxy`。项目主页始终直连 GitHub。 |
| Settings: tool source | 在经过验证的应用管理 revision 与可信本地可执行文件之间切换。 |

当前发布范围：

- 支持的工具 target：`win-x64`。
- 仓库不提交工具二进制。

## 本地工具模式

Settings 可将完整工具链切换为 `应用管理` 或 `本地工具`。本地模式会在当前进程的 `PATH` 中查找 `yt-dlp.exe`、`deno.exe`，并查找同时包含 `ffmpeg.exe` 和 `ffprobe.exe` 的目录。工具不在 `PATH` 中时，可以分别选择 yt-dlp 可执行文件、FFmpeg 目录和 Deno 可执行文件的绝对路径。`使用 PATH` 会清除这些覆盖路径，再次从 `PATH` 解析全部工具。

应用会运行本地工具的版本命令，并执行与受管 revision 相同的确定性媒体兼容性测试。应用不会固定本地文件哈希、安装更新或替换本地程序。本地程序以当前用户权限运行；所选 yt-dlp 会接收视频 URL 和 Cookie 文件，因此应只配置可信的可执行文件。

## 工具链维护

`Toolchain Discovery` workflow 每周解析一次 yt-dlp、Deno、FFmpeg 和 FFprobe，并维护一个经人工审核的 `bot/toolchain-weekly` PR。`Toolchain Freshness` 每天检查已发布的来源 URL，并为失效来源创建独立的紧急 PR。所有变更都需要维护者审核后合并。

工具链变更合并后会先通过原生验证，再发布到独立的 `yt-dlp-tauri-toolchain` 归档仓库。应用跟随 `toolchain-stable` 通道，`TOOLCHAIN_CHANGELOG.md` 独立记录工具 revision，不要求应用同步发版。

可以在本地只查看统一解析结果，不修改文件：

```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/update-toolchain.mjs --dry-run
```

来源和选择规则写在 `toolchain-policy.json`。解析器会一起生成 lock、运行时 manifest 和工具链 changelog。

## 数据、存储和输出

视频默认下载到：

```text
%USERPROFILE%\Downloads\yt-dlp-tauri\
```

应用状态和日志位于：

```text
%LOCALAPPDATA%\yt-dlp-tauri\state\
%LOCALAPPDATA%\yt-dlp-tauri\logs\app.log
```

工具来源和可选绝对路径配置位于：

```text
%LOCALAPPDATA%\yt-dlp-tauri\state\toolchain-source.txt
%LOCALAPPDATA%\yt-dlp-tauri\state\local-toolchain.json
```

安装后的应用会把工具链 revision 写入：

```text
%LOCALAPPDATA%\yt-dlp-tauri\Tools\win-x64\active.json
%LOCALAPPDATA%\yt-dlp-tauri\Tools\win-x64\revisions\<revision>\
```

首次成功激活 revision 前，应用仍可读取 v0.1.11 的平铺工具目录。

开发 checkout 工具可以位于：

```text
src-tauri\Tools\win-x64\yt-dlp\yt-dlp.exe
src-tauri\Tools\win-x64\ffmpeg\bin\ffmpeg.exe
src-tauri\Tools\win-x64\ffmpeg\bin\ffprobe.exe
src-tauri\Tools\win-x64\deno\deno.exe
```

## 验证

前端测试：

```powershell
npm test
```

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

完整 Tauri 构建：

```powershell
npm run tauri build
```

## 文档

- [变更日志](./CHANGELOG.md)
- [贡献说明](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)
- [第三方声明](./THIRD-PARTY-NOTICES.md)
- [工具链策略](./toolchain-policy.json)
- [工具链变更记录](./TOOLCHAIN_CHANGELOG.md)
- [工具 manifest](./src-tauri/tools-manifest.json)

## 星标历史

<a href="https://www.star-history.com/?repos=Chlience%2Fyt-dlp-tauri&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Chlience/yt-dlp-tauri&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Chlience/yt-dlp-tauri&type=date&legend=top-left" />
   <img alt="星标历史图" src="https://api.star-history.com/chart?repos=Chlience/yt-dlp-tauri&type=date&legend=top-left" />
 </picture>
</a>

## 发布前检查

发布 release 前：

1. 运行上面的验证命令。
2. 对准确的 release commit 以 preflight 模式运行 `Release` workflow，并验证干净安装产物。
3. 推送版本 tag，例如 `v0.1.12`。
4. 等待 `Release` workflow 把 Windows x64 NSIS 安装包和 `tools-manifest.json` 上传到 draft GitHub Release。
5. 确认 `src-tauri/tools-manifest.json` 使用固定 release URL，不使用 `latest`。
6. 确认生成目录和还原出来的工具没有被 staged。
7. 随 release 保留 GPL 许可证和第三方声明。

## 法律说明

本项目使用 GPL-3.0 许可证。应用会下载并使用第三方命令行工具，这些工具有各自的许可证和再分发义务。详见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

本项目不隶属于 `yt-dlp`、FFmpeg、Deno 或 Tauri。
