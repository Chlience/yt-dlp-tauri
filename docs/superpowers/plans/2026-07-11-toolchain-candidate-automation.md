# Toolchain Candidate Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the yt-dlp-only updater with one policy-driven resolver that maintains yt-dlp, Deno, FFmpeg, FFprobe, a reviewed lock file, and weekly or emergency pull requests.

**Architecture:** A checked-in JSON policy describes GitHub Release and immutable redirect sources. Focused Node modules resolve releases, inspect assets, generate a lock and runtime manifest, and update one bot branch. This phase continues to publish upstream URLs; project-hosted FFmpeg promotion begins in the validation and publication plan.

**Tech Stack:** Node.js 24 ESM, built-in Node test runner, GitHub REST API, PowerShell 5+, GitHub Actions, JSON fixtures.

## Global Constraints

- Track yt-dlp and Deno latest stable releases once per week.
- Track the final Windows FFmpeg autobuild from the previous complete UTC month.
- Track the latest immutable macOS FFmpeg release-build redirects for Intel and ARM64.
- Ignore draft and prerelease GitHub releases.
- Keep one combined weekly PR with human merge.
- Create a focused emergency PR when a released URL becomes unavailable or a maintainer dispatches one.
- Keep fixed immutable URLs and extracted executable SHA-256 values in `src-tauri/tools-manifest.json`.
- Keep the desktop client isolated from direct upstream version discovery.
- Use a GitHub App installation token for bot branches and PRs.
- Keep all third-party Action references pinned to reviewed commit SHAs.
- Do not publish release assets in this phase.

---

## File Map

| File | Responsibility |
| --- | --- |
| `toolchain-policy.json` | Reviewed source, target, selector, and host policy |
| `toolchain-lock.json` | Resolved immutable upstream metadata and executable hashes |
| `TOOLCHAIN_CHANGELOG.md` | Toolchain-only revision history |
| `scripts/toolchain/policy.mjs` | Parse and validate policy data |
| `scripts/toolchain/github-releases.mjs` | Authenticated GitHub Release adapter |
| `scripts/toolchain/redirect-release.mjs` | Resolve official macOS immutable redirect URLs |
| `scripts/toolchain/select-release.mjs` | Stable and previous-month selection rules |
| `scripts/toolchain/inspect-asset.mjs` | Download, hash, list ZIP members, and hash selected members |
| `scripts/toolchain/resolve-lock.mjs` | Resolve all source units into one lock |
| `scripts/toolchain/generate-manifest.mjs` | Generate runtime manifest and changelog from the lock |
| `scripts/update-toolchain.mjs` | CLI orchestration, fixture mode, and focused emergency mode |
| `scripts/check-toolchain-freshness.mjs` | Check the released lock and produce actionable stale-source data |
| `.github/workflows/toolchain-discover.yml` | Weekly combined update PR |
| `.github/workflows/toolchain-freshness.yml` | Daily health check and emergency PR |

### Task 1: Define and Validate Toolchain Policy

**Files:**
- Create: `toolchain-policy.json`
- Create: `scripts/toolchain/policy.mjs`
- Create: `tests/toolchain-policy.test.ts`

**Interfaces:**
- Produces: `readToolchainPolicy(path: string): ToolchainPolicy`
- Produces: `validateToolchainPolicy(value: unknown): ToolchainPolicy`
- Produces: `sourceById(policy: ToolchainPolicy, id: string): ToolchainSourcePolicy`

- [ ] **Step 1: Write failing policy tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { readToolchainPolicy, validateToolchainPolicy } from "../scripts/toolchain/policy.mjs";

test("production policy covers every populated manifest target", () => {
  const policy = readToolchainPolicy("toolchain-policy.json");
  assert.deepEqual(policy.targets, ["win-x64", "macos-x64", "macos-arm64"]);
  assert.deepEqual(policy.sources.map((source) => source.id), [
    "yt-dlp",
    "deno",
    "ffmpeg-windows",
    "ffmpeg-macos-x64",
    "ffmpeg-macos-arm64",
  ]);
});

