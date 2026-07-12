# Toolchain Byte Custody and Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the exact tool bytes validated on a pull request through exact-main native validation into a verified immutable archive release, then atomically promote the stable channel.

**Architecture:** A canonical candidate bundle stores one file per new SHA-256 plus an index tied to the lock and PR head. Native jobs install from that verified directory. A main handoff resolver accepts only one successful same-repository pull-request workflow artifact for the merged commit, revalidates and re-uploads it, and the publisher classifies each descriptor as reuse, upload, or metadata before mutating the archive repository with a scoped GitHub App token.

**Tech Stack:** Node.js 24 ESM, GitHub Actions, GitHub REST API `2026-03-10`, `actions/upload-artifact` and `actions/download-artifact`, Rust 2021 installer core, GitHub CLI.

## Global Constraints

- Pull-request validation has `contents: read` and no repository secrets.
- Main handoff has `actions: read` and resolves artifacts by exact workflow, event, repository ID, head SHA, revision, and non-expired state.
- Candidate files use `assets/<64-lowercase-sha256>` and are never stored in Git.
- A descriptor assigned to the proposed revision must have one exact candidate file.
- A reused descriptor must resolve to an immutable historical release asset and is not uploaded again.
- Archive verification and mutation use a GitHub App installation token scoped to `Chlience/yt-dlp-tauri-toolchain` with Contents write, Metadata read, and Administration read.
- Revision release remains draft until every uploaded asset is downloaded and verified.
- Stable channel promotion occurs only after immutable publication verification.
- v0.1.11 compatibility replacement on the latest normal application release is last.
- Missing operational prerequisites stop before archive mutation.

---

## File Map

| File | Responsibility |
| --- | --- |
| `scripts/toolchain/candidate-bundle.mjs` | Select, download, index, canonicalize, and verify proposed revision bytes |
| `scripts/prepare-toolchain-candidate.mjs` | CLI for pull-request bundle preparation |
| `scripts/verify-toolchain-candidate.mjs` | CLI for native and main bundle verification |
| `scripts/toolchain/artifact-handoff.mjs` | Resolve merged PR, successful workflow run, and exact artifact |
| `scripts/resolve-toolchain-artifact.mjs` | Main handoff CLI using GitHub REST API |
| `scripts/toolchain/publication-plan.mjs` | Classify reuse/upload/metadata operations and enforce ordering |
| `scripts/publish-toolchain.mjs` | Dry-run and workflow CLI adapter for archive publication and rollback |
| `src-tauri/src/toolchain/install.rs` | Verified local asset-directory override |
| `src-tauri/src/bin/toolchain-smoke.rs` | `--asset-root` native validation input |
| `.github/workflows/toolchain-validate.yml` | Prepare once, validate natively, upload canonical reports |
| `.github/workflows/toolchain-publish.yml` | Main artifact handoff, exact-main validation, App-authenticated publication |
| `tests/toolchain-candidate-bundle.test.ts` | Bundle canonicalization, download, hash, and tamper tests |
| `tests/toolchain-artifact-handoff.test.ts` | Exact workflow/PR/artifact selection tests |
| `tests/publish-toolchain.test.ts` | Archive publication and rollback plan tests |
| `tests/toolchain-workflow.test.ts` | Workflow permissions, ordering, and authentication contracts |

### Task 1: Prepare and Verify Canonical Candidate Bundles

**Files:**
- Create: `scripts/toolchain/candidate-bundle.mjs`
- Create: `scripts/prepare-toolchain-candidate.mjs`
- Create: `scripts/verify-toolchain-candidate.mjs`
- Create: `tests/toolchain-candidate-bundle.test.ts`

**Interfaces:**
- Produces: `candidateAssetsForRevision(lock) -> CandidateAsset[]`
- Produces: `prepareCandidateBundle({ lock, outputDirectory, fetchImpl }) -> CandidateIndex`
- Produces: `verifyCandidateBundle({ lock, directory, expectedContext }) -> CandidateIndex`
- Produces: canonical `candidate-assets.json`

- [ ] **Step 1: Add failing selection and tamper tests**

