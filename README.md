# yt-dlp-tauri

A minimal Tauri 2 desktop app for downloading videos with `yt-dlp`. Paste a URL, preview metadata, choose a quality, and download an MP4-friendly file without using the command line.

[中文](./README_zh.md)

## Features

- Parse video metadata through `yt-dlp`.
- Show title, thumbnail, source URL, duration, description, and quality options.
- Download with live progress, speed, ETA, and cancellation.
- Choose, save, reset, and open the output folder.
- Install or repair the current target's toolchain from inside the app.
- Verify installed tools with SHA-256 hashes from a pinned manifest.
- Switch the interface between English and Chinese.
- Keep local operational logs.

## Status

This project is ready for public source release, but the release packaging path is still intentionally narrow:

- Current populated tool target: `win-x64`.
- Planned manifest target: `win-arm64`, once every tool URL and hash is pinned.
- Bundle target: NSIS installer.
- Tool binaries are not committed to the repository. The app installs them into the app data tool cache, and development checkouts can restore them with `scripts/download-tools.ps1`.

## Stack

| Layer | Choice |
| --- | --- |
| Desktop runtime | Tauri 2 |
| Backend | Rust |
| Frontend | Vanilla TypeScript + Vite |
| UI | Product-style desktop interface |
| Toolchain | App-managed Windows `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, `deno.exe` |

## Build From Source

Use Windows for real app builds. WSL can run many checks, but release installers should be built on Windows with the MSVC Rust toolchain.

Prerequisites:

- Windows 10/11
- WebView2 Runtime
- Node.js 20+ or 22+
- Rust stable with the MSVC toolchain
- PowerShell 5+ or PowerShell 7+

Install dependencies:

```powershell
npm install
```

Optional: pre-restore tools for a development checkout:

```powershell
.\scripts\download-tools.ps1
```

This step is optional for normal app use. If tools are missing, open the app, go to Settings, and click `Install tools`.

Run in development:

```powershell
npm run tauri dev
```

Build an installer:

```powershell
npm run tauri build
```

The configured bundle target is `nsis`; output is written under `src-tauri\target\release\bundle\nsis\`.

## Verification

Frontend build:

```powershell
npm run build
```

Rust backend tests:

```powershell
cargo test --manifest-path .\src-tauri\Cargo.toml --lib
```

Rust backend check:

```powershell
cargo check --manifest-path .\src-tauri\Cargo.toml
```

## Runtime Data

Downloaded videos default to:

```text
%USERPROFILE%\Downloads\yt-dlp-tauri\
```

App state and logs are stored under:

```text
%LOCALAPPDATA%\yt-dlp-tauri\state\
%LOCALAPPDATA%\yt-dlp-tauri\logs\app.log
```

Development checkout tools can live at:

```text
src-tauri\Tools\win-x64\yt-dlp\yt-dlp.exe
src-tauri\Tools\win-x64\ffmpeg\bin\ffmpeg.exe
src-tauri\Tools\win-x64\ffmpeg\bin\ffprobe.exe
src-tauri\Tools\win-x64\deno\deno.exe
```

Installed app tools are written under the app data directory instead:

```text
%LOCALAPPDATA%\yt-dlp-tauri\Tools\win-x64\
```

Versions, source URLs, target names, and SHA-256 hashes are tracked in [`src-tauri/tools-manifest.json`](./src-tauri/tools-manifest.json).

## Project Layout

```text
index.html                    app shell markup
src/main.ts                   Tauri command wiring, i18n, and UI state
src/styles.css                desktop UI styling
src-tauri/src/lib.rs          Rust backend commands and yt-dlp process control
src-tauri/tauri.conf.json     Tauri app and bundle configuration
scripts/download-tools.ps1    optional development restore script
THIRD-PARTY-NOTICES.md        third-party tool sources and redistribution notes
```

## Release Notes

Before publishing a release:

1. Run the verification commands above.
2. Build the NSIS installer on Windows.
3. Confirm `src-tauri/tools-manifest.json` uses fixed release URLs, not `latest`.
4. Confirm generated folders and restored tools are not staged.
5. Include the GPL license and third-party notices with the release.

## Legal

This project is licensed under GPL-3.0. The app downloads and uses third-party command-line tools with their own licenses and redistribution obligations. See [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).

This project is not affiliated with `yt-dlp`, FFmpeg, Deno, or Tauri.