test("policy rejects an unapproved host", () => {
  assert.throws(
    () => validateToolchainPolicy({
      schemaVersion: 1,
      targets: ["win-x64"],
      approvedHosts: ["github.com"],
      sources: [{ id: "bad", adapter: "redirect-release", urls: ["https://evil.test/tool.zip"] }],
    }),
    /unapproved host evil\.test/,
  );
});
```

- [ ] **Step 2: Run the tests and confirm the missing-module failure**

Run: `node --test --experimental-strip-types tests/toolchain-policy.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/toolchain/policy.mjs`.

- [ ] **Step 3: Add the exact policy schema and production source definitions**

Create `toolchain-policy.json` with schema version `1`, the three populated targets, approved hosts `api.github.com`, `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com`, and `ffmpeg.martin-riedl.de`, plus these source units:

```json
{
  "id": "yt-dlp",
  "adapter": "github-release",
  "repository": "yt-dlp/yt-dlp",
  "selection": "latest-stable"
}
```

```json
{
  "id": "deno",
  "adapter": "github-release",
  "repository": "denoland/deno",
  "selection": "latest-stable"
}
```

```json
{
  "id": "ffmpeg-windows",
  "adapter": "github-release",
  "repository": "yt-dlp/FFmpeg-Builds",
  "selection": "previous-complete-month",
  "assetPattern": "^ffmpeg-N-[0-9]+-g[a-f0-9]+-win64-gpl\\.zip$"
}
```

The two macOS source units use `redirect-release` and the release-build URLs:

```text
https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip
https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffprobe.zip
https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip
https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip
```

Each asset mapping must include `target`, `tools`, `kind`, `archivePathSuffix`, and runtime `path`. Use the existing manifest paths verbatim.

Use this complete target mapping:

| Source | Target | Asset selector | Kind | Tool/member mapping |
| --- | --- | --- | --- | --- |
| yt-dlp | win-x64 | exact `yt-dlp.exe` | file | `yt-dlp` -> `Tools/win-x64/yt-dlp/yt-dlp.exe` |
| yt-dlp | macos-x64 | exact `yt-dlp_macos` | file | `yt-dlp` -> `Tools/macos-x64/yt-dlp/yt-dlp` |
| yt-dlp | macos-arm64 | exact `yt-dlp_macos` | file | `yt-dlp` -> `Tools/macos-arm64/yt-dlp/yt-dlp` |
| deno | win-x64 | exact `deno-x86_64-pc-windows-msvc.zip` | zip | `deno.exe` -> `Tools/win-x64/deno/deno.exe` |
| deno | macos-x64 | exact `deno-x86_64-apple-darwin.zip` | zip | `deno` -> `Tools/macos-x64/deno/deno` |
| deno | macos-arm64 | exact `deno-aarch64-apple-darwin.zip` | zip | `deno` -> `Tools/macos-arm64/deno/deno` |
| ffmpeg-windows | win-x64 | source `assetPattern` | zip | `bin/ffmpeg.exe` and `bin/ffprobe.exe` -> existing Windows runtime paths |
| ffmpeg-macos-x64 | macos-x64 | two redirect URLs | zip | root `ffmpeg` and `ffprobe` -> existing Intel runtime paths |
| ffmpeg-macos-arm64 | macos-arm64 | two redirect URLs | zip | root `ffmpeg` and `ffprobe` -> existing ARM64 runtime paths |

- [ ] **Step 4: Implement strict validation**

```js
export function validateToolchainPolicy(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new Error("toolchain-policy.json schemaVersion must be 1");
  }
  if (!Array.isArray(value.targets) || !Array.isArray(value.sources)) {
    throw new Error("Toolchain policy must define targets and sources arrays");
  }
  const approvedHosts = new Set(value.approvedHosts ?? []);
  for (const source of value.sources) {
    if (typeof source.id !== "string" || typeof source.adapter !== "string") {
      throw new Error("Every toolchain source requires id and adapter");
    }
    for (const url of source.urls ?? []) {
      const host = new URL(url).hostname;
      if (!approvedHosts.has(host)) {
        throw new Error(`Toolchain source ${source.id} uses unapproved host ${host}`);
      }
    }
  }
  return value;
}
```

- [ ] **Step 5: Run the policy tests**

Run: `node --test --experimental-strip-types tests/toolchain-policy.test.ts`

Expected: 2 tests pass.

- [ ] **Step 6: Commit the policy boundary**

```bash
git add toolchain-policy.json scripts/toolchain/policy.mjs tests/toolchain-policy.test.ts
git commit -m "feat: define toolchain source policy" -m "feat: 定义工具链来源策略"
```

### Task 2: Implement Release Source Adapters

**Files:**
- Create: `scripts/toolchain/github-releases.mjs`
- Create: `scripts/toolchain/redirect-release.mjs`
- Create: `tests/toolchain-release-adapters.test.ts`
- Create: `tests/fixtures/toolchain/github-releases.json`
- Create: `tests/fixtures/toolchain/redirect-releases.json`

**Interfaces:**
- Consumes: validated source entries from `policy.mjs`
- Produces: `fetchGitHubReleases(repository, options): Promise<ReleaseRecord[]>`
- Produces: `resolveRedirectAsset(url, options): Promise<RedirectAsset>`

- [ ] **Step 1: Add failing adapter tests with injected fetch**

```ts
test("GitHub adapter authenticates and normalizes releases", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await fetchGitHubReleases("yt-dlp/yt-dlp", {
    token: "test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify([{ id: 7, tag_name: "2026.07.04", draft: false, prerelease: false, assets: [] }]));
    },
  });
  assert.equal(calls[0].init?.headers.Authorization, "Bearer test-token");
  assert.equal(result[0].tagName, "2026.07.04");
});