```typescript
test("bundle contains each proposed byte object once", async () => {
  const index = await prepareCandidateBundle({
    lock: firstArchiveLock(),
    outputDirectory: root,
    fetchImpl: fixtureFetch,
    context: { repositoryId: "42", headSha: "a".repeat(40), revision: "20260712.1" },
  });
  assert.equal(index.assets.length, 10);
  assert.equal(new Set(index.assets.map((asset) => asset.sha256)).size, 10);
});

test("verification rejects modified candidate bytes", async () => {
  await prepareFixtureBundle(root);
  await writeFile(join(root, "assets", "a".repeat(64)), "modified");
  await assert.rejects(
    verifyCandidateBundle({ lock: firstArchiveLock(), directory: root }),
    /SHA-256 mismatch/u,
  );
});
```

- [ ] **Step 2: Run candidate tests and verify RED**

Run: `node --test --experimental-strip-types tests/toolchain-candidate-bundle.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement canonical index selection**

```javascript
export function candidateAssetsForRevision(lock) {
  const releaseTag = `toolchain-${lock.revision}`;
  const byDigest = new Map();
  for (const source of lock.sources) {
    for (const asset of source.assets) {
      if (asset.archive.releaseTag !== releaseTag) continue;
      const existing = byDigest.get(asset.sha256);
      const entry = {
        sourceId: source.id,
        sourceUrl: asset.sourceUrl,
        archive: asset.archive,
        kind: asset.kind,
        size: asset.size,
        sha256: asset.sha256,
        path: `assets/${asset.sha256}`,
        targets: [asset.target],
      };
      if (existing) mergeEquivalentEntry(existing, entry);
      else byDigest.set(asset.sha256, entry);
    }
  }
  return [...byDigest.values()].sort((left, right) => left.sha256.localeCompare(right.sha256));
}
```

Reject one digest paired with different size, kind, upstream identity, archive repository, release tag, or asset name. Include schema version, revision, repository ID, PR number when available, head SHA, lock SHA-256, creation time, and sorted assets in the index.

- [ ] **Step 4: Stream downloads and verify exact size/digest**

Download to an untracked temporary sibling, enforce approved HTTPS hosts, hash while streaming, compare `Content-Length` when present, compare final size and digest, then atomically rename to `assets/<sha256>`. Write `candidate-assets.json` only after all bytes pass.

- [ ] **Step 5: Implement independent bundle verification**

Recompute canonical lock digest and expected candidate entries, reject symlinks, extra files, missing files, path traversal, context mismatch, index non-canonical ordering, size mismatch, and SHA-256 mismatch.

- [ ] **Step 6: Run candidate tests and verify GREEN**

Run: `node --test --experimental-strip-types tests/toolchain-candidate-bundle.test.ts`

Expected: all candidate bundle tests pass.

- [ ] **Step 7: Commit candidate custody primitives**

```bash
git add scripts/toolchain/candidate-bundle.mjs scripts/prepare-toolchain-candidate.mjs scripts/verify-toolchain-candidate.mjs tests/toolchain-candidate-bundle.test.ts
git commit -m "feat: preserve validated toolchain candidate bytes" -m "feat: 保留已验证的工具链候选字节"
```

### Task 2: Install Native Candidates From Verified Local Bytes

**Files:**
- Modify: `src-tauri/src/toolchain/install.rs`
- Modify: `src-tauri/src/bin/toolchain-smoke.rs`
- Modify: `src-tauri/tests/toolchain_smoke_cli.rs`

**Interfaces:**
- Consumes: schema-4 `sourceSha256` from the archive-contract plan
- Produces: `InstallTargetRequest.asset_root: Option<&Path>`
- Produces: `toolchain-smoke --asset-root <directory>`

- [ ] **Step 1: Add failing local source tests**

```rust
#[test]
fn local_asset_root_uses_content_addressed_source() {
    let root = tempdir().unwrap();
    let digest = sha256_bytes(b"tool");
    fs::create_dir_all(root.path().join("assets")).unwrap();
    fs::write(root.path().join("assets").join(&digest), b"tool").unwrap();
    let path = local_source_path(root.path(), &digest).unwrap();
    assert_eq!(path, root.path().join("assets").join(digest));
}

#[test]
fn missing_local_candidate_never_falls_back_to_upstream() {
    let error = resolve_install_source(Some(root.path()), &tool()).unwrap_err();
    assert!(error.contains("missing from candidate bundle"));
}
```

- [ ] **Step 2: Run Rust tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib local_asset`

Expected: FAIL because local source resolution is missing.

- [ ] **Step 3: Add strict optional local source resolution**

When `asset_root` is present and a tool URL points to an upstream source assigned to the candidate revision, require `assets/<sourceSha256>`. Copy it to the existing temporary download path, verify size/SHA-256, and continue through the same extraction/member verification path. Never issue an HTTP request after selecting local mode.

