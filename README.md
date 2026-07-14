<h1 align="center">yt-dlp-tauri</h1>

<p align="center">
  <strong>A minimal Windows desktop downloader powered by yt-dlp and Tauri 2.</strong>
</p>

<p align="center">
  <a href="./README_zh.md">中文</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#verification">Verification</a> ·
  <a href="#documentation">Documentation</a>
</p>

<p align="center">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-backend-B7410E?logo=rust" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-typed-3178C6?logo=typescript" />
  <img alt="Vite" src="https://img.shields.io/badge/Vite-build-646CFF?logo=vite" />
  <img alt="Windows" src="https://img.shields.io/badge/Windows-desktop-0078D4?logo=windows" />
</p>

<p align="center">
  <img alt="yt-dlp-tauri English interface" src="./docs/assets/readme-en.png" width="920" />
</p>

---

## What is yt-dlp-tauri?

`yt-dlp-tauri` is a small desktop app for downloading videos with `yt-dlp` without writing command-line options by hand. Paste a video URL from a [site supported by yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md), preview the metadata, choose a quality, and download an MP4-friendly file from a focused desktop UI.

The project is desktop-first and local-first. It is not a hosted downloader service, does not provide multi-user accounts, and is not affiliated with `yt-dlp`, FFmpeg, Deno, or Tauri.

## Features

- Parse video metadata through `yt-dlp` and preview title, thumbnail, duration, source URL, description, and quality options.
- Download with live progress, speed, ETA, cancellation, and a saved output folder.
- Use Cookie files for authenticated sites, including Netscape `cookies.txt` and one-line browser Cookie headers.
- Install, update, reinstall, and verify complete app-managed toolchain revisions from Settings.
- Switch between the app-managed toolchain and trusted local tools discovered from `PATH` or selected by absolute path.
- Resolve the stable toolchain from project-controlled immutable GitHub Release assets.
- Stage and verify every tool before atomic activation, preserving the active revision when an update fails.
- Switch the UI between English and Chinese.
- Check GitHub Releases for app updates, with optional `gh-proxy` routing for update and release access.
- Keep local operational logs for recent app activity.

## Tech Stack

| Layer | Choice |
| --- | --- |
| Desktop runtime | Tauri 2 |
| Backend | Rust |
| Frontend | Vanilla TypeScript, Vite |
| UI | Fixed-size product-style desktop interface |
| Toolchain | App-managed or user-selected Windows x64 `yt-dlp`, `ffmpeg`, `ffprobe`, `deno` |
| Installer | Windows x64 NSIS |

## Quick Start

Use Windows for real app builds. WSL can run many checks, while release installers should be built on Windows or by the GitHub Actions release workflow.

### 1. Install prerequisites

- Windows 10/11 x64 with WebView2 Runtime
- Node.js 24+
- Rust stable with the platform toolchain
- PowerShell 5+ or PowerShell 7+ on Windows

### 2. Install dependencies

```powershell
npm ci
```

### 3. Optional: restore development tools

```powershell
.\scripts\download-tools.ps1
```

This is optional for normal app use. If tools are missing, open the app, go to Settings, and click `Install tools`.

### 4. Run the desktop app in development

```powershell
npm run tauri dev
```

### 5. Build the desktop installer

```powershell
npm run tauri build
```

The configured bundle target is `nsis`. Build output is written under:

```text
src-tauri\target\release\bundle\nsis\
```

## Configuration

| Item | Purpose |
| --- | --- |
| `toolchain-policy.json` | Reviewed upstream sources, version-selection rules, targets, and allowed hosts. |
| `toolchain-lock.json` | Generated upstream identity, immutable archive descriptors, and archive/executable SHA-256 hashes. |
| `src-tauri/tools-manifest.json` | Generated runtime revision, project-controlled archive URLs, target names, and executable hashes. |
| `TOOLCHAIN_CHANGELOG.md` | Tool-only revision history, independent from application releases. |
| `src-tauri/tauri.conf.json` | Tauri app metadata, fixed window size, bundle target, icons, and resources. |
| `scripts/download-tools.ps1` | Optional development script that restores the pinned `win-x64` toolchain into the checkout. |
| Settings: output folder | User-facing download directory selection, save, reset, and open actions. |
| Settings: GitHub site | `Direct` or `gh-proxy` mode for update checks and release links. Project home always opens GitHub directly. |
| Settings: tool source | Switch between the verified app-managed revision and trusted local executables. |