test("redirect adapter returns the immutable location", async () => {
  const result = await resolveRedirectAsset("https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip", {
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1783011502_8.1.2/ffmpeg.zip" },
    }),
  });
  assert.equal(result.version, "8.1.2");
  assert.match(result.url, /1783011502_8\.1\.2\/ffmpeg\.zip$/);
});
```

- [ ] **Step 2: Confirm adapter tests fail**

Run: `node --test --experimental-strip-types tests/toolchain-release-adapters.test.ts`

Expected: FAIL because both adapter modules are missing.

- [ ] **Step 3: Implement authenticated paginated GitHub requests**

Use `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, a descriptive user agent, `per_page=100`, and `Authorization: Bearer` when `GITHUB_TOKEN` is present. Normalize snake_case API fields at this boundary.

- [ ] **Step 4: Implement manual redirect resolution**

```js
export async function resolveRedirectAsset(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { method: "HEAD", redirect: "manual" });
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    throw new Error(`Expected release redirect for ${url}, received ${response.status}`);
  }
  const location = response.headers.get("location");
  if (!location) throw new Error(`Release redirect for ${url} is missing Location`);
  const resolved = new URL(location, url).toString();
  const version = new URL(resolved).pathname.match(/_[v]?([0-9]+\.[0-9]+\.[0-9]+)\//)?.[1];
  if (!version) throw new Error(`Unable to read release version from ${resolved}`);
  return { url: resolved, version, checksumUrl: `${resolved}.sha256` };
}
```

- [ ] **Step 5: Run adapter tests**

Run: `node --test --experimental-strip-types tests/toolchain-release-adapters.test.ts`

Expected: all adapter tests pass.

- [ ] **Step 6: Commit source adapters**

```bash
git add scripts/toolchain/github-releases.mjs scripts/toolchain/redirect-release.mjs tests/toolchain-release-adapters.test.ts tests/fixtures/toolchain
git commit -m "feat: resolve immutable tool releases" -m "feat: 解析不可变工具版本"
```

### Task 3: Implement Tool-Specific Version Selection

**Files:**
- Create: `scripts/toolchain/select-release.mjs`
- Create: `tests/toolchain-release-selection.test.ts`

**Interfaces:**
- Produces: `selectLatestStable(releases: ReleaseRecord[]): ReleaseRecord`
- Produces: `selectPreviousCompleteMonth(releases: ReleaseRecord[], now: Date): ReleaseRecord`

- [ ] **Step 1: Add failing selector tests**

```ts
test("latest stable ignores draft and prerelease", () => {
  const selected = selectLatestStable([
    { tagName: "v3.0.0-rc.1", draft: false, prerelease: true, publishedAt: "2026-07-10T00:00:00Z" },
    { tagName: "v2.9.0", draft: false, prerelease: false, publishedAt: "2026-07-09T00:00:00Z" },
  ]);
  assert.equal(selected.tagName, "v2.9.0");
});

test("previous month selector chooses the final June autobuild in July", () => {
  const selected = selectPreviousCompleteMonth([
    { tagName: "autobuild-2026-06-29-17-10", draft: false, prerelease: false, publishedAt: "2026-06-29T17:10:58Z" },
    { tagName: "autobuild-2026-06-30-16-38", draft: false, prerelease: false, publishedAt: "2026-06-30T16:38:32Z" },
    { tagName: "autobuild-2026-07-01-16-32", draft: false, prerelease: false, publishedAt: "2026-07-01T16:32:48Z" },
  ], new Date("2026-07-11T00:00:00Z"));
  assert.equal(selected.tagName, "autobuild-2026-06-30-16-38");
});
```

