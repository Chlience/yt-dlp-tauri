# macOS GitHub Release Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Windows NSIS and macOS DMG release assets from `v*` Git tags and upload them to a draft GitHub Release.

**Architecture:** The release workflow uses `tauri-apps/tauri-action` with a Windows/macOS matrix. Tauri bundle targets include `nsis` and `dmg`. The Rust backend uses platform-specific tool metadata so macOS builds install and probe non-`.exe` tools.

**Tech Stack:** GitHub Actions, Tauri 2, Rust, Vite, npm, Node test runner.

---

### Task 1: Platform Tool Tests

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write failing tests**

Add tests for macOS target mapping and platform-specific tool filenames:

```rust
assert_eq!(tool_target_from("macos", "x86_64"), Some("macos-x64"));
assert_eq!(tool_target_from("macos", "aarch64"), Some("macos-arm64"));
assert_eq!(tool_target_from("linux", "x86_64"), None);

let macos_tools = tool_names_for_target("macos-arm64").expect("macos tool names");
assert_eq!(macos_tools.yt_dlp, "yt-dlp");
assert_eq!(macos_tools.ffmpeg, "ffmpeg");
assert_eq!(macos_tools.ffprobe, "ffprobe");
assert_eq!(macos_tools.deno, "deno");
```

- [ ] **Step 2: Verify red**

Run: `cargo test --manifest-path ./src-tauri/Cargo.toml --lib`

Expected: compile failure because `tool_names_for_target` does not exist, or assertion failures because macOS targets are not mapped.

### Task 2: Platform Tool Implementation

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Implement platform-aware tool names**

Add a `ToolNames` helper, update `ToolPaths`, `locate_tools`, `check_tools`, and `install_tools` to use platform-specific filenames. Windows keeps `.exe`; macOS uses extensionless binaries.

- [ ] **Step 2: Verify green**

Run: `cargo test --manifest-path ./src-tauri/Cargo.toml --lib`

Expected: all Rust unit tests pass.

### Task 3: macOS Manifest Targets

**Files:**
- Modify: `src-tauri/tools-manifest.json`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add macOS tool targets**

Add `macos-x64` and `macos-arm64` manifest entries for `yt-dlp`, `ffmpeg`, `ffprobe`, and `deno`, using pinned release URLs and SHA-256 hashes.

- [ ] **Step 2: Make extracted tools executable on Unix**

After installing a manifest tool, set Unix executable permissions for installed files.

- [ ] **Step 3: Verify manifest tests**

Run: `cargo test --manifest-path ./src-tauri/Cargo.toml --lib`

Expected: manifest validation tests pass for all manifest tool entries.

### Task 4: Bundle Config and GitHub Release Workflow

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Add DMG bundle target**

Change bundle targets to `["nsis", "dmg"]`.

- [ ] **Step 2: Add tag-triggered draft release workflow**

Create a workflow triggered by `v*` tags and `workflow_dispatch`. Use `windows-latest`, `macos-latest` with `x86_64-apple-darwin`, and `macos-latest` with `aarch64-apple-darwin`. Use `tauri-apps/tauri-action@v1`, `releaseDraft: true`, and `tagName: ${{ github.ref_name }}`.

### Task 5: Docs and Verification

**Files:**
- Modify: `README.md`
- Modify: `README_zh.md`

- [ ] **Step 1: Document release tags**

Update packaging docs to say release packaging is produced by pushing `v*` tags.

- [ ] **Step 2: Verify locally**

Run:

```bash
npm test
npm run build
cargo test --manifest-path ./src-tauri/Cargo.toml --lib
cargo check --manifest-path ./src-tauri/Cargo.toml
```

Expected: all commands exit 0. macOS DMG creation is verified by GitHub Actions on macOS runners.

