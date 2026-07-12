# Toolchain Archive Client Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop client consume the archive repository's schema-v2 stable channel and activate complete toolchain revisions transactionally while preserving the current working revision on every failure.

**Architecture:** The Rust backend parses one strict channel marker, resolves the named immutable revision release and manifest asset, verifies release identity plus manifest bytes, and stages all target tools in a revision directory. Activation atomically replaces a small state file only after archive/member hashes and executable probes pass; lookup prefers the active revision and falls back to legacy flat tools until first activation.

**Tech Stack:** Rust 2021, Tauri 2, reqwest/rustls, serde/serde_json, sha2, Windows `ReplaceFileW`/`MoveFileExW`, vanilla TypeScript, Node.js tests.

## Global Constraints

- Stable API endpoint is `GET /repos/Chlience/yt-dlp-tauri-toolchain/releases/tags/toolchain-stable`.
- Channel schema is exactly 2 and includes repository, revision, release tag, manifest name, and manifest SHA-256.
- Revision release must be published, non-draft, match the channel tag, and report `immutable=true`.
- Manifest asset selection is exact by name and unique.
- Manifest bytes must match channel SHA-256 before JSON parsing.
- Every runtime tool URL must point to the archive repository and its descriptor release tag.
- Install, update, and reinstall use one staging/verification/activation transaction.
- Failure leaves active state and current tools unchanged.
- Previous active revision is retained.
- Legacy v0.1.11 flat tool directories remain readable until a revision is activated.
- Direct and `gh-proxy` access modes remain supported.
- Routine tool revisions do not trigger application release notes.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src-tauri/src/toolchain/channel.rs` | Parse schema-v2 marker, validate releases/assets, and verify manifest bytes |
| `src-tauri/src/toolchain/activation.rs` | Revision paths, active state validation, and atomic replacement |
| `src-tauri/src/toolchain/install.rs` | Stage a complete revision and return verified paths without mutating active state |
| `src-tauri/src/toolchain/probe.rs` | Required executable and combined smoke probes before activation |
| `src-tauri/src/toolchain/mod.rs` | Public channel, revision, activation, and installer types |
| `src-tauri/src/lib.rs` | Tauri commands, fetch flow, legacy fallback, and activation adapter |
| `src/toolchain.ts` | Frontend manifest result and revision-aware action types |
| `src/main.ts` | Stable check, install/update/reinstall orchestration, and toast errors |
| `tests/toolchain.test.ts` | Frontend channel and action behavior |
| `tests/toolchain-channel-ui.test.ts` | Endpoint/copy/command integration contracts |
| `src-tauri/tests/toolchain_smoke_cli.rs` | Revision staging compatibility coverage |

### Task 1: Parse and Order Toolchain Revisions

**Files:**
- Modify: `src-tauri/src/toolchain/mod.rs`

**Interfaces:**
- Produces: `ToolchainRevision::parse(&str) -> Result<ToolchainRevision, String>`
- Produces: total ordering by date and positive sequence

- [ ] **Step 1: Add failing revision tests**

```rust
#[test]
fn parses_and_orders_toolchain_revisions() {
    let older = ToolchainRevision::parse("20260711.2").unwrap();
    let newer = ToolchainRevision::parse("20260712.1").unwrap();
    assert!(older < newer);
    assert!(ToolchainRevision::parse("20260712.0").is_err());
    assert!(ToolchainRevision::parse("v20260712.1").is_err());
    assert!(ToolchainRevision::parse("20261301.1").is_err());
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib parses_and_orders_toolchain_revisions`

Expected: FAIL because `ToolchainRevision` is undefined.

- [ ] **Step 3: Implement strict calendar parsing and display**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ToolchainRevision {
    date: u32,
    sequence: u32,
}

impl ToolchainRevision {
    pub fn parse(value: &str) -> Result<Self, String> {
        let (date_text, sequence_text) = value
            .split_once('.')
            .ok_or_else(|| format!("Invalid toolchain revision: {value}"))?;
        validate_yyyymmdd(date_text)?;
        let sequence = sequence_text
            .parse::<u32>()
            .map_err(|_| format!("Invalid toolchain revision sequence: {value}"))?;
        if sequence == 0 || sequence_text.starts_with('0') {
            return Err(format!("Invalid toolchain revision sequence: {value}"));
        }
        Ok(Self { date: date_text.parse().unwrap(), sequence })
    }
}
```

- [ ] **Step 4: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all Rust library tests pass.

- [ ] **Step 5: Commit revision parsing**

```bash
git add src-tauri/src/toolchain/mod.rs
git commit -m "feat: parse ordered toolchain revisions" -m "feat: 解析可排序的工具链版本"
```

### Task 2: Verify the Archive Stable Channel

**Files:**
- Create: `src-tauri/src/toolchain/channel.rs`
- Modify: `src-tauri/src/toolchain/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `parse_channel_record(body: &str) -> Result<ChannelRecord, String>`
- Produces: `select_revision_manifest_asset(release, record) -> Result<ReleaseAsset, String>`
- Produces: `verify_channel_manifest(record, bytes) -> Result<ToolsManifest, String>`
- Produces: `fetch_stable_manifest(mode) -> Result<ResolvedToolManifest, String>`

- [ ] **Step 1: Add failing schema-v2 channel tests**

```rust
#[test]
fn parses_one_schema_two_channel_record() {
    let body = r#"<!-- toolchain-channel
{"schemaVersion":2,"repository":"Chlience/yt-dlp-tauri-toolchain","revision":"20260712.1","releaseTag":"toolchain-20260712.1","manifest":"tools-manifest-20260712.1.json","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
-->"#;
    let record = parse_channel_record(body).unwrap();
    assert_eq!(record.release_tag, "toolchain-20260712.1");
    assert!(parse_channel_record(&format!("{body}\n{body}")).is_err());
}

#[test]
fn rejects_channel_repository_or_release_mismatch() {
    assert!(parse_channel_record(&channel_with_repository("someone/else")).is_err());
    assert!(parse_channel_record(&channel_with_release_tag("toolchain-20260711.1")).is_err());
}
```

- [ ] **Step 2: Run channel tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib channel_`

Expected: FAIL because `channel.rs` is missing.

- [ ] **Step 3: Implement marker and record validation**

Require exactly one marker, one-line JSON, exact six fields, no unknown fields, schema 2, configured repository, valid revision, `releaseTag == toolchain-<revision>`, `manifest == tools-manifest-<revision>.json`, and lowercase 64-character SHA-256.

- [ ] **Step 4: Fetch channel, revision release, and manifest**

```rust
const TOOLCHAIN_STABLE_API_URL: &str =
    "https://api.github.com/repos/Chlience/yt-dlp-tauri-toolchain/releases/tags/toolchain-stable";
```

Fetch stable release JSON, parse its body, fetch the exact revision release by tag, require `draft=false`, matching `tag_name`, and `immutable=true`, select exactly one named manifest asset, require positive size and GitHub archive download URL, download bytes, verify SHA-256, parse schema 4, and require matching revision.

- [ ] **Step 5: Preserve the v0.1.11 fallback boundary**

When `toolchain-stable` returns 404, query the latest normal application release and its `tools-manifest.json` compatibility asset. Existing stable-channel validation failures remain visible errors and do not fall back silently.

- [ ] **Step 6: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all Rust tests pass, including mock HTTP response fixtures for channel, revision, digest mismatch, duplicate asset, mutable revision, and 404 compatibility fallback.

- [ ] **Step 7: Commit archive channel verification**

```bash
git add src-tauri/src/toolchain/channel.rs src-tauri/src/toolchain/mod.rs src-tauri/src/lib.rs
git commit -m "feat: verify the archived stable toolchain channel" -m "feat: 验证归档稳定工具链通道"
```

### Task 3: Define Revision Storage and Active State

**Files:**
- Create: `src-tauri/src/toolchain/activation.rs`
- Modify: `src-tauri/src/toolchain/mod.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**
- Produces: `revision_root(base, target, revision) -> PathBuf`
- Produces: `read_active_state(base, target) -> Result<Option<ActiveToolchainState>, String>`
- Produces: `activate_revision(base, state) -> Result<(), String>`
- Produces: `active_tool_paths(base, target) -> Result<Option<ToolPaths>, String>`

- [ ] **Step 1: Add failing path and invalid-state tests**

```rust
#[test]
fn revision_storage_is_target_scoped() {
    assert_eq!(
        revision_root(Path::new("/data"), "win-x64", "20260712.1").unwrap(),
        Path::new("/data/Tools/win-x64/revisions/20260712.1"),
    );
}

#[test]
fn invalid_active_state_never_selects_partial_tools() {
    let root = tempdir().unwrap();
    fs::write(active_state_path(root.path(), "win-x64"), "{broken").unwrap();
    assert!(read_active_state(root.path(), "win-x64").is_err());
}
```

- [ ] **Step 2: Run activation tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib active_state`

Expected: FAIL because activation storage is missing.

- [ ] **Step 3: Add strict active state**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveToolchainState {
    pub schema_version: u32,
    pub target: String,
    pub revision: String,
    pub manifest_sha256: String,
    pub previous_revision: Option<String>,
    pub activated_at_unix: u64,
}
```

Validate schema 1, supported target, revision, digest, and that the selected revision directory contains every manifest path before returning active paths.

- [ ] **Step 4: Implement durable atomic replacement**

Write a sibling temporary JSON file, flush and `sync_all`. On Unix rename over the state file and sync its parent. On Windows use `ReplaceFileW` for an existing state and `MoveFileExW` with replace/write-through flags for first activation. Remove a temporary state file after any failed call.

- [ ] **Step 5: Run activation and Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all tests pass, including replacement failure preserving the original state.

- [ ] **Step 6: Commit revision activation state**

```bash
git add src-tauri/src/toolchain/activation.rs src-tauri/src/toolchain/mod.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: add atomic toolchain revision activation" -m "feat: 添加工具链版本原子激活"
```

### Task 4: Stage and Verify Complete Revisions

**Files:**
- Modify: `src-tauri/src/toolchain/install.rs`
- Modify: `src-tauri/src/toolchain/probe.rs`
- Modify: `src-tauri/src/toolchain/mod.rs`

**Interfaces:**
- Produces: `stage_target_revision(request) -> Result<StagedToolchain, String>`
- Produces: `verify_staged_toolchain(staged, target) -> Result<ToolPaths, String>`
- Leaves active state unchanged

- [ ] **Step 1: Add a failing transaction preservation test**

```rust
#[test]
fn failed_staging_preserves_active_revision_and_tools() {
    let fixture = active_revision_fixture("20260711.2");
    let result = stage_target_revision(failing_download_request(&fixture));
    assert!(result.is_err());
    assert_eq!(read_active_state(fixture.base(), "win-x64").unwrap().unwrap().revision, "20260711.2");
    assert_eq!(fs::read(fixture.active_yt_dlp()).unwrap(), b"working");
}
```

- [ ] **Step 2: Run installer transaction tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib failed_staging_preserves`

Expected: FAIL because installation currently mutates the active root directly.

- [ ] **Step 3: Stage under a unique revision sibling**

Use `revisions/.staging-<revision>-<nonce>`, install all files through the shared source/archive verifier, run extracted hashes, mark executables, and require every manifest member before moving the directory to `revisions/<revision>`. Existing completed matching revision directories may be reused only after full verification.

- [ ] **Step 4: Run executable and combination probes before activation**

Probe yt-dlp, Deno, FFmpeg, and FFprobe versions from staged paths. Run a bounded local yt-dlp/FFmpeg integration smoke matching the native validation command. Reject a staged revision before state mutation when any probe fails.

- [ ] **Step 5: Clean failed staging only**

Remove only the unique staging directory and temporary downloads created by the current transaction. Keep the active and previous revision directories untouched. This deletion is internal cleanup scoped to a freshly created unique path.

- [ ] **Step 6: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust unit and integration tests pass.

- [ ] **Step 7: Commit transactional staging**

```bash
git add src-tauri/src/toolchain/install.rs src-tauri/src/toolchain/probe.rs src-tauri/src/toolchain/mod.rs src-tauri/tests/toolchain_smoke_cli.rs
git commit -m "feat: stage complete toolchain revisions before activation" -m "feat: 激活前暂存完整工具链版本"
```

### Task 5: Route Tauri Commands Through One Transaction

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: fetched `ResolvedToolManifest`, staging, probes, and activation
- Produces: shared `install_and_activate_manifest(...)`
- Produces: active-revision-aware `locate_tools(...)`

- [ ] **Step 1: Add failing command adapter tests**

```rust
#[test]
fn install_update_and_reinstall_share_one_activation_path() {
    let source = include_str!("lib.rs");
    assert!(source.matches("install_and_activate_manifest(").count() >= 3);
    assert!(!source.contains("remove_managed_toolchain(&root)?"));
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib install_update_and_reinstall`

Expected: FAIL because reinstall removes the managed root before download.

- [ ] **Step 3: Implement shared transaction orchestration**

```rust
fn install_and_activate_manifest(
    app: &AppHandle,
    manifest_json: &str,
    target_name: &str,
) -> Result<Vec<ToolStatus>, String> {
    let resolved = manifest_from_json(manifest_json)?;
    let revision = require_manifest_revision(&resolved)?;
    let manifest_digest = sha256_bytes(manifest_json.as_bytes());
    let staged = stage_target_revision(/* manifest target, revision paths, reporter */)?;
    let paths = verify_staged_toolchain(&staged, /* target */)?;
    activate_revision(/* previous state, revision, digest */)?;
    save_active_tools_manifest(manifest_json)?;
    probe_target(&paths, /* target */)
}
```

Install, remote update, and reinstall call this path. Reinstall forces fresh staging but retains active state until activation. Remove/reset becomes a separately confirmed maintenance operation and is not part of normal repair.

- [ ] **Step 4: Prefer active revision with legacy fallback**

`locate_tools` checks valid active state first. With no active state, it checks existing flat managed tools and bundled development tools. Invalid active state returns an actionable error instead of silently selecting a partial revision.

- [ ] **Step 5: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all command, fallback, and failure-preservation tests pass.

- [ ] **Step 6: Commit command migration**

```bash
git add src-tauri/src/lib.rs
git commit -m "refactor: share transactional toolchain activation commands" -m "refactor: 统一事务式工具链激活命令"
```

### Task 6: Update Frontend Channel and Action Behavior

**Files:**
- Modify: `src/toolchain.ts`
- Modify: `src/main.ts`
- Modify: `tests/toolchain.test.ts`
- Create: `tests/toolchain-channel-ui.test.ts`

**Interfaces:**
- Produces: typed remote result with revision and source (`archive` or `legacy`)
- Keeps action states `install`, `update`, and `reinstall`

- [ ] **Step 1: Add failing frontend contract tests**

```typescript
test("remote archive revision produces update only when newer", () => {
  assert.equal(compareToolchainRevisions("20260712.1", "20260711.2"), 1);
  assert.equal(compareToolchainRevisions("20260712.1", "20260712.1"), 0);
});

test("tool checks use the backend archive channel command", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(source, /fetch_latest_tool_manifest/u);
  assert.doesNotMatch(source, /findToolManifestAsset/u);
});
```

- [ ] **Step 2: Run frontend tests and verify RED**

Run: `node --test --experimental-strip-types tests/toolchain.test.ts tests/toolchain-channel-ui.test.ts`

Expected: FAIL because revision comparison and archive result types are missing.

- [ ] **Step 3: Add strict revision comparison and result types**

```typescript
export type RemoteToolManifest = {
  status: "available" | "no_release" | "no_manifest";
  manifestJson: string | null;
  revision: string | null;
  source: "archive" | "legacy" | null;
};
```

Parse `YYYYMMDD.N` without floating point conversion and reject invalid values.

- [ ] **Step 4: Keep UI actions bound to backend transactions**

Remote check compares expected tool versions and revision. Install/update/reinstall pass the verified manifest JSON to the backend and wait for activation before refreshing statuses. Errors remain toast messages and retain the previous ready state.

- [ ] **Step 5: Run Node and build tests**

Run: `npm test`

Expected: all Node tests pass.

Run: `npm run build`

Expected: TypeScript and Vite build succeed.

- [ ] **Step 6: Commit frontend migration**

```bash
git add src/toolchain.ts src/main.ts tests/toolchain.test.ts tests/toolchain-channel-ui.test.ts
git commit -m "feat: consume archived toolchain revisions in the client" -m "feat: 客户端使用归档工具链版本"
```

### Task 7: Migrate Canary, Freshness, and Rollback Consumers

**Files:**
- Modify: `.github/workflows/toolchain-canary.yml`
- Modify: `.github/workflows/toolchain-validate.yml`
- Modify: `scripts/check-toolchain-freshness.mjs`
- Modify: `tests/toolchain-freshness.test.ts`
- Modify: `tests/toolchain-workflow.test.ts`

**Interfaces:**
- Consumes: schema-v2 channel and immutable revision release
- Produces: archive-specific health classification and historical rollback inputs

- [ ] **Step 1: Add failing consumer contract tests**

```typescript
test("stable consumers resolve the archive channel and revision release", () => {
  for (const path of ["toolchain-canary.yml", "toolchain-validate.yml"]) {
    const workflow = readWorkflow(path);
    assert.match(workflow, /Chlience\/yt-dlp-tauri-toolchain/u);
    assert.match(workflow, /releaseTag/u);
    assert.match(workflow, /immutable/u);
  }
});

test("freshness classifies archive failures separately", async () => {
  const result = await checkFreshness(archiveFailureFixture());
  assert.equal(result.problems[0].class, "archive-unavailable");
});
```

- [ ] **Step 2: Run consumer tests and verify RED**

Run: `node --test --experimental-strip-types tests/toolchain-freshness.test.ts tests/toolchain-workflow.test.ts`

Expected: FAIL because stable consumers still query the main repository's channel model.

- [ ] **Step 3: Migrate stable Canary and rollback lookups**

Fetch archive `toolchain-stable`, parse schema 2, fetch the exact immutable revision release, verify the manifest digest, and run existing Canary logic. Historical rollback loads the requested archive revision release directly.

- [ ] **Step 4: Split freshness classifications**

Runtime stable checks validate archive URL, asset name, size, and SHA-256. Discovery continues testing approved upstream provenance URLs separately. Emit `archive-unavailable`, `archive-integrity`, or `upstream-discovery` classes without treating upstream deletion as a stable revision failure.

- [ ] **Step 5: Run complete verification**

Run: `npm test`

Expected: all Node tests pass.

Run: `npm run build`

Expected: frontend build passes.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests pass.

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: Rust check passes without warnings introduced by this migration.

- [ ] **Step 6: Commit stable consumer migration**

```bash
git add .github/workflows/toolchain-canary.yml .github/workflows/toolchain-validate.yml scripts/check-toolchain-freshness.mjs tests/toolchain-freshness.test.ts tests/toolchain-workflow.test.ts
git commit -m "refactor: resolve stable tools from immutable archive releases" -m "refactor: 从不可变归档版本解析稳定工具"
```

## Acceptance Gate

- Client verifies schema-v2 channel, immutable revision release, exact manifest asset, and manifest digest.
- Schema-4 manifest archive/member integrity is enforced.
- Failed fetch, download, extraction, hash, probe, or activation preserves the active revision.
- Previous revision remains available after successful activation.
- v0.1.11 compatibility fallback remains functional when the stable tag has never existed.
- Direct and `gh-proxy` modes work for both API and asset URLs.
- Canary, freshness, and rollback consume archive releases.
- Node tests, frontend build, Rust tests, and Rust check pass.