- [ ] **Step 2: Run and confirm missing selector failures**

Run: `node --test --experimental-strip-types tests/toolchain-release-selection.test.ts`

Expected: FAIL because `select-release.mjs` is missing.

- [ ] **Step 3: Implement deterministic UTC selection**

Sort stable releases by `publishedAt` descending. For previous-month selection, compute the UTC year and month immediately before `now`, filter release publication dates to that month, and return the newest item. Throw an actionable error when no candidate exists.

- [ ] **Step 4: Run selector tests**

Run: `node --test --experimental-strip-types tests/toolchain-release-selection.test.ts`

Expected: all selector tests pass.

- [ ] **Step 5: Commit selectors**

```bash
git add scripts/toolchain/select-release.mjs tests/toolchain-release-selection.test.ts
git commit -m "feat: select releases by tool policy" -m "feat: 按工具策略选择版本"
```

### Task 4: Inspect and Hash Candidate Assets

**Files:**
- Create: `scripts/toolchain/inspect-asset.mjs`
- Create: `tests/toolchain-asset-inspection.test.ts`

**Interfaces:**
- Produces: `sha256File(path: string): Promise<string>`
- Produces: `inspectAsset(request: InspectAssetRequest): Promise<InspectedAsset>`
- Produces: `selectArchiveMember(entries: string[], suffix: string): string`

- [ ] **Step 1: Add failing member-selection and digest tests**

```ts
test("archive member selection requires exactly one normalized suffix match", () => {
  assert.equal(
    selectArchiveMember(["ffmpeg-build/bin/ffmpeg.exe", "ffmpeg-build/bin/ffprobe.exe"], "bin/ffmpeg.exe"),
    "ffmpeg-build/bin/ffmpeg.exe",
  );
  assert.throws(() => selectArchiveMember(["a/bin/ffmpeg.exe", "b/bin/ffmpeg.exe"], "bin/ffmpeg.exe"), /multiple archive members/);
});

test("sha256File returns lowercase hex", async () => {
  const root = await mkdtemp(join(tmpdir(), "toolchain-hash-"));
  const path = join(root, "asset.bin");
  await writeFile(path, "abc");
  assert.equal(await sha256File(path), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
```

- [ ] **Step 2: Confirm inspection tests fail**

Run: `node --test --experimental-strip-types tests/toolchain-asset-inspection.test.ts`

Expected: FAIL because `inspect-asset.mjs` is missing.

- [ ] **Step 3: Implement streamed downloads and ZIP inspection**

Download into a caller-provided temporary directory, hash while streaming, list ZIP members with `unzip -Z1`, and extract only an exact selected member with `unzip -p`. Reject absolute paths, `..` segments, zero matches, and multiple matches. Return archive digest plus per-member digest and byte count.

- [ ] **Step 4: Run inspection tests**

Run: `node --test --experimental-strip-types tests/toolchain-asset-inspection.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit asset inspection**

```bash
git add scripts/toolchain/inspect-asset.mjs tests/toolchain-asset-inspection.test.ts
git commit -m "feat: inspect toolchain release assets" -m "feat: 检查工具链发布资产"
```

### Task 5: Resolve a Deterministic Toolchain Lock

**Files:**
- Create: `scripts/toolchain/resolve-lock.mjs`
- Create: `tests/toolchain-lock.test.ts`
- Create: `tests/fixtures/toolchain/current-lock.json`

**Interfaces:**
- Consumes: policy, source adapters, selectors, and `inspectAsset`
- Produces: `resolveToolchainLock(options): Promise<ToolchainLock>`
- Produces: `nextRevision(current: string | undefined, now: Date): string`

- [ ] **Step 1: Add failing lock tests**

```ts
test("nextRevision increments revisions generated on the same UTC day", () => {
  assert.equal(nextRevision("20260711.1", new Date("2026-07-11T12:00:00Z")), "20260711.2");
  assert.equal(nextRevision("20260710.7", new Date("2026-07-11T12:00:00Z")), "20260711.1");
});