- [ ] **Step 4: Add the smoke CLI option**

```rust
struct Arguments {
    manifest: PathBuf,
    root: PathBuf,
    asset_root: Option<PathBuf>,
    expected_target: Option<String>,
}
```

Parse one `--asset-root` value, require it to be a directory, and pass `asset_root.as_deref()` into `InstallTargetRequest`.

- [ ] **Step 5: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust unit and CLI tests pass.

- [ ] **Step 6: Commit local candidate installation**

```bash
git add src-tauri/src/toolchain/install.rs src-tauri/src/bin/toolchain-smoke.rs src-tauri/tests/toolchain_smoke_cli.rs
git commit -m "feat: validate native tools from local candidate bytes" -m "feat: 使用本地候选字节验证原生工具"
```

### Task 3: Prepare Once and Validate the Same Bundle on Every Runner

**Files:**
- Modify: `.github/workflows/toolchain-validate.yml`
- Modify: `tests/toolchain-workflow.test.ts`

**Interfaces:**
- Consumes: candidate CLI and local smoke option from Tasks 1-2
- Produces: one `toolchain-candidate-<revision>` artifact and canonical report identity

- [ ] **Step 1: Add failing workflow contract tests**

```typescript
test("PR validation prepares one candidate artifact before native jobs", () => {
  const workflow = readWorkflow("toolchain-validate.yml");
  assert.match(workflow, /prepare-candidate:/u);
  assert.match(workflow, /retention-days:\s*7/u);
  assert.match(workflow, /artifact-id/u);
  assert.match(workflow, /artifact-digest/u);
  assert.match(workflow, /needs:\s*prepare-candidate/u);
});

test("native candidate smoke uses the downloaded local bundle", () => {
  assert.match(workflow, /--asset-root\s+\.toolchain\/candidate/u);
});
```

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `node --test --experimental-strip-types tests/toolchain-workflow.test.ts`

Expected: FAIL because no preparation job exists.

- [ ] **Step 3: Add `prepare-candidate`**

Checkout, setup Node 24, run `npm ci`, generate candidate manifest, run the preparation CLI with `GITHUB_REPOSITORY_ID`, PR number, and head SHA, verify the bundle, and upload it through the existing pinned `actions/upload-artifact` commit with `compression-level: 0`, `retention-days: 7`, and `if-no-files-found: error`.

- [ ] **Step 4: Consume and verify the artifact in native jobs**

Make `validate-native` depend on preparation. Download the named artifact, run the verification CLI against the checked-in lock and expected head SHA, and pass the asset root to candidate and diagnostic smoke runs. Keep baseline steps `continue-on-error`; candidate failures remain blocking.

- [ ] **Step 5: Bind canonical validation report to artifact identity**

Add `candidateArtifactName`, `candidateArtifactId`, `candidateArtifactDigest`, `pullRequestNumber`, `headRepositoryId`, and `headSha`. Omit merge SHA from PR reports.

- [ ] **Step 6: Run Node tests**

Run: `npm test`

Expected: all tests pass and all third-party actions remain commit-pinned.

- [ ] **Step 7: Commit PR byte custody workflow**

```bash
git add .github/workflows/toolchain-validate.yml tests/toolchain-workflow.test.ts
git commit -m "ci: validate toolchains from one preserved candidate bundle" -m "ci: 使用同一候选字节包验证工具链"
```

### Task 4: Resolve the Exact PR Artifact on Main

**Files:**
- Create: `scripts/toolchain/artifact-handoff.mjs`
- Create: `scripts/resolve-toolchain-artifact.mjs`
- Create: `tests/toolchain-artifact-handoff.test.ts`
- Modify: `.github/workflows/toolchain-publish.yml`

**Interfaces:**
- Produces: `resolveMergedPullRequest(commit, pulls) -> PullRequest`
- Produces: `selectValidationRun({ runs, workflowId, headSha, repositoryId }) -> WorkflowRun`
- Produces: `selectCandidateArtifact({ artifacts, revision, run }) -> Artifact`
- Produces: `.toolchain/handoff/handoff-report.json`

- [ ] **Step 1: Add failing ambiguity and trust-boundary tests**

