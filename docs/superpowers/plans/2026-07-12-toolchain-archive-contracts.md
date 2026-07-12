# Toolchain Archive Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every locked tool byte object a deterministic immutable archive descriptor and generate a runtime manifest containing only project-controlled archive URLs.

**Architecture:** A focused archive-contract module validates archive policy, derives content-addressed asset names, preserves descriptors for unchanged bytes, and assigns the proposed revision only to new bytes. Lock schema 2 records upstream provenance and archive identity together; manifest schema 4 adds source-byte size and SHA-256 so both the client and native validation can verify archives before extraction.

**Tech Stack:** Node.js 24 ESM, JSON policy/lock/manifest files, Node built-in test runner, Rust 2021 with serde and sha2.

## Global Constraints

- Archive repository is exactly `Chlience/yt-dlp-tauri-toolchain`.
- Immutable revision tags use `toolchain-<YYYYMMDD.N>`.
- The mutable channel tag remains `toolchain-stable` and contains no tool binaries.
- Runtime manifests contain no upstream tool download URLs.
- Validation uses local bundle bytes for new descriptors and immutable archive URLs for reused descriptors.
- Archive descriptors preserve full lowercase SHA-256 and exact byte size.
- One upstream byte object shared by multiple targets maps to one archive asset.
- Existing v0.1.11 clients must continue parsing the generated manifest.
- No binary is written to Git history.
- Production manifest migration cannot be merged before the archive repository bootstrap gate is ready.

---

## File Map

| File | Responsibility |
| --- | --- |
| `scripts/toolchain/archive-contract.mjs` | Archive policy, naming, descriptor assignment, URL rendering, and descriptor validation |
| `scripts/toolchain/policy.mjs` | Require archive and redistribution declarations for every source |
| `scripts/toolchain/resolve-lock.mjs` | Preserve historical descriptors and assign new revision descriptors after upstream resolution |
| `scripts/toolchain/generate-manifest.mjs` | Emit schema-4 runtime and candidate manifests with source-byte integrity metadata |
| `toolchain-policy.json` | Reviewed archive repository and source-specific redistribution requirements |
| `toolchain-lock.json` | Schema-2 immutable upstream and archive descriptors |
| `src-tauri/tools-manifest.json` | Schema-4 archive-only runtime contract |
| `src-tauri/src/toolchain/mod.rs` | Parse and validate source-byte integrity fields |
| `src-tauri/src/toolchain/install.rs` | Verify source bytes before file activation or ZIP extraction |
| `tests/toolchain-archive-contract.test.ts` | Archive naming, deduplication, descriptor preservation, and rejection tests |
| `tests/toolchain-lock.test.ts` | Resolver migration and unchanged-revision behavior |
| `tests/toolchain-manifest-generation.test.ts` | Runtime/candidate URL and source digest behavior |

### Task 1: Define the Archive Contract

**Files:**
- Create: `scripts/toolchain/archive-contract.mjs`
- Create: `tests/toolchain-archive-contract.test.ts`

**Interfaces:**
- Produces: `validateArchivePolicy(value, sourceId) -> ArchivePolicy`
- Produces: `archiveReleaseTag(revision) -> string`
- Produces: `archiveAssetName(source, asset, archivePolicy) -> string`
- Produces: `archiveDescriptorUrl(descriptor) -> string`
- Produces: `assignArchiveDescriptors({ policy, currentLock, candidateLock }) -> ToolchainLock`
- Produces: `validateArchiveDescriptor(descriptor, expected) -> ArchiveDescriptor`

- [ ] **Step 1: Write failing deterministic-name and descriptor tests**

