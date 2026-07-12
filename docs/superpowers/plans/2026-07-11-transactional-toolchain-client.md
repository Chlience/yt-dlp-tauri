# Transactional Toolchain Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the desktop client to the independent `toolchain-stable` channel and install toolchain revisions transactionally so failed updates leave the current tools usable.

**Architecture:** The Rust backend parses the atomic channel record, verifies the immutable manifest digest, and stages tools under revision-specific directories. A platform-specific atomic state-file replacement activates a fully verified revision. Existing flat tool directories and the latest application-release manifest remain compatibility fallbacks during migration.

**Tech Stack:** Rust 2021, Tauri 2 commands/events, reqwest/rustls, serde/serde_json, sha2, Windows `ReplaceFileW`, vanilla TypeScript, Node.js tests.

## Global Constraints

- This plan starts after the `toolchain-stable` prerelease and immutable revision manifest format exist.
- One application migration release is allowed; later tool revisions cannot require application version changes.
- The client fetches the fixed `toolchain-stable` tag and never chooses upstream tool releases.
- The client verifies the channel record, immutable manifest SHA-256, manifest schema, and monotonic revision.
- Install, update, and reinstall stage and verify all tools before activation.
- A failed fetch, download, extraction, hash, or smoke probe leaves the active toolchain unchanged.
- Keep the previous active revision available for fallback.
- Existing v0.1.11 flat tool directories remain readable until the first successful revision activation.
- Keep `retrievedAtUtc` compatibility while adding schema version 3 `revision`.
- Preserve direct and `gh-proxy` GitHub access modes.
- Do not show recurring release-note or update dialogs when the application version is unchanged.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src-tauri/src/toolchain/channel.rs` | Parse release-body channel record and select manifest asset |
| `src-tauri/src/toolchain/activation.rs` | Revision paths, active state, and atomic state replacement |
| `src-tauri/src/toolchain/install.rs` | Stage, verify, smoke, and activate a complete revision |
| `src-tauri/src/toolchain/mod.rs` | Public runtime toolchain interfaces |
| `src-tauri/src/lib.rs` | Tauri command adapter and legacy migration |
| `src/toolchain.ts` | Frontend manifest/revision types and summaries |
| `src/main.ts` | Stable-channel checks and install/update flow |
| `tests/toolchain.test.ts` | Frontend revision and action behavior |
| `tests/toolchain-channel-ui.test.ts` | Stable-channel copy and request contracts |

### Task 1: Make the Client Consume Manifest Revisions

**Files:**
- Modify: `src-tauri/src/toolchain/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `ToolsManifest { schema_version, revision, retrieved_at_utc, targets }`
- Produces: `ToolchainRevision::parse(&str) -> Result<ToolchainRevision, String>`

- [ ] **Step 1: Add failing Rust revision tests**

```rust
#[test]
fn parses_and_orders_toolchain_revisions() {
    let older = ToolchainRevision::parse("20260711.1").unwrap();
    let newer = ToolchainRevision::parse("20260711.2").unwrap();
    let next_day = ToolchainRevision::parse("20260712.1").unwrap();
    assert!(older < newer);
    assert!(newer < next_day);
    assert!(ToolchainRevision::parse("v20260711.1").is_err());
    assert!(ToolchainRevision::parse("20260711.0").is_err());
}

#[test]
fn schema_three_manifest_requires_revision() {
    let json = r#"{"schemaVersion":3,"retrievedAtUtc":"2026-07-11T00:00:00Z","targets":[]}"#;
    assert!(manifest_from_json(json).unwrap_err().contains("revision"));
}
```

- [ ] **Step 2: Run targeted tests and confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib toolchain_revision`

Expected: FAIL because `ToolchainRevision` and the revision field are missing.

- [ ] **Step 3: Implement strict revision parsing**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ToolchainRevision {
    date: u32,
    sequence: u32,
}

impl ToolchainRevision {
    pub fn parse(value: &str) -> Result<Self, String> {
        let (date, sequence) = value.split_once('.')
            .ok_or_else(|| format!("Invalid toolchain revision: {value}"))?;
        if date.len() != 8 || !date.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!("Invalid toolchain revision date: {value}"));
        }
        let date = date.parse::<u32>().map_err(|error| error.to_string())?;
        let sequence = sequence.parse::<u32>().map_err(|error| error.to_string())?;
        if sequence == 0 {
            return Err(format!("Invalid toolchain revision sequence: {value}"));
        }
        Ok(Self { date, sequence })
    }
}
```

