# Third-Party Notices

`yt-dlp-tauri` can install third-party command-line tools under the app data tool cache, and development checkouts can pre-restore them under `src-tauri/Tools/win-x64`. Tool binaries are not committed to this repository. Those tools keep their own licenses and redistribution obligations.

## yt-dlp

- Bundled file: `src-tauri/Tools/win-x64/yt-dlp/yt-dlp.exe`
- Source: <https://github.com/yt-dlp/yt-dlp>
- Release tracked by toolchain revision `20260712.1`: `2026.07.04`
- Windows release asset: <https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe>
- Notice: yt-dlp itself is Unlicense, but the official PyInstaller executable includes GPLv3+ licensed code and should be treated as GPLv3+ for redistribution.

## FFmpeg / ffprobe

- Bundled files:
  - `src-tauri/Tools/win-x64/ffmpeg/bin/ffmpeg.exe`
  - `src-tauri/Tools/win-x64/ffmpeg/bin/ffprobe.exe`
- Windows build source: <https://github.com/yt-dlp/FFmpeg-Builds>
- Exact Windows release, asset, and digest: `toolchain-lock.json`
- Exact checksum URL, FFmpeg source commit, build-script commit, and corresponding-source URLs: `ffmpeg-provenance-<revision>.json` in the promoted toolchain release
- Notice: the selected Windows archive is a GPL build. FFmpeg-Builds scripts use their own MIT license. Keep the applicable GPL text, build-script notice, and corresponding-source access with any project mirror.
- Procedure: [`docs/ffmpeg-redistribution.md`](docs/ffmpeg-redistribution.md)

## Deno

- Bundled file: `src-tauri/Tools/win-x64/deno/deno.exe`
- Source: <https://github.com/denoland/deno>
- Release tracked by toolchain revision `20260712.1`: `v2.9.2`
- Windows release asset: <https://github.com/denoland/deno/releases/download/v2.9.2/deno-x86_64-pc-windows-msvc.zip>
- Purpose: JavaScript runtime for yt-dlp EJS challenge solver support.
- License: MIT; the exact upstream text is retained in [`third-party/deno/LICENSE.md`](third-party/deno/LICENSE.md).

## Updating Bundled Tools

Review source and selection changes in `toolchain-policy.json`, then run `scripts/update-toolchain.mjs`. The resolver generates `toolchain-lock.json`, `src-tauri/tools-manifest.json`, and `TOOLCHAIN_CHANGELOG.md` together. `scripts/download-tools.ps1` consumes the generated manifest and contains no pinned release metadata.
