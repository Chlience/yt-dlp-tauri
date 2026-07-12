# Toolchain Validation and Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate each reviewed toolchain on all supported native platforms and publish immutable revisions through an atomic `toolchain-stable` channel without releasing a new application version.

**Architecture:** Extract the Rust installer into a reusable core and expose a headless smoke binary. A reusable GitHub Actions matrix installs baseline and candidate manifests, runs deterministic DASH integration, and emits a signed-by-context validation report. After the exact merged commit passes, the publisher uploads versioned FFmpeg and manifest assets, then atomically promotes a release-body channel record.

**Tech Stack:** Rust 2021, `zip` 8.2.0, reqwest/rustls, Node.js 24 ESM, GitHub Actions native Windows/macOS runners, GitHub Releases, FFmpeg/FFprobe, yt-dlp, Deno.

## Global Constraints

- This plan starts after `toolchain-policy.json`, `toolchain-lock.json`, and `scripts/update-toolchain.mjs` from the candidate automation plan exist.
- Pull-request validation has read-only repository permissions and no secrets.
- Required validation runs on Windows x64, macOS Intel, and macOS ARM64.
- Baseline runs before candidate; candidate failure triggers source-unit diagnostics.
- Real-site Canary failures never block publication.
- Publication validates the exact `main` commit associated with a merged toolchain PR.
- `toolchain-stable` is a prerelease and cannot replace the latest application release.
- Mirrored FFmpeg assets use unique versioned names and are never overwritten.
- Promotion updates one machine-readable release-body channel record atomically.
- The checked-in and published immutable manifests are byte-identical.
- Mirroring remains blocked when FFmpeg redistribution provenance is incomplete.
- All third-party actions are pinned to reviewed commit SHAs.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src-tauri/src/toolchain/mod.rs` | Shared manifest, install, and probe API |
| `src-tauri/src/toolchain/archive.rs` | Safe ZIP member extraction |
| `src-tauri/src/toolchain/install.rs` | App-independent installer core |
| `src-tauri/src/toolchain/probe.rs` | Native executable and combination probes |
| `src-tauri/src/bin/toolchain-smoke.rs` | Headless native compatibility entry point |
| `scripts/toolchain/compatibility.mjs` | Local DASH integration and report aggregation |
| `scripts/toolchain/validation-report.mjs` | Canonical validation report schema and merge |
| `.github/workflows/toolchain-validate.yml` | PR and reusable native matrix |
| `toolchain-canary.json` | Reviewed real-site Canary inputs |
| `scripts/toolchain/canary.mjs` | Non-blocking Canary and state transition |
| `.github/workflows/toolchain-canary.yml` | Daily stable Canary and deduplicated issues |
| `scripts/toolchain/ffmpeg-provenance.mjs` | Mirror eligibility and compliance metadata |
| `docs/ffmpeg-redistribution.md` | Project redistribution procedure |
| `scripts/toolchain/channel.mjs` | Parse and render the release-body channel record |
| `scripts/publish-toolchain.mjs` | Verify publish inputs and produce a promotion plan |
| `.github/workflows/toolchain-publish.yml` | Exact-main validation, asset upload, and promotion |

### Task 1: Extract a Shared Rust Toolchain Core

**Files:**
- Create: `src-tauri/src/toolchain/mod.rs`
- Create: `src-tauri/src/toolchain/archive.rs`
- Create: `src-tauri/src/toolchain/install.rs`
- Create: `src-tauri/src/toolchain/probe.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**
- Produces: `pub fn parse_manifest(json: &str) -> Result<ToolsManifest, String>`
- Produces: `pub fn install_target(request: InstallTargetRequest<'_>) -> Result<ToolPaths, String>`
- Produces: `pub fn probe_target(paths: &ToolPaths, target: &ManifestTarget) -> Result<Vec<ToolStatus>, String>`
- Produces: `pub trait ProgressReporter { fn emit(&self, progress: ToolInstallProgress); }`

- [ ] **Step 1: Move existing manifest and path tests to the new module and add a failing traversal test**