Schema 2 manifests continue to use `retrievedAtUtc` ordering. The candidate automation plan already generates schema 3 manifests; this task makes the Rust client require and compare their `revision` field.

- [ ] **Step 4: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all tests pass.

- [ ] **Step 5: Commit manifest revisions**

```bash
git add src-tauri/src/toolchain/mod.rs src-tauri/src/lib.rs
git commit -m "feat: add toolchain manifest revisions" -m "feat: 添加工具链清单版本"
```

### Task 2: Parse and Verify the Stable Channel

**Files:**
- Create: `src-tauri/src/toolchain/channel.rs`
- Modify: `src-tauri/src/toolchain/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `parse_channel_record(body: &str) -> Result<ChannelRecord, String>`
- Produces: `find_channel_manifest_asset(payload: &Value, record: &ChannelRecord) -> Result<String, String>`
- Produces: `fetch_stable_manifest(mode: &str) -> Result<ResolvedToolManifest, String>`

- [ ] **Step 1: Add failing channel parsing tests**

```rust
#[test]
fn parses_one_channel_marker_and_rejects_duplicates() {
    let body = r#"# Stable
<!-- toolchain-channel
{"schemaVersion":1,"revision":"20260711.1","manifest":"tools-manifest-20260711.1.json","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
-->"#;
    let record = parse_channel_record(body).unwrap();
    assert_eq!(record.revision, "20260711.1");
    assert!(parse_channel_record(&format!("{body}\n{body}")).is_err());
}

#[test]
fn manifest_bytes_must_match_channel_digest() {
    let record = ChannelRecord {
        schema_version: 1,
        revision: "20260711.1".to_string(),
        manifest: "tools-manifest-20260711.1.json".to_string(),
        sha256: "a".repeat(64),
    };
    assert!(verify_channel_manifest(&record, b"wrong").is_err());
}
```

- [ ] **Step 2: Run channel tests and confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib channel_`

Expected: FAIL because `channel.rs` is missing.

- [ ] **Step 3: Implement marker, asset, and digest validation**

Require one marker, JSON schema `1`, revision format from Task 1, matching versioned manifest filename, 64 lowercase hex digest, and an exact asset-name match. Reject duplicate assets and unexpected final download hosts.

- [ ] **Step 4: Fetch the fixed prerelease by tag**

Replace the tool-manifest endpoint with:

```rust
const TOOLCHAIN_RELEASE_API_URL: &str =
    "https://api.github.com/repos/Chlience/yt-dlp-tauri/releases/tags/toolchain-stable";
```

Fetch release JSON, parse the record, download the named immutable asset, verify its digest, parse the manifest, and require the channel revision to equal the manifest revision. Route both GitHub API and browser download URLs through the selected direct or `gh-proxy` mode using the existing backend resolver.

- [ ] **Step 5: Add compatibility fallback tests**

When the stable tag returns 404, fetch the latest normal application release and its `tools-manifest.json` asset. A network or validation error from an existing stable tag remains an error and cannot silently fall back.

- [ ] **Step 6: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all tests pass.

- [ ] **Step 7: Commit stable channel support**

```bash
git add src-tauri/src/toolchain/channel.rs src-tauri/src/toolchain/mod.rs src-tauri/src/lib.rs
git commit -m "feat: verify the stable toolchain channel" -m "feat: 验证稳定工具链通道"
```

### Task 3: Define Revision Storage and Atomic Active State

**Files:**
- Create: `src-tauri/src/toolchain/activation.rs`
- Modify: `src-tauri/src/toolchain/mod.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**
- Produces: `revision_root(base, target, revision): PathBuf`
- Produces: `read_active_state(base, target): Result<Option<ActiveToolchainState>, String>`
- Produces: `activate_revision(base, state): Result<(), String>`
- Produces: `active_tool_paths(base, target): Result<Option<ToolPaths>, String>`

- [ ] **Step 1: Add failing path and state tests**

```rust
#[test]
fn revision_paths_are_target_scoped() {
    let base = Path::new("/app-data");
    let revision = ToolchainRevision::parse("20260711.1").unwrap();
    assert_eq!(
        revision_root(base, "win-x64", revision),
        base.join("Tools/win-x64/revisions/20260711.1"),
    );
}

#[test]
fn invalid_active_state_does_not_select_a_revision() {
    let root = tempdir().unwrap();
    fs::create_dir_all(root.path().join("state")).unwrap();
    fs::write(root.path().join("state/active-toolchain-win-x64.json"), "{broken").unwrap();
    assert!(read_active_state(root.path(), "win-x64").is_err());
}
```

- [ ] **Step 2: Confirm activation tests fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib active_state`

Expected: FAIL because `activation.rs` is missing.

- [ ] **Step 3: Add platform atomic replacement support**

For Windows add:

```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.61", features = ["Win32_Foundation", "Win32_Storage_FileSystem"] }
```

Write the new state to a sibling temporary file, flush and `sync_all`, then use `ReplaceFileW` when the destination exists or `MoveFileExW` with replace/write-through flags when it does not. On Unix, `rename` the synced temporary file over the destination and sync the parent directory.

- [ ] **Step 4: Implement active state validation**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveToolchainState {
    pub schema_version: u32,
    pub target: String,
    pub revision: String,
    pub manifest_sha256: String,
    pub activated_at_unix: u64,
    pub previous_revision: Option<String>,
}
```

Require schema `1`, matching target, valid revision, valid digest, and an existing revision directory with `revision-complete.json`. The completion marker uses schema `1` and repeats `target`, `revision`, and `manifestSha256`; every value must match active state.

- [ ] **Step 5: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all tests pass.

- [ ] **Step 6: Commit revision activation**

```bash
git add src-tauri/src/toolchain/activation.rs src-tauri/src/toolchain/mod.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: activate toolchain revisions atomically" -m "feat: 原子激活工具链版本"
```

### Task 4: Stage Complete Revisions Before Activation

**Files:**
- Modify: `src-tauri/src/toolchain/install.rs`
- Modify: `src-tauri/src/toolchain/probe.rs`
- Modify: `src-tauri/src/toolchain/activation.rs`

**Interfaces:**
- Produces: `stage_and_activate(request: StageToolchainRequest<'_>) -> Result<ToolPaths, String>`
- Consumes: parsed schema 3 manifest and `ProgressReporter`

- [ ] **Step 1: Add a failing activation-safety test**

```rust
#[test]
fn failed_staging_preserves_the_active_revision() {
    let fixture = ActivationFixture::with_active_revision("20260710.1");
    let result = stage_and_activate(fixture.request_with_failing_hash("20260711.1"));
    assert!(result.is_err());
    assert_eq!(fixture.active_revision(), "20260710.1");
    assert!(!fixture.revision_path("20260711.1").exists());
}
```

- [ ] **Step 2: Run the targeted test and confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib failed_staging_preserves_the_active_revision`

Expected: FAIL because staging still installs into the active flat root.

- [ ] **Step 3: Implement staged installation**

Create `.staging-{revision}-{unix timestamp}` beside `revisions/`. Download, extract, hash, mark executable, run version probes, and write `revision-complete.json` inside staging. Rename staging to the immutable revision directory only after all checks pass.

- [ ] **Step 4: Activate only complete revisions**

Compute the manifest digest from the exact bytes fetched from the channel. Atomically update active state after the revision directory rename. Save the active manifest only after state activation. On every error, remove staging and leave active state unchanged.

- [ ] **Step 5: Retain current and previous revisions**

After successful activation, retain the new active revision and `previous_revision`. Remove only older revision directories whose names parse correctly and are not referenced by active state. Never remove legacy flat paths in this task.

- [ ] **Step 6: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all tests pass.

- [ ] **Step 7: Commit transactional staging**

```bash
git add src-tauri/src/toolchain/install.rs src-tauri/src/toolchain/probe.rs src-tauri/src/toolchain/activation.rs
git commit -m "feat: stage toolchains before activation" -m "feat: 激活前暂存完整工具链"
```

### Task 5: Migrate Tool Lookup Without Breaking Legacy Installs

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/toolchain/activation.rs`

**Interfaces:**
- Produces: `locate_managed_tools(base, target): Result<Option<ToolPaths>, String>`
- Preserves: current bundled, executable-adjacent, checkout, and current-directory fallbacks

- [ ] **Step 1: Add failing lookup precedence tests**

```rust
#[test]
fn active_revision_precedes_legacy_flat_tools() {
    let fixture = LookupFixture::new();
    fixture.create_legacy_tools();
    fixture.create_active_revision("20260711.1");
    assert!(fixture.locate().yt_dlp.starts_with(fixture.revision_path("20260711.1")));
}

#[test]
fn legacy_tools_remain_available_without_active_state() {
    let fixture = LookupFixture::new();
    fixture.create_legacy_tools();
    assert_eq!(fixture.locate().root, fixture.legacy_root());
}
```

- [ ] **Step 2: Confirm precedence tests fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib active_revision_precedes_legacy_flat_tools`

Expected: FAIL because `locate_tools` checks the flat writable root first.

- [ ] **Step 3: Implement lookup precedence**

Check valid active state first. If state is missing, use the existing legacy root search unchanged. If state exists but is invalid or incomplete, return an actionable error and do not silently select an unrelated directory.

- [ ] **Step 4: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all tests pass.

- [ ] **Step 5: Commit migration lookup**

```bash
git add src-tauri/src/lib.rs src-tauri/src/toolchain/activation.rs
git commit -m "feat: migrate managed toolchain lookup" -m "feat: 迁移受管工具链查找"
```

### Task 6: Make Install, Update, and Reinstall Transactional

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/main.ts`
- Modify: `src/toolchain.ts`
- Modify: `tests/toolchain.test.ts`

**Interfaces:**
- Changes command: `install_tools(app, github_access_mode) -> Vec<ToolStatus>`
- Preserves command: `install_tools_from_manifest(app, manifest_json) -> Vec<ToolStatus>`
- Changes command: `reinstall_tools(app, manifest_json, github_access_mode) -> Vec<ToolStatus>`

- [ ] **Step 1: Add failing frontend call-contract tests**

```ts
test("install and reinstall pass GitHub access mode", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(source, /invoke<ToolStatus\[]>\("install_tools", \{ githubAccessMode: state\.githubAccessMode \}\)/);
  assert.match(source, /invoke<ToolStatus\[]>\("reinstall_tools", \{ manifestJson: null, githubAccessMode: state\.githubAccessMode \}\)/);
});
```

- [ ] **Step 2: Confirm contract tests fail**

Run: `node --test --experimental-strip-types tests/toolchain.test.ts`

Expected: FAIL because install commands do not pass access mode.

- [ ] **Step 3: Update backend command behavior**

Initial install fetches the stable channel first. A 404 stable channel uses the application-release compatibility manifest. A network failure may use a valid cached active manifest or bundled manifest and must surface that fallback in the result. Reinstall follows the same staged path and never calls `remove_managed_toolchain` before successful activation.

- [ ] **Step 4: Update frontend behavior**

Preserve the existing Install, Update, and Reinstall actions. Include GitHub access mode in backend calls. Keep update availability explicit in Settings and do not automatically install tools on startup.

- [ ] **Step 5: Run frontend and Rust tests**

Run: `npm test`

Expected: all Node tests pass.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all Rust tests pass.

- [ ] **Step 6: Commit transactional commands**

```bash
git add src-tauri/src/lib.rs src/main.ts src/toolchain.ts tests/toolchain.test.ts
git commit -m "feat: make tool actions transactional" -m "feat: 让工具操作具备事务性"
```

### Task 7: Expose Toolchain Revision Status Without Repeated Notices

**Files:**
- Modify: `src/toolchain.ts`
- Modify: `src/main.ts`
- Modify: `index.html`
- Create: `tests/toolchain-channel-ui.test.ts`

**Interfaces:**
- Adds: `toolchain_revision: Option<String>` to Rust `AppState`
- Adds: `toolchain_revision?: string` to TypeScript `AppState`
- Preserves: release notes keyed only by application version

- [ ] **Step 1: Add failing UI behavior tests**

```ts
test("toolchain revision does not trigger application release notes", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(source, /maybeShowReleaseNotesAfterUpdate\(\)/);
  assert.doesNotMatch(source, /toolchainRevision.*showReleaseNotes/);
});

test("Settings exposes active toolchain revision", () => {
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /id="toolchain-revision"/);
});
```

- [ ] **Step 2: Confirm UI tests fail**

Run: `node --test --experimental-strip-types tests/toolchain-channel-ui.test.ts`

Expected: FAIL because the revision element is missing.

- [ ] **Step 3: Render revision as quiet Settings metadata**

Show the active revision beside the tool root using existing compact metadata styling. Update checks may use the existing toast system when a newer revision is available. Do not open release notes, dialogs, or recurring notices for unchanged revisions.

- [ ] **Step 4: Run frontend tests and build**

Run: `npm test`

Expected: all tests pass.

Run: `npm run build`

Expected: Vite production build succeeds.

- [ ] **Step 5: Commit revision UI**

```bash
git add src/toolchain.ts src/main.ts index.html tests/toolchain-channel-ui.test.ts
git commit -m "feat: show the active toolchain revision" -m "feat: 显示当前工具链版本"
```

### Task 8: Add Migration and Failure Regression Coverage

**Files:**
- Modify: `src-tauri/src/toolchain/activation.rs`
- Modify: `src-tauri/src/toolchain/install.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `tests/toolchain.test.ts`

**Interfaces:**
- Verifies legacy migration, failed staging, active-state corruption, stable-channel fallback, and previous-revision retention

- [ ] **Step 1: Add table-driven Rust regression tests**

Cover these exact cases:

```text
legacy tools + no active state -> legacy tools selected
legacy tools + successful update -> new revision selected, legacy untouched
active revision + HTTP 404 -> active revision unchanged
active revision + hash mismatch -> active revision unchanged
active revision + executable probe failure -> active revision unchanged
active revision + successful update -> new active, old previous
corrupt active state -> actionable error, no arbitrary fallback
stable tag 404 -> latest application release compatibility manifest
stable tag malformed -> error, no compatibility downgrade
```

- [ ] **Step 2: Run tests and confirm any uncovered cases fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib toolchain`

Expected: newly added cases fail until their boundaries are complete.

- [ ] **Step 3: Implement only the missing behaviors identified by the tests**

Keep changes inside activation, install, channel, and command adapters. Do not add new UI actions.

- [ ] **Step 4: Run complete verification**

Run: `npm test`

Expected: all Node tests pass.

Run: `npm run build`

Expected: Vite production build succeeds.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib --bins --tests`

Expected: all Rust tests pass.

Run: `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`

Expected: exit `0`.

- [ ] **Step 5: Commit migration regressions**

```bash
git add src-tauri/src/toolchain src-tauri/src/lib.rs tests/toolchain.test.ts
git commit -m "test: cover transactional toolchain migration" -m "test: 覆盖事务式工具链迁移"
```

### Task 9: Prepare the One-Time Application Migration Release

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `README_zh.md`

**Interfaces:**
- Produces application version `0.1.12`
- Documents that later toolchain revisions use the independent channel

- [ ] **Step 1: Add release notes in both languages**

Document the stable toolchain channel, transactional install, active revision display, and legacy migration. Keep tool version details in `TOOLCHAIN_CHANGELOG.md`.

- [ ] **Step 2: Set every application version field to `0.1.12`**

Update npm package files, Cargo package files, and Tauri config in one change. Do not create a tag in this task.

- [ ] **Step 3: Verify release-note extraction**

Run: `node .github/scripts/extract-release-notes.mjs --version v0.1.12 --output /tmp/yt-dlp-tauri-v0.1.12-notes.md`

Expected: bilingual release notes are extracted successfully.

- [ ] **Step 4: Run full repository verification**

Run: `npm test`

Expected: all tests pass.

Run: `npm run build`

Expected: Vite production build succeeds.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib --bins --tests`

Expected: all Rust tests pass.

Run: `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`

Expected: exit `0`.

- [ ] **Step 5: Commit the migration version**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md README.md README_zh.md
git commit -m "chore: prepare the 0.1.12 toolchain migration" -m "chore: 准备 0.1.12 工具链迁移版本"
```

### Task 10: Native End-to-End Acceptance

**Files:**
- No source changes expected

**Interfaces:**
- Consumes published `toolchain-stable` and migration build artifacts
- Produces acceptance evidence on all supported targets

- [ ] **Step 1: Run local checks**

Run: `git diff --check`

Expected: no output.

Run: `git status --short`

Expected: no uncommitted implementation files.

- [ ] **Step 2: Run CI and toolchain validation on the migration commit**

Push only after explicit user authorization, then watch both `CI` and `Toolchain Validation` for the exact commit.

Expected: frontend, Rust, Windows x64, macOS Intel, macOS ARM64, and deterministic DASH checks all succeed.

- [ ] **Step 3: Exercise a clean install on each native artifact**

For each platform, start with no managed tools, install from `toolchain-stable`, verify the displayed revision, parse local test media, and complete the deterministic download/merge test.

Expected: all tools are available and the active state references the promoted revision.

- [ ] **Step 4: Exercise failed-update preservation**

Use a test manifest with one intentionally incorrect executable hash in a temporary test data root. Start update and confirm the app reports the hash failure while the previous active revision still parses and downloads the local fixture.

- [ ] **Step 5: Exercise server-side rollback**

Promote a previously validated revision through the dry-run rollback workflow, then perform the real rollback only with explicit user authorization. Check for updates in the app and confirm it stages and activates the promoted revision without changing application version.

- [ ] **Step 6: Record release readiness**

Report exact CI run URLs, validation run URL, stable revision, installer artifact names, clean-install results, failed-update result, and rollback result. Tagging and publishing v0.1.12 remain separate user-authorized operations.