test("resolver groups ffmpeg and ffprobe from one Windows archive", async () => {
  const lock = await resolveToolchainLock(fixtureOptions());
  const source = lock.sources.find((item) => item.id === "ffmpeg-windows");
  assert.equal(source.assets.length, 1);
  assert.deepEqual(source.assets[0].members.map((member) => member.tool), ["ffmpeg", "ffprobe"]);
});

test("unchanged resolved sources preserve revision and generation time", async () => {
  const currentLock = lockFixture("20260710.3");
  const lock = await resolveToolchainLock(fixtureOptions({ currentLock }));
  assert.equal(lock.revision, "20260710.3");
  assert.equal(lock.generatedAtUtc, currentLock.generatedAtUtc);
});
```

- [ ] **Step 2: Run and confirm lock tests fail**

Run: `node --test --experimental-strip-types tests/toolchain-lock.test.ts`

Expected: FAIL because `resolve-lock.mjs` is missing.

- [ ] **Step 3: Implement lock resolution with injected boundaries**

The exported function accepts `{ policy, currentLock, now, githubAdapter, redirectAdapter, inspectAsset }`. Sort sources, assets, members, and targets before serialization. Compare resolved source content while excluding revision and generation time; preserve both fields when content is unchanged and call `nextRevision` only after a real source change. Exclude transient download paths and unrelated API response fields from the lock.

- [ ] **Step 4: Run lock tests**

Run: `node --test --experimental-strip-types tests/toolchain-lock.test.ts`

Expected: all lock tests pass with stable snapshots.

- [ ] **Step 5: Commit lock resolution**

```bash
git add scripts/toolchain/resolve-lock.mjs tests/toolchain-lock.test.ts tests/fixtures/toolchain/current-lock.json
git commit -m "feat: resolve the toolchain lock" -m "feat: 解析工具链锁定文件"
```

### Task 6: Generate Runtime Manifest and Toolchain Changelog

**Files:**
- Create: `scripts/toolchain/generate-manifest.mjs`
- Create: `tests/toolchain-manifest-generation.test.ts`
- Create: `TOOLCHAIN_CHANGELOG.md`
- Modify: `src-tauri/tools-manifest.json`

**Interfaces:**
- Consumes: `ToolchainLock`
- Produces: `generateManifest(policy, lock): ToolsManifest`
- Produces: `renderToolchainChangelog(previous, current): string`

- [ ] **Step 1: Add failing generation tests**

```ts
test("manifest generation uses extracted hashes and fixed source URLs", () => {
  const manifest = generateManifest(policyFixture(), lockFixture());
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.revision, "20260711.1");
  for (const target of manifest.targets) {
    for (const tool of target.tools) {
      assert.doesNotMatch(tool.sourceUrl, /\/latest\//);
      assert.match(tool.sha256, /^[a-f0-9]{64}$/);
    }
  }
});