```rust
#[test]
fn rejects_parent_segments_in_archive_members() {
    assert_eq!(safe_archive_member("build/bin/ffmpeg.exe").unwrap(), PathBuf::from("build/bin/ffmpeg.exe"));
    assert!(safe_archive_member("../ffmpeg.exe").is_err());
    assert!(safe_archive_member("/tmp/ffmpeg").is_err());
    assert!(safe_archive_member("C:/ffmpeg.exe").is_err());
}
```

- [ ] **Step 2: Run the targeted Rust test and confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib rejects_parent_segments_in_archive_members`

Expected: FAIL because `safe_archive_member` is missing.

- [ ] **Step 3: Add the ZIP dependency and safe archive implementation**

Add:

```toml
zip = { version = "8.2.0", default-features = false, features = ["deflate", "deflate64"] }
```

Use `ZipArchive`, `enclosed_name`, and exact normalized suffix matching. Extract only members requested by the manifest. Reject duplicate suffix matches, directories, encrypted entries, symlinks, absolute paths, and entries larger than the HTTP asset size.

- [ ] **Step 4: Move installer logic behind path and reporter parameters**

```rust
pub struct InstallTargetRequest<'a> {
    pub target: &'a ManifestTarget,
    pub install_root: &'a Path,
    pub temp_root: &'a Path,
    pub reporter: &'a dyn ProgressReporter,
}

pub struct NoopProgressReporter;

impl ProgressReporter for NoopProgressReporter {
    fn emit(&self, _progress: ToolInstallProgress) {}
}
```

The Tauri adapter implements `ProgressReporter` with `AppHandle::emit`. Preserve current retry, progress, proxy, executable-permission, grouping, and SHA behavior.

- [ ] **Step 5: Run all Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: existing and new tests pass.

- [ ] **Step 6: Commit the shared core**

```bash
git add src-tauri/src/toolchain src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "refactor: share the native toolchain installer" -m "refactor: 共享原生工具链安装器"
```

### Task 2: Add a Headless Native Smoke Binary

**Files:**
- Create: `src-tauri/src/bin/toolchain-smoke.rs`
- Create: `src-tauri/tests/toolchain_smoke_cli.rs`
- Modify: `src-tauri/src/toolchain/probe.rs`

**Interfaces:**
- Consumes: `--manifest`, `--target`, `--root`, and `--report`
- Produces: `SmokeReport { target, tools, js_runtime_detected, ffmpeg_detected }` as JSON

- [ ] **Step 1: Add a failing CLI argument test**

```rust
#[test]
fn smoke_cli_requires_all_paths() {
    let output = Command::new(env!("CARGO_BIN_EXE_toolchain-smoke"))
        .output()
        .expect("smoke binary should start");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--manifest is required"));
}
```

- [ ] **Step 2: Confirm the CLI test fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test toolchain_smoke_cli`

Expected: FAIL because the binary is missing.

- [ ] **Step 3: Implement the smoke binary**

Parse arguments without adding a CLI framework. Read the manifest, install the requested target with `NoopProgressReporter`, and run the four executable version probes. Record the absolute Deno binary and FFmpeg directory in the report for the deterministic harness. Write canonical pretty JSON plus a trailing newline.