```typescript
test("archive names are deterministic and safe", () => {
  const name = archiveAssetName(
    { id: "deno", version: "v2.9.2" },
    {
      target: "win-x64",
      assetName: "deno-x86_64-pc-windows-msvc.zip",
      sourceUrl: "https://github.com/denoland/deno/releases/download/v2.9.2/deno-x86_64-pc-windows-msvc.zip",
      size: 123,
      sha256: "a".repeat(64),
    },
    {
      repository: "Chlience/yt-dlp-tauri-toolchain",
      assetNameTemplate: "{source}-{version}-{assetStem}-{sha256Prefix}{extension}",
    },
  );
  assert.equal(
    name,
    "deno-v2.9.2-deno-x86_64-pc-windows-msvc-aaaaaaaaaaaaaaaa.zip",
  );
});

test("shared upstream bytes receive one descriptor", () => {
  const result = assignArchiveDescriptors({
    policy: fixturePolicy(),
    currentLock: null,
    candidateLock: sharedMacYtDlpLock("20260712.1"),
  });
  const [arm, intel] = result.sources[0].assets;
  assert.deepEqual(arm.archive, intel.archive);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test --experimental-strip-types tests/toolchain-archive-contract.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `archive-contract.mjs`.

- [ ] **Step 3: Implement strict policy and naming primitives**

```javascript
const REVISION_PATTERN = /^[0-9]{8}\.[1-9][0-9]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TEMPLATE = "{source}-{version}-{assetStem}-{sha256Prefix}{extension}";

export function archiveReleaseTag(revision) {
  if (!REVISION_PATTERN.test(revision ?? "")) {
    throw new Error(`Invalid toolchain revision: ${revision}`);
  }
  return `toolchain-${revision}`;
}

export function archiveDescriptorUrl(descriptor) {
  const value = validateArchiveDescriptor(descriptor, descriptor);
  return `https://github.com/${value.repository}/releases/download/${value.releaseTag}/${encodeURIComponent(value.assetName)}`;
}
```

Normalize source/version/asset stem to `[A-Za-z0-9._+-]`, collapse repeated separators, reject path separators and dot segments, keep a 16-character digest prefix, and cap the final UTF-8 asset name at 200 bytes.

- [ ] **Step 4: Implement byte-object grouping and descriptor reuse**

```javascript
function byteObjectKey(sourceId, asset) {
  return JSON.stringify([sourceId, asset.sourceUrl, asset.size, asset.sha256]);
}

function reusableDescriptor(currentAssets, sourceId, asset, repository) {
  const match = currentAssets.find(
    (entry) => byteObjectKey(sourceId, entry) === byteObjectKey(sourceId, asset),
  );
  if (!match?.archive || match.archive.repository !== repository) return null;
  return validateArchiveDescriptor(match.archive, asset);
}
```

Group candidate assets by `byteObjectKey`, use one preserved descriptor when available, otherwise create one descriptor with the candidate revision tag and generated asset name, and assign the same descriptor to every member of the group.

- [ ] **Step 5: Run archive-contract tests and verify GREEN**

Run: `node --test --experimental-strip-types tests/toolchain-archive-contract.test.ts`

Expected: all archive-contract tests pass.

- [ ] **Step 6: Commit the archive contract**

```bash
git add scripts/toolchain/archive-contract.mjs tests/toolchain-archive-contract.test.ts
git commit -m "feat: define immutable toolchain archive descriptors" -m "feat: 定义不可变工具链归档描述符"
```

### Task 2: Require Archive and Redistribution Policy

**Files:**
- Modify: `scripts/toolchain/policy.mjs`
- Modify: `tests/toolchain-policy.test.ts`
- Modify: `toolchain-policy.json`

**Interfaces:**
- Consumes: `validateArchivePolicy(value, sourceId)` from Task 1
- Produces: normalized `source.archive` and `source.redistribution`

- [ ] **Step 1: Add failing policy requirements**

```typescript
test("every source declares archive and redistribution policy", () => {
  const policy = productionPolicy();
  for (const source of policy.sources) {
    assert.equal(source.archive.enabled, true);
    assert.equal(source.archive.repository, "Chlience/yt-dlp-tauri-toolchain");
    assert.ok(Array.isArray(source.redistribution.licenseFiles));
    assert.ok(Array.isArray(source.redistribution.noticeFiles));
    assert.ok(source.redistribution.requiredEvidence.length > 0);
  }
});