Current release scope:

- Supported tool target: `win-x64`.
- Tool binaries are not committed to the repository.

## Local Tool Mode

Settings can switch the complete toolchain between `Managed` and `Local`. Local mode searches the current process `PATH` for `yt-dlp.exe`, `deno.exe`, and one directory containing both `ffmpeg.exe` and `ffprobe.exe`. The path controls can select an absolute yt-dlp executable, FFmpeg directory, or Deno executable when a tool is outside `PATH`. `Use PATH` clears those overrides and resolves all tools from `PATH` again.

Local tools are checked by running their version commands and the same deterministic media compatibility fixture used for managed revisions. The app does not pin hashes, install updates, or replace local executables. Local programs run with the user's permissions; the selected yt-dlp executable receives video URLs and the selected Cookie file, so only trusted binaries should be configured.

## Toolchain Maintenance

The `Toolchain Discovery` workflow resolves yt-dlp, Deno, FFmpeg, and FFprobe once per week and maintains one reviewed `bot/toolchain-weekly` pull request. `Toolchain Freshness` checks released source URLs daily and opens a focused emergency pull request for an affected source. Both workflows require human review before merge.

Merged toolchain changes pass native validation before publication to the separate `yt-dlp-tauri-toolchain` archive. The app follows the `toolchain-stable` channel, while `TOOLCHAIN_CHANGELOG.md` records revisions independently from application releases.

The unified resolver can be inspected locally without changing files:

```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/update-toolchain.mjs --dry-run
```

Source and selection changes belong in `toolchain-policy.json`. The resolver generates the lock, runtime manifest, and toolchain changelog together.

## Data, Storage, and Output

Downloaded videos default to:

```text
%USERPROFILE%\Downloads\yt-dlp-tauri\
```

App state and logs are stored under:

```text
%LOCALAPPDATA%\yt-dlp-tauri\state\
%LOCALAPPDATA%\yt-dlp-tauri\logs\app.log
```

The selected tool source and optional absolute-path overrides are stored in:

```text
%LOCALAPPDATA%\yt-dlp-tauri\state\toolchain-source.txt
%LOCALAPPDATA%\yt-dlp-tauri\state\local-toolchain.json
```

Installed app toolchain revisions are written under:

```text
%LOCALAPPDATA%\yt-dlp-tauri\Tools\win-x64\active.json
%LOCALAPPDATA%\yt-dlp-tauri\Tools\win-x64\revisions\<revision>\
```

The v0.1.11 flat tool directory remains readable until the first revision is successfully activated.

Development checkout tools can live at:

```text
src-tauri\Tools\win-x64\yt-dlp\yt-dlp.exe
src-tauri\Tools\win-x64\ffmpeg\bin\ffmpeg.exe
src-tauri\Tools\win-x64\ffmpeg\bin\ffprobe.exe
src-tauri\Tools\win-x64\deno\deno.exe
```

## Verification

Frontend tests:

```powershell
npm test
```

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

Full Tauri build:

```powershell
npm run tauri build
```

## Documentation

- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Third-party notices](./THIRD-PARTY-NOTICES.md)
- [Toolchain policy](./toolchain-policy.json)
- [Toolchain changelog](./TOOLCHAIN_CHANGELOG.md)
- [Tool manifest](./src-tauri/tools-manifest.json)

## Star History

<a href="https://www.star-history.com/?repos=Chlience%2Fyt-dlp-tauri&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Chlience/yt-dlp-tauri&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Chlience/yt-dlp-tauri&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Chlience/yt-dlp-tauri&type=date&legend=top-left" />
 </picture>
</a>

## Release Checklist

Before publishing a release:

1. Run the verification commands above.
2. Run the `Release` workflow in preflight mode against the exact release commit and verify its clean-install artifact.
3. Push a version tag such as `v0.1.12`.
4. Wait for the `Release` workflow to upload the Windows x64 NSIS installer and `tools-manifest.json` to the draft GitHub Release.
5. Confirm `src-tauri/tools-manifest.json` uses fixed release URLs, not `latest`.
6. Confirm generated folders and restored tools are not staged.
7. Include the GPL license and third-party notices with the release.

## Legal

This project is licensed under GPL-3.0. The app downloads and uses third-party command-line tools with their own licenses and redistribution obligations. See [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

This project is not affiliated with `yt-dlp`, FFmpeg, Deno, or Tauri.