```typescript
test("handoff rejects artifacts from a fork", () => {
  assert.throws(
    () => selectValidationRun({
      runs: [successfulRun({ head_repository_id: 99 })],
      workflowId: 123,
      headSha: "a".repeat(40),
      repositoryId: 42,
    }),
    /head repository/u,
  );
});

test("handoff requires one non-expired revision artifact", () => {
  assert.throws(
    () => selectCandidateArtifact({ artifacts: [artifact(), artifact()], revision: "20260712.1" }),
    /exactly one/u,
  );
});
```

- [ ] **Step 2: Run handoff tests and verify RED**

Run: `node --test --experimental-strip-types tests/toolchain-artifact-handoff.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement exact selection**

Require one merged PR associated with the exact main commit, one latest successful `event=pull_request` run for `.github/workflows/toolchain-validate.yml` and the PR head SHA, same base/head repository ID, and one unexpired artifact named `toolchain-candidate-<revision>`. Verify REST artifact `digest` and workflow identity in addition to the internal bundle index.

- [ ] **Step 4: Add a main handoff job**

Grant `actions: read`, `contents: read`, and `pull-requests: read`. Resolve and download through REST, extract into `.toolchain/candidate`, verify against the merged lock, write a report containing PR number, PR head SHA, merge SHA, workflow run ID, artifact ID/digest, lock digest, and revision, then upload the verified bundle in the main run.

- [ ] **Step 5: Run focused tests**

Run: `node --test --experimental-strip-types tests/toolchain-artifact-handoff.test.ts tests/toolchain-workflow.test.ts`

Expected: all focused tests pass.

- [ ] **Step 6: Commit exact-main artifact handoff**

```bash
git add scripts/toolchain/artifact-handoff.mjs scripts/resolve-toolchain-artifact.mjs tests/toolchain-artifact-handoff.test.ts .github/workflows/toolchain-publish.yml tests/toolchain-workflow.test.ts
git commit -m "ci: bind merged toolchains to validated pull request bytes" -m "ci: 将合并工具链绑定到已验证的拉取请求字节"
```

### Task 5: Build Archive Publication and Rollback Plans

**Files:**
- Create: `scripts/toolchain/publication-plan.mjs`
- Modify: `scripts/publish-toolchain.mjs`
- Modify: `tests/publish-toolchain.test.ts`

**Interfaces:**
- Produces: `createArchivePublicationPlan(input) -> PublicationPlan`
- Produces: operations `reuse`, `upload`, `metadata`, `publish-release`, `promote-channel`, `legacy-manifest`
- Produces: `createArchiveRollbackPlan(input) -> RollbackPlan`

- [ ] **Step 1: Replace stable-release asset assumptions with failing archive tests**

```typescript
test("publication reuses historical descriptors and uploads proposed descriptors", () => {
  const plan = createArchivePublicationPlan(fixtureInput());
  assert.deepEqual(
    plan.operations.map((operation) => operation.kind),
    ["reuse", "upload", "metadata", "metadata", "publish-release", "promote-channel", "legacy-manifest"],
  );
});

test("publication rejects an upload without exact candidate bytes", () => {
  assert.throws(
    () => createArchivePublicationPlan(inputWithoutCandidateFile()),
    /candidate byte object/u,
  );
});
```

- [ ] **Step 2: Run publisher tests and verify RED**

Run: `node --test --experimental-strip-types tests/publish-toolchain.test.ts`

Expected: FAIL because the current plan publishes FFmpeg assets into the main stable release.

- [ ] **Step 3: Implement total descriptor classification**

For each unique descriptor, classify historical tags as `reuse` only after exact release/tag/name/size/digest and `immutable=true` checks. Classify the proposed tag as `upload` only with an exact verified candidate file. Reject every duplicate, missing, ambiguous, mutable, or cross-repository descriptor. Add manifest, validation report, compliance report, checksums, and provenance as metadata operations.

- [ ] **Step 4: Enforce transaction ordering**

All reuse checks and uploads precede metadata. Draft verification precedes `publish-release`; immutable verification precedes `promote-channel`; compatibility replacement is final. Render schema-v2 channel records with repository and release tag.

- [ ] **Step 5: Implement historical rollback resolution**

Load the requested immutable revision release, validate its manifest/report and every descriptor across historical releases, require native revalidation or protected approval, then emit only `promote-channel` followed by compatibility replacement. Never copy historical bytes.

- [ ] **Step 6: Run publisher tests**

Run: `node --test --experimental-strip-types tests/publish-toolchain.test.ts tests/toolchain-channel.test.ts`

Expected: all archive publication and rollback tests pass.

- [ ] **Step 7: Commit archive plans**

```bash
git add scripts/toolchain/publication-plan.mjs scripts/publish-toolchain.mjs tests/publish-toolchain.test.ts tests/toolchain-channel.test.ts
git commit -m "feat: plan immutable toolchain archive releases" -m "feat: 规划不可变工具链归档发布"
```

### Task 6: Publish Through a Scoped GitHub App Token

**Files:**
- Modify: `.github/workflows/toolchain-publish.yml`
- Modify: `tests/toolchain-workflow.test.ts`

**Interfaces:**
- Consumes: verified main bundle and publication plan
- Produces: immutable `toolchain-<revision>` release and promoted `toolchain-stable` channel

- [ ] **Step 1: Add failing authentication and transaction tests**

```typescript
test("publisher scopes the App token to the archive repository", () => {
  assert.match(publisher, /actions\/create-github-app-token/u);
  assert.match(publisher, /owner:\s*Chlience/u);
  assert.match(publisher, /repositories:\s*yt-dlp-tauri-toolchain/u);
});