- [ ] **Step 4: Run binary and library tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib --bins --tests`

Expected: all Rust tests pass.

- [ ] **Step 5: Commit the smoke binary**

```bash
git add src-tauri/src/bin/toolchain-smoke.rs src-tauri/tests/toolchain_smoke_cli.rs src-tauri/src/toolchain/probe.rs
git commit -m "feat: add native toolchain smoke checks" -m "feat: 添加原生工具链冒烟检查"
```

### Task 3: Build the Deterministic DASH Compatibility Harness

**Files:**
- Create: `scripts/toolchain/compatibility.mjs`
- Create: `scripts/toolchain/current-target.mjs`
- Create: `tests/toolchain-compatibility.test.ts`

**Interfaces:**
- Produces: `runCompatibilitySuite(options): Promise<CompatibilityReport>`
- Consumes paths from `SmokeReport`

- [ ] **Step 1: Add failing command-construction tests**

```ts
test("DASH download pins Deno and FFmpeg paths", () => {
  const command = ytDlpDashCommand({
    ytDlp: "/tools/yt-dlp",
    deno: "/tools/deno",
    ffmpegDir: "/tools/ffmpeg/bin",
    manifestUrl: "http://127.0.0.1:43123/media.mpd",
    output: "/tmp/result.%(ext)s",
  });
  assert.deepEqual(command.args.slice(0, 6), [
    "--no-js-runtimes",
    "--js-runtimes", "deno:/tools/deno",
    "--ffmpeg-location", "/tools/ffmpeg/bin",
    "-f",
  ]);
});
```

Use the platform-correct runtime string `deno:<path>` in the implementation; the fixture helper normalizes separators before assertion.

- [ ] **Step 2: Confirm compatibility tests fail**

Run: `node --test --experimental-strip-types tests/toolchain-compatibility.test.ts`

Expected: FAIL because `compatibility.mjs` is missing.

- [ ] **Step 3: Implement local media generation and serving**

Generate a two-second DASH presentation with candidate FFmpeg using `testsrc2` video and `sine` audio. Bind a Node HTTP server to `127.0.0.1` on an ephemeral port and serve only files below the temporary media root. Reject decoded paths outside that root.

`current-target.mjs` maps `win32/x64`, `darwin/x64`, and `darwin/arm64` to the three manifest targets and exits with code `2` plus `Unsupported native toolchain target` on Linux or another unsupported host.

- [ ] **Step 4: Implement yt-dlp merge and FFprobe assertions**

Run candidate yt-dlp with `bestvideo+bestaudio`, the explicit Deno runtime, explicit FFmpeg directory, and MP4 merge output. Run candidate FFprobe with JSON output and require one video stream and one audio stream.

- [ ] **Step 5: Run Node tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit deterministic compatibility**

```bash
git add scripts/toolchain/compatibility.mjs scripts/toolchain/current-target.mjs tests/toolchain-compatibility.test.ts
git commit -m "test: add deterministic toolchain compatibility" -m "test: 添加确定性工具链兼容验证"
```

### Task 4: Define Canonical Validation Reports

**Files:**
- Create: `scripts/toolchain/validation-report.mjs`
- Create: `tests/toolchain-validation-report.test.ts`

**Interfaces:**
- Produces: `createTargetReport(input): TargetValidationReport`
- Produces: `mergeTargetReports(reports, context): ToolchainValidationReport`
- Produces: `validatePublicationReport(report, expected): void`

- [ ] **Step 1: Add failing canonical report tests**

```ts
test("publication report requires all native targets and exact hashes", () => {
  const report = mergeTargetReports(targetReports(), {
    revision: "20260711.1",
    commitSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    lockSha256: "c".repeat(64),
    runId: "1234",
    runUrl: "https://github.com/Chlience/yt-dlp-tauri/actions/runs/1234",
  });
  assert.deepEqual(report.targets.map((target) => target.target), ["macos-arm64", "macos-x64", "win-x64"]);
  assert.doesNotThrow(() => validatePublicationReport(report, {
    revision: "20260711.1",
    commitSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    lockSha256: "c".repeat(64),
  }));
});
```

- [ ] **Step 2: Confirm report tests fail**

Run: `node --test --experimental-strip-types tests/toolchain-validation-report.test.ts`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement schema version 1 and stable sorting**

Require target success, supply-chain success, executable success, DASH success, project test success, runner image, architecture, tool versions, asset IDs, official digests, and extracted hashes. Canary status is optional and explicitly non-blocking.

- [ ] **Step 4: Run report tests**

Run: `node --test --experimental-strip-types tests/toolchain-validation-report.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit report schema**

```bash
git add scripts/toolchain/validation-report.mjs tests/toolchain-validation-report.test.ts
git commit -m "feat: define toolchain validation reports" -m "feat: 定义工具链验证报告"
```

### Task 5: Add the Reusable Native Validation Matrix

**Files:**
- Create: `.github/workflows/toolchain-validate.yml`
- Modify: `tests/toolchain-workflow.test.ts`

**Interfaces:**
- Supports: `pull_request`, `workflow_dispatch`, and `workflow_call`
- Produces artifact: `toolchain-validation-report`
- Produces artifact: `toolchain-mirror-candidates` containing only mirror-eligible bytes verified by the Windows job
- Produces required job: `toolchain-validation`