test("policy rejects unsafe compliance paths", () => {
  const policy = fixturePolicy();
  policy.sources[0].redistribution.noticeFiles = ["../NOTICE"];
  assert.throws(() => validateToolchainPolicy(policy), /safe relative path/u);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --experimental-strip-types tests/toolchain-policy.test.ts`

Expected: FAIL because most production sources do not declare archive policy.

- [ ] **Step 3: Generalize redistribution validation**

Require exactly these fields and reject unknown unsafe values:

```javascript
const EVIDENCE_IDS = new Set([
  "official-checksum",
  "binary-release",
  "source-revision",
  "build-revision",
  "source-license",
  "third-party-notices",
]);

function validateRedistribution(value, sourceId) {
  const result = requireObject(value, `source ${sourceId} redistribution`);
  result.licenseFiles = requireSafeRelativePaths(result.licenseFiles, `${sourceId} licenseFiles`);
  result.noticeFiles = requireSafeRelativePaths(result.noticeFiles, `${sourceId} noticeFiles`);
  result.requiredEvidence = requireUniqueStrings(result.requiredEvidence, `${sourceId} requiredEvidence`);
  for (const evidence of result.requiredEvidence) {
    if (!EVIDENCE_IDS.has(evidence)) throw new Error(`source ${sourceId} uses unknown evidence ${evidence}`);
  }
  return result;
}
```

- [ ] **Step 4: Migrate production policy declarations**

Use `Chlience/yt-dlp-tauri-toolchain` and the shared deterministic template for all five source units. Preserve source-specific evidence requirements: GitHub standalone binaries require binary release, source revision, source license, and third-party notices; Windows FFmpeg additionally requires official checksum and build revision; macOS FFmpeg requires official checksum, source revision, build revision, source license, and third-party notices.

- [ ] **Step 5: Run policy tests**

Run: `node --test --experimental-strip-types tests/toolchain-policy.test.ts`

Expected: all policy tests pass.

- [ ] **Step 6: Commit policy schema 2**

```bash
git add scripts/toolchain/policy.mjs tests/toolchain-policy.test.ts toolchain-policy.json
git commit -m "feat: require archive redistribution policy" -m "feat: 要求归档再分发策略"
```

### Task 3: Attach and Preserve Archive Descriptors in the Lock

**Files:**
- Modify: `scripts/toolchain/resolve-lock.mjs`
- Modify: `tests/toolchain-lock.test.ts`
- Modify: `tests/fixtures/toolchain/current-lock.json`

**Interfaces:**
- Consumes: `assignArchiveDescriptors(...)` from Task 1
- Produces: lock schema 2 with `asset.archive`

- [ ] **Step 1: Add failing resolver lifecycle tests**

```typescript
test("unchanged archived bytes keep revision and historical release tags", async () => {
  const current = archivedCurrentLock();
  const next = await resolveFixture({ currentLock: current });
  assert.equal(next.revision, current.revision);
  assert.deepEqual(next.sources[0].assets[0].archive, current.sources[0].assets[0].archive);
});

test("one changed byte object is assigned only to the proposed revision", async () => {
  const current = archivedCurrentLock();
  const next = await resolveFixture({ currentLock: current, changedSource: "deno" });
  const changed = next.sources.find((source) => source.id === "deno");
  const unchanged = next.sources.find((source) => source.id === "yt-dlp");
  assert.equal(changed.assets[0].archive.releaseTag, `toolchain-${next.revision}`);
  assert.equal(unchanged.assets[0].archive.releaseTag, "toolchain-20260711.2");
});
```

- [ ] **Step 2: Run lock tests and verify RED**

Run: `node --test --experimental-strip-types tests/toolchain-lock.test.ts`

Expected: FAIL because resolved assets do not contain `archive`.

- [ ] **Step 3: Separate upstream-content comparison from archive completeness**

Strip `revision`, `generatedAtUtc`, schema migration metadata, and each asset's `archive` field when comparing newly resolved upstream content. Preserve the current revision only when upstream content is equal and every candidate byte object has a valid reusable archive descriptor for the configured repository.

```javascript
const rawCandidate = {
  schemaVersion: 2,
  targets: [...policy.targets].sort(compareStrings),
  sources: sources.sort((left, right) => compareStrings(left.id, right.id)),
};
const requiresArchiveAssignment = !hasCompleteArchiveDescriptors(
  policy,
  currentLock,
  rawCandidate,
);
const changed = !sameResolvedContent(rawCandidate, currentLock) || requiresArchiveAssignment;
const revision = changed ? nextRevision(currentLock?.revision, now) : currentLock.revision;
const candidate = assignArchiveDescriptors({
  policy,
  currentLock,
  candidateLock: { ...rawCandidate, revision, generatedAtUtc },
});
```

- [ ] **Step 4: Run lock and update tests**

Run: `node --test --experimental-strip-types tests/toolchain-lock.test.ts tests/update-toolchain.test.ts`

Expected: all focused tests pass and no unchanged run creates a revision.

- [ ] **Step 5: Commit lock descriptor generation**

```bash
git add scripts/toolchain/resolve-lock.mjs tests/toolchain-lock.test.ts tests/update-toolchain.test.ts tests/fixtures/toolchain/current-lock.json
git commit -m "feat: preserve archived tool bytes across revisions" -m "feat: 跨版本保留已归档工具字节"
```

### Task 4: Generate Archive-Only Schema-4 Manifests

**Files:**
- Modify: `scripts/toolchain/generate-manifest.mjs`
- Modify: `tests/toolchain-manifest-generation.test.ts`
- Modify: `tests/tool-source-url-check.test.ts`

**Interfaces:**
- Consumes: `archiveDescriptorUrl(descriptor)` from Task 1
- Produces: `generateManifest(policy, lock, { sourceMode: "runtime" | "candidate" | "upstream" })`
- Produces: manifest tool fields `sourceSize` and `sourceSha256`

- [ ] **Step 1: Add failing runtime and candidate manifest tests**

```typescript
test("runtime manifest contains only archive descriptors", () => {
  const manifest = generateManifest(policy, archivedLock());
  for (const target of manifest.targets) {
    for (const tool of target.tools) {
      assert.match(tool.sourceUrl, /^https:\/\/github\.com\/Chlience\/yt-dlp-tauri-toolchain\/releases\/download\/toolchain-/u);
      assert.match(tool.sourceSha256, /^[a-f0-9]{64}$/u);
      assert.ok(tool.sourceSize > 0);
    }
  }
});

test("candidate manifest uses upstream only for bytes assigned to its revision", () => {
  const lock = mixedRevisionLock();
  const manifest = generateManifest(policy, lock, { sourceMode: "candidate" });
  assert.equal(findTool(manifest, "deno").sourceUrl, findLockAsset(lock, "deno").sourceUrl);
  assert.match(findTool(manifest, "yt-dlp").sourceUrl, /yt-dlp-tauri-toolchain/u);
});
```

- [ ] **Step 2: Run manifest tests and verify RED**

Run: `node --test --experimental-strip-types tests/toolchain-manifest-generation.test.ts`

Expected: FAIL because runtime generation still emits upstream URLs for most tools.

- [ ] **Step 3: Implement source modes and source-byte metadata**

```javascript
function manifestSourceUrl(asset, revision, sourceMode) {
  if (sourceMode === "upstream") return asset.sourceUrl;
  if (sourceMode === "candidate" && asset.archive.releaseTag === `toolchain-${revision}`) {
    return asset.sourceUrl;
  }
  return archiveDescriptorUrl(asset.archive);
}

const tool = {
  name: member.tool,
  path: member.path,
  sourceUrl,
  sourceSize: asset.size,
  sourceSha256: asset.sha256,
  version,
  sha256: member.sha256,
  kind: asset.kind,
  licenseNotes: member.licenseNotes,
};
```

Emit `schemaVersion: 4`. Require all tools sharing a `sourceUrl` to share `sourceSize`, `sourceSha256`, and kind.

- [ ] **Step 4: Run manifest and source URL tests**

Run: `node --test --experimental-strip-types tests/toolchain-manifest-generation.test.ts tests/tool-source-url-check.test.ts`

Expected: all tests pass and runtime fixtures contain no upstream tool URL.

- [ ] **Step 5: Commit schema-4 generation**

```bash
git add scripts/toolchain/generate-manifest.mjs tests/toolchain-manifest-generation.test.ts tests/tool-source-url-check.test.ts
git commit -m "feat: generate archive-only tool manifests" -m "feat: 生成仅使用归档地址的工具清单"
```

### Task 5: Verify Source Bytes in the Shared Rust Installer

**Files:**
- Modify: `src-tauri/src/toolchain/mod.rs`
- Modify: `src-tauri/src/toolchain/install.rs`

**Interfaces:**
- Consumes: manifest schema 4 from Task 4
- Produces: `ManifestTool { source_size: Option<u64>, source_sha256: Option<String>, ... }`
- Produces: source-byte verification before executable copy or ZIP extraction

- [ ] **Step 1: Add failing schema and source-byte tests**

```rust
#[test]
fn schema_four_requires_source_integrity() {
    let manifest = r#"{"schemaVersion":4,"revision":"20260712.1","targets":[{"target":"win-x64","tools":[{"name":"yt-dlp","path":"Tools/win-x64/yt-dlp/yt-dlp.exe","sourceUrl":"https://example.test/yt-dlp.exe","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"file"}]}]}"#;
    assert!(parse_manifest(manifest).unwrap_err().contains("sourceSha256"));
}

#[test]
fn downloaded_source_digest_must_match_before_extraction() {
    let path = fixture_file(b"unexpected");
    assert!(verify_source_file(&path, 8, &"a".repeat(64)).is_err());
}
```

- [ ] **Step 2: Run Rust tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib source_`

Expected: FAIL because source integrity fields and verifier are missing.

- [ ] **Step 3: Parse schema-4 integrity fields with legacy compatibility**

Add optional serde fields so schema 2/3 bundled manifests remain readable. In `parse_manifest`, require a valid positive `sourceSize` and lowercase 64-character `sourceSha256` for every schema-4 tool. Require matching integrity metadata for tools grouped under one archive URL.

- [ ] **Step 4: Verify complete downloaded files before use**

```rust
fn verify_source_file(path: &Path, expected_size: u64, expected_sha256: &str) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(to_string)?;
    if metadata.len() != expected_size {
        return Err(format!("Downloaded source has {} bytes, expected {expected_size}", metadata.len()));
    }
    verify_sha256(path, expected_sha256)
}
```

Call this after each complete file/ZIP download and before executable marking or archive extraction. Keep extracted-member SHA-256 verification unchanged.

- [ ] **Step 5: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all Rust library tests pass.

- [ ] **Step 6: Commit source-byte verification**

```bash
git add src-tauri/src/toolchain/mod.rs src-tauri/src/toolchain/install.rs
git commit -m "feat: verify tool archive bytes before extraction" -m "feat: 在解压前验证工具归档字节"
```

### Task 6: Generate the First Archive Revision Metadata

**Files:**
- Modify: `toolchain-lock.json`
- Modify: `src-tauri/tools-manifest.json`
- Modify: `TOOLCHAIN_CHANGELOG.md`
- Modify: affected fixture JSON files

**Interfaces:**
- Consumes: production policy and resolver from Tasks 2-4
- Produces: first proposed archive revision with 10 unique upload descriptors

- [ ] **Step 1: Run the updater in dry-run mode**

Run: `node scripts/update-toolchain.mjs --dry-run`

Expected: one proposed revision, every asset has a valid archive descriptor, and duplicate universal macOS yt-dlp references share one descriptor.

- [ ] **Step 2: Apply generated metadata**

Run: `node scripts/update-toolchain.mjs`

Expected: lock, runtime manifest, and toolchain changelog change together; no binary file is created under a tracked path.

- [ ] **Step 3: Verify generated invariants**

Run: `npm test`

Expected: all Node tests pass, production runtime URLs point only to the archive repository, and exactly 10 distinct descriptors target the proposed revision.

- [ ] **Step 4: Verify application compatibility**

Run: `npm run build`

Expected: TypeScript and Vite build succeed.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all Rust library tests pass and v0.1.11-compatible serde parsing remains covered.

- [ ] **Step 5: Commit first-revision metadata**

```bash
git add toolchain-lock.json src-tauri/tools-manifest.json TOOLCHAIN_CHANGELOG.md tests/fixtures
git commit -m "chore: prepare the first archived toolchain revision" -m "chore: 准备首个归档工具链版本"
```

## Acceptance Gate

- Every lock asset has one validated archive descriptor.
- The 11 target references collapse to 10 unique archive assets.
- Unchanged bytes preserve historical release tags in a subsequent fixture resolution.
- Runtime manifest schema 4 has no upstream download URL.
- Candidate mode uses upstream acquisition only for descriptors assigned to the proposed revision.
- Source archives are size- and SHA-256-verified before use.
- Node tests, frontend build, and Rust tests pass.
- No production publication is attempted by this plan.