test("channel promotion follows immutable release verification", () => {
  assert.ok(publisher.indexOf("Verify immutable revision") < publisher.indexOf("Promote stable channel"));
  assert.ok(publisher.indexOf("Promote stable channel") < publisher.indexOf("Update v0.1.11 compatibility"));
});
```

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `node --test --experimental-strip-types tests/toolchain-workflow.test.ts`

Expected: FAIL because publication currently writes tool assets to the main repository.

- [ ] **Step 3: Add prerequisite gates before archive mutation**

Before token creation, check exact-main state, required secrets, and policy compliance evidence. Create the repository-scoped token, then check that the archive repository exists and is public, `toolchain-stable` exists and is mutable, and the authenticated repository immutability endpoint returns enabled. Exit before creating a draft when any gate fails. The immutability endpoint requires Administration read permission.

- [ ] **Step 4: Create, upload, and verify the draft**

Use the App token to create `toolchain-<revision>` as `draft=true`, `prerelease=true`, and `make_latest=false`. Upload planned files without clobbering. Download every draft asset through the authenticated API and compare exact name, size, and SHA-256.

- [ ] **Step 5: Publish and verify immutability**

Set `draft=false`, fetch the release, require `immutable=true`, and run `gh release verify <tag> --repo Chlience/yt-dlp-tauri-toolchain`. Keep the existing stable channel unchanged on any failure.

- [ ] **Step 6: Promote and update compatibility**

PATCH only the pre-existing stable release body with the schema-v2 marker. Verify the round trip. Then use the main repository token to replace `tools-manifest.json` on the latest normal application release and verify its digest.

- [ ] **Step 7: Run the complete local suite**

Run: `npm test`

Expected: all Node and workflow contract tests pass.

- [ ] **Step 8: Commit authenticated publication**

```bash
git add .github/workflows/toolchain-publish.yml tests/toolchain-workflow.test.ts
git commit -m "ci: publish immutable toolchain archives with App authentication" -m "ci: 使用应用认证发布不可变工具链归档"
```

## Operational Stop Gate

Before any real workflow dispatch, all of these must be confirmed manually:

- Public repository `Chlience/yt-dlp-tauri-toolchain` exists.
- Mutable `toolchain-stable` prerelease was created before immutability was enabled.
- Release immutability is enabled for future releases.
- GitHub App is installed on both repositories with archive Contents write, Metadata read, and Administration read.
- Main repository secrets `TOOLCHAIN_BOT_CLIENT_ID` and `TOOLCHAIN_BOT_PRIVATE_KEY` exist.
- Redistribution evidence for every source unit passed maintainer review.

The implementation may run dry plans and fixture integration tests before this gate. It must not create a real draft, upload a real asset, publish a revision, or change the stable channel before all six checks pass.

## Acceptance Gate

- Pull-request preparation downloads each proposed unique upstream byte object once.
- Every native runner verifies and installs the same artifact bytes.
- Main accepts only the exact successful same-repository pull-request artifact.
- Exact-main native validation consumes and re-uploads those bytes.
- Every descriptor is classified exactly once as reuse or upload.
- Draft assets are downloaded and verified before publication.
- Published revision is immutable before channel promotion.
- v0.1.11 compatibility replacement is last.
- Rollback changes the channel and compatibility manifest without copying historical binaries.