- [ ] **Step 1: Add failing workflow contracts**

```ts
test("validation workflow uses native targets with read-only permissions", () => {
  const workflow = readFileSync(".github/workflows/toolchain-validate.yml", "utf8");
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /macos-15-intel/);
  assert.match(workflow, /macos-15/);
  assert.match(workflow, /toolchain-validation/);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|secrets: inherit/);
});
```

- [ ] **Step 2: Confirm workflow test fails**

Run: `node --test --experimental-strip-types tests/toolchain-workflow.test.ts`

Expected: FAIL because the validation workflow is missing.

- [ ] **Step 3: Implement matrix preparation and native jobs**

Pin checkout, setup-node, rust-toolchain, rust-cache, upload-artifact, and download-artifact to:

```text
actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444
dtolnay/rust-toolchain@4be7066ada62dd38de10e7b70166bc74ed198c30
Swatinem/rust-cache@42dc69e1aa15d09112580998cf2ef0119e2e91ae
actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
```

Each target runs baseline first, candidate second, then project tests. Upload one target report even on failure. The Windows job also uploads the exact verified FFmpeg archive and provenance JSON under `toolchain-mirror-candidates`; filenames and digests must match the candidate lock. The aggregate job downloads reports, validates all required targets, and uploads the canonical merged report.

- [ ] **Step 4: Add conditional source-unit diagnostics**

When baseline passes and candidate fails, run three focused candidates: new yt-dlp with stable companions, new Deno with stable companions, and new FFmpeg source unit with stable companions. Include diagnostic outcomes in the aggregate report without changing the PR.

- [ ] **Step 5: Run workflow contracts and full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit the matrix**

```bash
git add .github/workflows/toolchain-validate.yml tests/toolchain-workflow.test.ts
git commit -m "ci: validate toolchains on native platforms" -m "ci: 在原生平台验证工具链"
```

### Task 6: Add Non-Blocking Canary State

**Files:**
- Create: `toolchain-canary.json`
- Create: `scripts/toolchain/canary.mjs`
- Create: `tests/toolchain-canary.test.ts`
- Create: `.github/workflows/toolchain-canary.yml`
- Modify: `tests/toolchain-workflow.test.ts`

**Interfaces:**
- Produces: `nextCanaryState(previous, observations): CanaryState`
- Produces: `issuesToUpdate(state): CanaryIssueAction[]`

- [ ] **Step 1: Add failing three-strike and recovery tests**

```ts
test("Canary opens one issue action after three matching failures", () => {
  let state = emptyCanaryState();
  for (let count = 0; count < 3; count += 1) {
    state = nextCanaryState(state, [{ id: "youtube-public", ok: false, failureClass: "metadata" }]);
  }
  assert.deepEqual(issuesToUpdate(state), [{ id: "youtube-public", action: "open", failureClass: "metadata", count: 3 }]);
});

test("a successful observation resets the counter", () => {
  const state = nextCanaryState({ entries: { "youtube-public": { count: 2, failureClass: "metadata" } } }, [{ id: "youtube-public", ok: true }]);
  assert.equal(state.entries["youtube-public"].count, 0);
});
```

- [ ] **Step 2: Confirm Canary tests fail**

Run: `node --test --experimental-strip-types tests/toolchain-canary.test.ts`

Expected: FAIL because `canary.mjs` is missing.

- [ ] **Step 3: Implement redacted observations and artifact state**

Allow only checked-in public URLs. Store site ID, operation, count, failure class, first failure time, last failure time, and recovery time. Strip query strings, cookies, authorization headers, and local paths from reports.

- [ ] **Step 4: Implement the daily workflow**

Run at `53 5 * * *`. Give only `contents: read`, `actions: read`, and `issues: write`. Download the newest prior `canary-state` artifact; missing or expired state starts at zero. Upload the next state and create or edit one issue per site ID after the third consecutive failure.

- [ ] **Step 5: Run Canary and workflow tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit Canary support**

