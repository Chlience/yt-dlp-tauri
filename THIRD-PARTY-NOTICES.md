# Third-Party Notices

`yt-dlp-tauri` can install third-party command-line tools under the app data tool cache, and development checkouts can pre-restore them under `src-tauri/Tools/win-x64`. Tool binaries are not committed to this repository. Those tools keep their own licenses and redistribution obligations.

## yt-dlp

- Bundled file: `src-tauri/Tools/win-x64/yt-dlp/yt-dlp.exe`
- Source: <https://github.com/yt-dlp/yt-dlp>
- Release URL tracked by this project: <https://github.com/yt-dlp/yt-dlp/releases/download/2026.06.09/yt-dlp.exe>
- Notice: yt-dlp itself is Unlicense, but the official PyInstaller executable includes GPLv3+ licensed code and should be treated as GPLv3+ for redistribution.

## FFmpeg / ffprobe

- Bundled files:
  - `src-tauri/Tools/win-x64/ffmpeg/bin/ffmpeg.exe`
  - `src-tauri/Tools/win-x64/ffmpeg/bin/ffprobe.exe`
- Source used by this project: <https://github.com/yt-dlp/FFmpeg-Builds>
- Release URL tracked by this project: <https://github.com/yt-dlp/FFmpeg-Builds/releases/download/autobuild-2026-06-22-18-32/ffmpeg-N-125157-gefa8b20987-win64-gpl.zip>
- Notice: the selected FFmpeg build is the win64 GPL build. Keep the relevant GPL notices and source availability obligations when redistributing.

## Deno

- Bundled file: `src-tauri/Tools/win-x64/deno/deno.exe`
- Source: <https://github.com/denoland/deno>
- Release URL tracked by this project: <https://github.com/denoland/deno/releases/download/v2.7.14/deno-x86_64-pc-windows-msvc.zip>
- Purpose: JavaScript runtime for yt-dlp EJS challenge solver support.

## Updating Bundled Tools

When updating tools, refresh `src-tauri/tools-manifest.json` with target, version, source URL, retrieval time, and SHA-256 hashes. Update `scripts/download-tools.ps1` in the same change.