test("toolchain changelog records one revision without app release notes", () => {
  const text = renderToolchainChangelog(lockFixture("20260710.1"), lockFixture("20260711.1"));
  assert.match(text, /## 20260711\.1/);
  assert.doesNotMatch(text, /## Unreleased/);
});
```

- [ ] **Step 2: Run and confirm generation failures**

Run: `node --test --experimental-strip-types tests/toolchain-manifest-generation.test.ts`

Expected: FAIL because the generator is missing.

- [ ] **Step 3: Implement deterministic generation**

Generate target order `win-x64`, `macos-x64`, `macos-arm64` and tool order `yt-dlp`, `ffmpeg`, `ffprobe`, `deno`. Keep `retrievedAtUtc` equal to the lock generation time. In this phase, `sourceUrl` remains the immutable upstream URL even when the lock records a future mirror filename.

- [ ] **Step 4: Run generation tests**

Run: `node --test --experimental-strip-types tests/toolchain-manifest-generation.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit generation**

```bash
git add scripts/toolchain/generate-manifest.mjs tests/toolchain-manifest-generation.test.ts TOOLCHAIN_CHANGELOG.md src-tauri/tools-manifest.json
git commit -m "feat: generate versioned tool manifests" -m "feat: 生成版本化工具清单"
```

### Task 7: Make the Windows Restore Script Manifest-Driven

**Files:**
- Modify: `scripts/download-tools.ps1`
- Create: `tests/windows-tool-restore-script.test.ts`

**Interfaces:**
- Consumes: `src-tauri/tools-manifest.json`, target `win-x64`
- Produces: the existing development checkout paths under `src-tauri/Tools/win-x64`

- [ ] **Step 1: Add a failing contract test**

```ts
test("Windows restore script reads the production manifest", () => {
  const script = readFileSync("scripts/download-tools.ps1", "utf8");
  assert.match(script, /Get-Content .*tools-manifest\.json.*ConvertFrom-Json/);
  assert.doesNotMatch(script, /releases\/download\/2026\.07\.04\/yt-dlp\.exe/);
  assert.doesNotMatch(script, /autobuild-2026-06-22-18-32/);
});
```

- [ ] **Step 2: Confirm the contract test fails**

Run: `node --test --experimental-strip-types tests/windows-tool-restore-script.test.ts`

Expected: FAIL because URLs are embedded in the PowerShell script.

- [ ] **Step 3: Replace embedded metadata with manifest iteration**

Load the manifest, select `win-x64`, group ZIP tools by `sourceUrl`, download each source once, extract to a temporary directory, copy each `archivePathSuffix`, and run `Assert-Hash` against each extracted destination. File tools download directly. Keep cleanup in a `try`/`finally` block.

- [ ] **Step 4: Run the PowerShell contract and Node suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit the restore script**

```bash
git add scripts/download-tools.ps1 tests/windows-tool-restore-script.test.ts
git commit -m "refactor: restore Windows tools from the manifest" -m "refactor: 从清单恢复 Windows 工具"
```

### Task 8: Add the Update CLI

**Files:**
- Create: `scripts/update-toolchain.mjs`
- Create: `tests/update-toolchain.test.ts`
- Create: `tests/fixtures/toolchain/resolver-input.json`

**Interfaces:**
- Consumes: policy, current lock, adapters, resolver, and generator
- Produces: exit code `0` and JSON summary `{ changed, revision, updatedSources }`

- [ ] **Step 1: Add failing CLI tests around `runUpdateToolchain`**

```ts
test("fixture update writes lock, manifest, and toolchain changelog together", async () => {
  const result = await runUpdateToolchain({
    policyPath,
    lockPath,
    manifestPath,
    changelogPath,
    fixturePath,
    now: new Date("2026-07-11T00:00:00Z"),
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.updatedSources.sort(), ["deno", "ffmpeg-windows", "yt-dlp"]);
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).revision, result.revision);
});
```

- [ ] **Step 2: Confirm the CLI test fails**

Run: `node --test --experimental-strip-types tests/update-toolchain.test.ts`

Expected: FAIL because `update-toolchain.mjs` is missing.

- [ ] **Step 3: Implement CLI arguments**

Support exact flags `--policy`, `--lock`, `--manifest`, `--changelog`, `--fixture`, `--only`, `--now`, and `--dry-run`. `--only` accepts one source ID and is used by emergency workflows. Write files only after every output has been generated successfully.

- [ ] **Step 4: Run CLI and full Node tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit the CLI**

```bash
git add scripts/update-toolchain.mjs tests/update-toolchain.test.ts tests/fixtures/toolchain/resolver-input.json
git commit -m "feat: add the unified toolchain updater" -m "feat: 添加统一工具链更新器"
```

### Task 9: Generalize Freshness Diagnostics

**Files:**
- Create: `scripts/check-toolchain-freshness.mjs`
- Modify: `scripts/check-tool-source-urls.mjs`
- Create: `tests/toolchain-freshness.test.ts`

**Interfaces:**
- Produces: `evaluateToolchainFreshness(lock, manifest, checkUrl): Promise<FreshnessResult>`
- `FreshnessResult` is `{ ok, failedSourceIds, problems }`

- [ ] **Step 1: Add failing diagnostic tests**

```ts
test("freshness maps a shared ffmpeg URL failure to one source unit", async () => {
  const result = await evaluateToolchainFreshness(lockFixture(), manifestFixture(), async (url) => ({
    ok: !url.includes("FFmpeg-Builds"),
    status: url.includes("FFmpeg-Builds") ? 404 : 200,
    statusText: url.includes("FFmpeg-Builds") ? "Not Found" : "OK",
  }));
  assert.deepEqual(result.failedSourceIds, ["ffmpeg-windows"]);
  assert.equal(result.problems.filter((problem) => problem.includes("ffmpeg-windows")).length, 1);
});
```

- [ ] **Step 2: Confirm the diagnostic test fails**

Run: `node --test --experimental-strip-types tests/toolchain-freshness.test.ts`

Expected: FAIL because `check-toolchain-freshness.mjs` is missing.

- [ ] **Step 3: Implement lock-aware diagnostics**

Reuse retry behavior from `check-tool-source-urls.mjs`, preserve 404 as fatal, and group duplicate runtime tool references by lock source ID. Add `--json-output` so the workflow can read failed source IDs without parsing prose.

- [ ] **Step 4: Run freshness and existing URL tests**

Run: `node --test --experimental-strip-types tests/toolchain-freshness.test.ts tests/tool-source-url-check.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit diagnostics**

```bash
git add scripts/check-toolchain-freshness.mjs scripts/check-tool-source-urls.mjs tests/toolchain-freshness.test.ts
git commit -m "feat: diagnose stale toolchain sources" -m "feat: 诊断失效工具链来源"
```

### Task 10: Add Weekly and Emergency PR Workflows

**Files:**
- Create: `.github/workflows/toolchain-discover.yml`
- Modify: `.github/workflows/toolchain-freshness.yml`
- Modify: `tests/toolchain-workflow.test.ts`

**Interfaces:**
- Consumes repository secrets `TOOLCHAIN_BOT_CLIENT_ID` and `TOOLCHAIN_BOT_PRIVATE_KEY`
- Produces branches `bot/toolchain-weekly` and `bot/toolchain-emergency-{source-id}`

- [ ] **Step 1: Replace workflow tests with failing contract assertions**

```ts
test("weekly workflow uses a GitHub App and one managed branch", () => {
  const workflow = readFileSync(".github/workflows/toolchain-discover.yml", "utf8");
  assert.match(workflow, /cron: "17 3 \* \* 1"/);
  assert.match(workflow, /actions\/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349/);
  assert.match(workflow, /bot\/toolchain-weekly/);
  assert.match(workflow, /node scripts\/update-toolchain\.mjs/);
});

test("freshness workflow creates focused emergency PRs", () => {
  const workflow = readFileSync(".github/workflows/toolchain-freshness.yml", "utf8");
  assert.match(workflow, /cron: "41 4 \* \* \*"/);
  assert.match(workflow, /check-toolchain-freshness\.mjs/);
  assert.match(workflow, /--only/);
  assert.match(workflow, /bot\/toolchain-emergency-/);
});
```

- [ ] **Step 2: Confirm workflow contract tests fail**

Run: `node --test --experimental-strip-types tests/toolchain-workflow.test.ts`

Expected: FAIL because the weekly workflow is missing and freshness still targets yt-dlp only.

- [ ] **Step 3: Implement the weekly workflow**

Pin checkout to `93cb6efe18208431cddfb8368fd83d5badbf9bfd`, setup-node to `a0853c24544627f65ddf259abe73b1d18a591444`, and create-github-app-token to `fee1f7d63c2ff003460e3d139729b119787bc349`. Generate outputs, run `npm ci`, `npm test`, `npm run build`, and source URL checks before pushing the bot branch and creating or editing the PR.

- [ ] **Step 4: Implement daily emergency generation**

Run freshness first. For each failed source ID, invoke the focused form, for example `node scripts/update-toolchain.mjs --only ffmpeg-windows`, validate generated files, and create or update the corresponding bot PR. Manual dispatch accepts `tool` and `reason` inputs and follows the same path.

- [ ] **Step 5: Run workflow and full Node tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit workflows**

```bash
git add .github/workflows/toolchain-discover.yml .github/workflows/toolchain-freshness.yml tests/toolchain-workflow.test.ts
git commit -m "feat: automate reviewed toolchain pull requests" -m "feat: 自动创建工具链审核 PR"
```

### Task 11: Retire the yt-dlp-Only Updater

**Files:**
- Delete: `.github/workflows/update-yt-dlp.yml`
- Delete: `scripts/update-yt-dlp-manifest.mjs`
- Delete: `tests/update-yt-dlp-manifest.test.ts`
- Delete: `tests/fixtures/yt-dlp-latest-release.json`
- Modify: `scripts/check-yt-dlp-release.mjs`
- Modify: `tests/yt-dlp-release-check.test.ts`
- Modify: `README.md`
- Modify: `README_zh.md`
- Modify: `CONTRIBUTING.md`

**Interfaces:**
- Consumes: unified lock and updater from Tasks 5-10
- Produces: no duplicate updater or stale documentation

- [ ] **Step 1: Add a failing repository contract test**

```ts
test("repository has one toolchain updater", () => {
  assert.equal(existsSync(".github/workflows/update-yt-dlp.yml"), false);
  assert.equal(existsSync("scripts/update-yt-dlp-manifest.mjs"), false);
  assert.equal(existsSync("scripts/update-toolchain.mjs"), true);
});
```

- [ ] **Step 2: Confirm the contract fails while old files remain**

Run: `node --test --experimental-strip-types tests/toolchain-workflow.test.ts`

Expected: FAIL because the yt-dlp-only workflow and script still exist.

- [ ] **Step 3: Remove duplicate automation and point yt-dlp checks at the lock**

Keep `check-yt-dlp-release.mjs` as a focused diagnostic used by tests, but source its expected version and assets from `toolchain-lock.json`. Update documentation to describe the weekly combined PR and emergency path.

- [ ] **Step 4: Run all Node tests and build**

Run: `npm test`

Expected: all tests pass.

Run: `npm run build`

Expected: Vite production build completes.

- [ ] **Step 5: Commit the migration**

```bash
git add .github/workflows scripts tests README.md README_zh.md CONTRIBUTING.md
git commit -m "refactor: replace the yt-dlp-only updater" -m "refactor: 替换仅更新 yt-dlp 的流程"
```

### Task 12: Resolve and Verify the First Production Lock

**Files:**
- Modify: `toolchain-lock.json`
- Modify: `src-tauri/tools-manifest.json`
- Modify: `TOOLCHAIN_CHANGELOG.md`
- Modify: `THIRD-PARTY-NOTICES.md`

**Interfaces:**
- Consumes live authenticated upstream release data
- Produces the first production revision and repairs the unavailable Windows FFmpeg URL

- [ ] **Step 1: Run a live dry-run**

Run: `GITHUB_TOKEN="$(gh auth token)" node scripts/update-toolchain.mjs --dry-run`

Expected: JSON summary lists a new revision and any changed source IDs without modifying files.

- [ ] **Step 2: Resolve production state**

Run: `GITHUB_TOKEN="$(gh auth token)" node scripts/update-toolchain.mjs`

Expected: lock, manifest, and toolchain changelog update together. Windows FFmpeg no longer references `autobuild-2026-06-22-18-32`.

- [ ] **Step 3: Verify every production URL**

Run: `node scripts/check-tool-source-urls.mjs`

Expected: exit `0` with every unique source URL available.

- [ ] **Step 4: Verify the complete repository**

Run: `npm test`

Expected: all Node tests pass.

Run: `npm run build`

Expected: Vite production build succeeds.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all Rust unit tests pass. If the existing target cache contains an old absolute path, rerun with a new `CARGO_TARGET_DIR` without deleting the existing target.

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: exit `0`.

- [ ] **Step 5: Commit the first production lock**

```bash
git add toolchain-lock.json src-tauri/tools-manifest.json TOOLCHAIN_CHANGELOG.md THIRD-PARTY-NOTICES.md
git commit -m "chore: resolve the first unified toolchain revision" -m "chore: 解析首个统一工具链版本"
```

### Task 13: Manual Workflow Acceptance

**Files:**
- No source changes expected

**Interfaces:**
- Consumes configured GitHub App repository secrets
- Produces a no-op or one reviewed weekly PR

- [ ] **Step 1: Confirm GitHub App secrets exist without printing values**

Run: `gh secret list --repo Chlience/yt-dlp-tauri`

Expected: names include `TOOLCHAIN_BOT_CLIENT_ID` and `TOOLCHAIN_BOT_PRIVATE_KEY`.

- [ ] **Step 2: Dispatch weekly discovery**

Run: `gh workflow run "Toolchain Discovery" --ref main`

Expected: one workflow run starts.

- [ ] **Step 3: Watch the run**

Run: `gh run watch --repo Chlience/yt-dlp-tauri --exit-status`

Expected: success. A current toolchain produces no PR; a changed toolchain produces or updates only `bot/toolchain-weekly`.

- [ ] **Step 4: Dispatch freshness**

Run: `gh workflow run "Toolchain Freshness" --ref main`

Expected: success with no emergency PR when all released URLs are healthy.

- [ ] **Step 5: Record acceptance in the implementation handoff**

Report workflow run URLs, whether the run was a no-op, and any PR URL. Do not create a tag or application release in this phase.