```bash
git add toolchain-canary.json scripts/toolchain/canary.mjs tests/toolchain-canary.test.ts .github/workflows/toolchain-canary.yml tests/toolchain-workflow.test.ts
git commit -m "feat: monitor real-site toolchain canaries" -m "feat: 监控真实站点工具链 Canary"
```

### Task 7: Gate FFmpeg Mirroring on Provenance

**Files:**
- Create: `scripts/toolchain/ffmpeg-provenance.mjs`
- Create: `tests/ffmpeg-provenance.test.ts`
- Create: `docs/ffmpeg-redistribution.md`
- Modify: `THIRD-PARTY-NOTICES.md`
- Modify: `toolchain-policy.json`

**Interfaces:**
- Produces: `verifyFfmpegProvenance(lockSource, provenance): MirrorEligibility`
- `MirrorEligibility` is `{ eligible, problems, assets }`

- [ ] **Step 1: Add failing provenance tests**

```ts
test("mirror eligibility requires binary, source, build, checksum, and license provenance", () => {
  const result = verifyFfmpegProvenance(ffmpegLockSource(), {
    binaryReleaseUrl: "https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/autobuild-2026-06-30-16-38",
    binarySha256: "a".repeat(64),
    ffmpegSourceRevision: "b".repeat(40),
    buildRepositoryRevision: "c".repeat(40),
    checksumUrl: "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/autobuild-2026-06-30-16-38/checksums.sha256",
    licenseFiles: ["GPLv3.txt", "THIRD-PARTY-NOTICES.md"],
  });
  assert.equal(result.eligible, true);
});
```

- [ ] **Step 2: Confirm provenance tests fail**

Run: `node --test --experimental-strip-types tests/ffmpeg-provenance.test.ts`

Expected: FAIL because the provenance module is missing.

- [ ] **Step 3: Implement exact-revision and digest checks**

Reject branch names, mutable URLs, missing license paths, non-SHA revisions, and binary digests that differ from the lock. Generate one `ffmpeg-provenance-<revision>.json` publication asset.

- [ ] **Step 4: Document redistribution procedure**

Document how maintainers identify the FFmpeg source revision and build-repository revision, preserve license notices, provide corresponding-source access, and use the upstream monthly URL when the gate is incomplete. State that this automated gate supports compliance evidence and does not replace legal review.

- [ ] **Step 5: Run tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit the provenance gate**

```bash
git add scripts/toolchain/ffmpeg-provenance.mjs tests/ffmpeg-provenance.test.ts docs/ffmpeg-redistribution.md THIRD-PARTY-NOTICES.md toolchain-policy.json
git commit -m "feat: gate FFmpeg release mirroring" -m "feat: 为 FFmpeg 镜像添加发布门禁"
```

### Task 8: Implement Atomic Channel Records

**Files:**
- Create: `scripts/toolchain/channel.mjs`
- Create: `tests/toolchain-channel.test.ts`

**Interfaces:**
- Produces: `parseChannelRecord(releaseBody): ChannelRecord`
- Produces: `renderChannelRecord(releaseBody, record): string`
- Produces: `selectManifestAsset(release, record): ReleaseAsset`

- [ ] **Step 1: Add failing parse, duplicate, and replacement tests**

```ts
test("channel renderer preserves human release notes", () => {
  const body = "# Stable toolchain\n\nHuman notes\n";
  const next = renderChannelRecord(body, {
    schemaVersion: 1,
    revision: "20260711.1",
    manifest: "tools-manifest-20260711.1.json",
    sha256: "a".repeat(64),
  });
  assert.match(next, /Human notes/);
  assert.deepEqual(parseChannelRecord(next), {
    schemaVersion: 1,
    revision: "20260711.1",
    manifest: "tools-manifest-20260711.1.json",
    sha256: "a".repeat(64),
  });
});

test("channel parser rejects duplicate records", () => {
  const marker = renderChannelRecord("", channelFixture());
  assert.throws(() => parseChannelRecord(`${marker}\n${marker}`), /multiple toolchain channel records/);
});
```

- [ ] **Step 2: Confirm channel tests fail**

Run: `node --test --experimental-strip-types tests/toolchain-channel.test.ts`

Expected: FAIL because `channel.mjs` is missing.

- [ ] **Step 3: Implement strict marker handling**

