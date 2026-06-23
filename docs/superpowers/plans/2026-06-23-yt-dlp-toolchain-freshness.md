# yt-dlp Toolchain Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the app-managed `yt-dlp` toolchain current enough for extractor changes while preserving fixed URLs and SHA-256 verification.

**Architecture:** Update the pinned `yt-dlp` release in the manifest and development restore script. Improve process failure reporting so `ERROR:` lines are surfaced ahead of age warnings. Add a CI-friendly script that compares the checked-in manifest against the latest upstream `yt-dlp` release and fails when the pinned version is stale.

**Tech Stack:** Rust/Tauri backend tests, JSON tool manifest, PowerShell restore script, Node.js maintenance script, GitHub Actions.

---

### Task 1: Prefer Real yt-dlp Errors Over Warnings

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [x] Add a failing Rust unit test showing that `process_failure_message` prefers an `ERROR:` line over an earlier `WARNING:` line.
- [ ] Run `cargo test --manifest-path ./src-tauri/Cargo.toml --lib process_failure_message_prefers_error_lines_over_warnings` and confirm it fails.
- [x] Update the stderr/stdout detail selection helper to choose the first `ERROR:` line, then the first non-warning line, then the first non-empty line.
- [ ] Re-run the targeted Rust test and confirm it passes.

### Task 2: Update Pinned yt-dlp Assets

**Files:**
- Modify: `src-tauri/tools-manifest.json`
- Modify: `scripts/download-tools.ps1`

- [x] Replace `yt-dlp` `2026.03.17` URLs and SHA-256 hashes with `2026.06.09` assets for `win-x64`, `macos-x64`, and `macos-arm64`.
- [x] Update the Windows development restore script to the same `yt-dlp.exe` URL and hash.
- [x] Keep fixed release URLs; do not use `latest` URLs.

### Task 3: Add Upstream Freshness Check

**Files:**
- Create: `scripts/check-yt-dlp-release.mjs`
- Create: `.github/workflows/toolchain-freshness.yml`

- [x] Add a Node.js script that reads `src-tauri/tools-manifest.json`, fetches the latest `yt-dlp/yt-dlp` release from GitHub, and compares the manifest version plus target asset hashes.
- [x] Make the script support a fixture mode for deterministic tests.
- [x] Add a GitHub Actions workflow running the script on a schedule and on manual dispatch.
- [x] Add focused Node tests for current and stale manifest scenarios.

### Task 4: Verification

- [x] Run `npm test`.
- [ ] Run `cargo test --manifest-path ./src-tauri/Cargo.toml --lib`.
- [x] Run `npm run build`.
- [ ] Run `cargo check --manifest-path ./src-tauri/Cargo.toml`.

Rust verification is blocked in this workspace by the configured Cargo registry mirror returning TLS EOF errors while fetching `tauri-plugin-opener`.