Use exactly one `<!-- toolchain-channel` marker terminated by `-->`. Validate schema `1`, revision format `^[0-9]{8}\.[1-9][0-9]*$`, manifest name `tools-manifest-<revision>.json`, and 64 lowercase hex digest. Reject unknown fields.

- [ ] **Step 4: Run channel tests**

Run: `node --test --experimental-strip-types tests/toolchain-channel.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit channel records**

```bash
git add scripts/toolchain/channel.mjs tests/toolchain-channel.test.ts
git commit -m "feat: define the stable toolchain channel" -m "feat: 定义稳定工具链通道"
```

### Task 9: Build the Publisher and Release Workflow

**Files:**
- Create: `scripts/publish-toolchain.mjs`
- Create: `tests/publish-toolchain.test.ts`
- Create: `.github/workflows/toolchain-publish.yml`
- Modify: `scripts/toolchain/generate-manifest.mjs`
- Modify: `toolchain-policy.json`
- Modify: `tests/toolchain-manifest-generation.test.ts`
- Modify: `tests/toolchain-workflow.test.ts`

**Interfaces:**
- Produces: `createPublicationPlan(input): PublicationPlan`
- Produces: `verifyUploadedAsset(asset, expected): void`
- Workflow consumes canonical `toolchain-validation-report`

- [ ] **Step 1: Add failing publication-order tests**

```ts
test("publication promotes the channel after every immutable asset", () => {
  const plan = createPublicationPlan(publicationFixture());
  assert.deepEqual(plan.steps.map((step) => step.kind), [
    "upload-ffmpeg",
    "verify-ffmpeg",
    "upload-provenance",
    "upload-manifest",
    "upload-validation",
    "promote-channel",
    "update-application-compatibility-manifest",
  ]);
});

test("publisher rejects a report from another commit", () => {
  assert.throws(() => createPublicationPlan(publicationFixture({ reportCommitSha: "d".repeat(40) })), /validation commit does not match/);
});
```

- [ ] **Step 2: Confirm publisher tests fail**

Run: `node --test --experimental-strip-types tests/publish-toolchain.test.ts`

Expected: FAIL because `publish-toolchain.mjs` is missing.

- [ ] **Step 3: Implement pure publication planning and verification**

The script verifies merged-PR metadata, revision monotonicity, manifest and lock hashes, target results, mirror eligibility, final asset names, and existing Release assets. It emits JSON operations; the workflow executes GitHub mutations with `gh` only after the plan succeeds.

- [ ] **Step 4: Switch eligible FFmpeg sources to project URLs**

For mirror-eligible lock sources, generate:

```js
const sourceUrl = `https://github.com/Chlience/yt-dlp-tauri/releases/download/toolchain-stable/${lockAsset.mirrorFilename}`;
```

Keep the immutable upstream URL in the lock provenance. Tests must show the runtime manifest uses the project URL while validation still downloads the upstream candidate before publication.

- [ ] **Step 5: Implement exact-main publication workflow**

Trigger on pushes to `main` that change `toolchain-lock.json` or `src-tauri/tools-manifest.json`, plus manual rollback dispatch. Call the reusable matrix, download its report, query the associated merged PR, create the prerelease if absent, upload and verify assets, PATCH the release body last, then update the latest normal application release compatibility manifest.

Use `contents: write` only in the publish job. Set `concurrency.group: toolchain-publish` and `cancel-in-progress: false`.

- [ ] **Step 6: Run publisher, workflow, and full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 7: Commit publication**

```bash
git add scripts/publish-toolchain.mjs tests/publish-toolchain.test.ts .github/workflows/toolchain-publish.yml scripts/toolchain/generate-manifest.mjs toolchain-policy.json tests/toolchain-manifest-generation.test.ts tests/toolchain-workflow.test.ts
git commit -m "feat: publish validated toolchain revisions" -m "feat: 发布已验证的工具链版本"
```

### Task 10: Add Rollback Promotion

**Files:**
- Modify: `scripts/publish-toolchain.mjs`
- Modify: `tests/publish-toolchain.test.ts`
- Modify: `.github/workflows/toolchain-publish.yml`

**Interfaces:**
- Consumes manual input `rollback_revision` and required `reason`
- Produces a channel-only promotion after asset and report verification

- [ ] **Step 1: Add a failing rollback plan test**

```ts
test("rollback changes only the channel after verifying historical assets", () => {
  const plan = createRollbackPlan(rollbackFixture());
  assert.deepEqual(plan.steps.map((step) => step.kind), [
    "verify-historical-manifest",
    "verify-historical-assets",
    "promote-channel",
    "record-rollback",
  ]);
});
```

- [ ] **Step 2: Confirm rollback test fails**

Run: `node --test --experimental-strip-types tests/publish-toolchain.test.ts`

Expected: FAIL because `createRollbackPlan` is missing.

- [ ] **Step 3: Implement rollback validation and dispatch**

Require the exact immutable manifest and validation report assets, verify their digests and referenced source assets, reject the currently promoted revision, and require a non-empty reason. Run deterministic validation by default; expose `skip_revalidation` only through a protected GitHub Environment approval.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit rollback**

```bash
git add scripts/publish-toolchain.mjs tests/publish-toolchain.test.ts .github/workflows/toolchain-publish.yml
git commit -m "feat: support validated toolchain rollback" -m "feat: 支持已验证工具链回滚"
```

### Task 11: Full Local and Workflow Verification

**Files:**
- No source changes expected

**Interfaces:**
- Consumes all validation and publication components
- Produces local evidence before GitHub mutations

- [ ] **Step 1: Run Node tests and frontend build**

Run: `npm test`

Expected: all tests pass.

Run: `npm run build`

Expected: Vite production build succeeds.

- [ ] **Step 2: Run Rust verification with a fresh target when needed**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib --bins --tests`

Expected: all Rust tests pass.

Run: `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`

Expected: exit `0`.

- [ ] **Step 3: Run deterministic compatibility on the local native target**

Run on Windows or macOS: `node scripts/toolchain/compatibility.mjs --manifest src-tauri/tools-manifest.json --target "$(node scripts/toolchain/current-target.mjs)"`

Expected on a supported native host: report contains successful executable, DASH merge, and FFprobe results. On Linux, `current-target.mjs` exits `2`; the three GitHub Actions native jobs provide this evidence.

- [ ] **Step 4: Check source and formatting integrity**

Run: `node scripts/check-tool-source-urls.mjs`

Expected: all published upstream URLs are available before mirror promotion.

Run: `git diff --check`

Expected: no output.

### Task 12: GitHub Acceptance and First Stable Promotion

**Files:**
- No source changes expected

**Interfaces:**
- Consumes merged implementation, branch protection, and Release permissions
- Produces the initial `toolchain-stable` prerelease and one promoted revision

- [ ] **Step 1: Dispatch validation on main**

Run: `gh workflow run "Toolchain Validation" --ref main`

Expected: all three native jobs and the aggregate job succeed.

- [ ] **Step 2: Inspect the canonical report**

Run: `gh run download "$(gh run list --repo Chlience/yt-dlp-tauri --workflow toolchain-validate.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --repo Chlience/yt-dlp-tauri --name toolchain-validation-report`

Expected: one report with the current main SHA and three successful target entries.

- [ ] **Step 3: Dispatch publication only after reviewing FFmpeg provenance**

Run: `gh workflow run "Toolchain Publish" --ref main`

Expected: `toolchain-stable` exists as a prerelease, immutable assets are present, and the channel record points at the new revision.

- [ ] **Step 4: Verify channel and application compatibility copies**

Run: `gh api repos/Chlience/yt-dlp-tauri/releases/tags/toolchain-stable`

Expected: prerelease is `true`; release body has one valid channel marker.

Run: `gh api repos/Chlience/yt-dlp-tauri/releases/latest --jq '.assets[] | select(.name == "tools-manifest.json") | .name'`

Expected: `tools-manifest.json`.

- [ ] **Step 5: Run rollback dry-run**

Run after revision `20260711.2` or newer is current: `gh workflow run "Toolchain Publish" --ref main -f rollback_revision=20260711.1 -f reason="Acceptance rollback dry-run" -f dry_run=true`

Expected: workflow verifies the historical revision and reports the intended channel change without mutating the release.
