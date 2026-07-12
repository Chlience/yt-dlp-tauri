import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  generateManifest,
  renderToolchainChangelog,
} from "../scripts/toolchain/generate-manifest.mjs";

const lock = JSON.parse(
  readFileSync("tests/fixtures/toolchain/current-lock.json", "utf8"),
);

function policyFixture() {
  return {
    schemaVersion: 2,
    targets: ["win-x64"],
    approvedHosts: ["github.com"],
    sources: lock.sources.map((source) => ({
      id: source.id,
      archive: {
        enabled: true,
        repository: "Chlience/yt-dlp-tauri-toolchain",
        assetNameTemplate:
          "{source}-{version}-{assetStem}-{sha256Prefix}{extension}",
      },
    })),
  };
}

test("manifest generation uses extracted hashes and fixed source URLs", () => {
  const manifest = generateManifest(policyFixture(), lock);

  assert.equal(manifest.schemaVersion, 4);
  assert.equal(manifest.revision, "20260710.3");
  assert.equal(manifest.retrievedAtUtc, "2026-07-10T04:00:00.000Z");
  assert.deepEqual(
    manifest.targets.map((target) => target.target),
    ["win-x64"],
  );
  assert.deepEqual(
    manifest.targets[0].tools.map((tool) => tool.name),
    ["yt-dlp", "ffmpeg", "ffprobe"],
  );
  for (const target of manifest.targets) {
    for (const tool of target.tools) {
      assert.doesNotMatch(tool.sourceUrl, /\/latest\//);
      assert.match(
        tool.sourceUrl,
        /^https:\/\/github\.com\/Chlience\/yt-dlp-tauri-toolchain\/releases\/download\/toolchain-/u,
      );
      assert.ok(tool.sourceSize > 0);
      assert.match(tool.sourceSha256, /^[a-f0-9]{64}$/);
      assert.match(tool.sha256, /^[a-f0-9]{64}$/);
    }
  }
  const windowsFfmpeg = manifest.targets[0].tools.find(
    (tool) => tool.name === "ffmpeg",
  );
  assert.equal(windowsFfmpeg.sha256, "c".repeat(64));
  assert.equal(windowsFfmpeg.archivePathSuffix, "bin/ffmpeg.exe");
});

test("production manifest is generated from the production lock", () => {
  const policy = JSON.parse(readFileSync("toolchain-policy.json", "utf8"));
  const productionLock = JSON.parse(readFileSync("toolchain-lock.json", "utf8"));
  const manifest = JSON.parse(readFileSync("src-tauri/tools-manifest.json", "utf8"));

  assert.deepEqual(manifest, generateManifest(policy, productionLock));
});

test("candidate mode uses upstream only for assets assigned to its revision", () => {
  const candidateLock = structuredClone(lock);
  const ffmpegSource = candidateLock.sources.find(
    (source) => source.id === "ffmpeg-windows",
  );
  const ytDlpSource = candidateLock.sources.find((source) => source.id === "yt-dlp");
  ytDlpSource.assets[0].archive.releaseTag = "toolchain-20260709.1";
  const policy = policyFixture();

  const candidate = generateManifest(policy, candidateLock, { sourceMode: "candidate" });
  const candidateFfmpeg = candidate.targets
    .find((target) => target.target === "win-x64")
    .tools.find((tool) => tool.name === "ffmpeg");
  const candidateYtDlp = candidate.targets
    .find((target) => target.target === "win-x64")
    .tools.find((tool) => tool.name === "yt-dlp");

  assert.equal(candidateFfmpeg.sourceUrl, ffmpegSource.assets[0].sourceUrl);
  assert.equal(
    candidateYtDlp.sourceUrl,
    "https://github.com/Chlience/yt-dlp-tauri-toolchain/releases/download/toolchain-20260709.1/yt-dlp-2026.07.04-yt-dlp-aaaaaaaaaaaaaaaa.exe",
  );
});

test("toolchain changelog records one revision without app release notes", () => {
  const previous = structuredClone(lock);
  previous.revision = "20260709.1";
  previous.generatedAtUtc = "2026-07-09T00:00:00.000Z";
  previous.sources.find((source) => source.id === "yt-dlp").version = "2026.06.30";
  const text = renderToolchainChangelog(previous, lock);

  assert.match(text, /## 20260710\.3 - 2026-07-10/);
  assert.match(text, /`yt-dlp`: `2026\.06\.30` -> `2026\.07\.04`/);
  assert.doesNotMatch(text, /## Unreleased/);
});

test("toolchain changelog prepends a revision only once", () => {
  const existing = [
    "# Toolchain Changelog",
    "",
    "Tool updates are published independently from application releases",
    "",
    "## 20260709.1 - 2026-07-09",
    "",
    "- Initial revision",
    "",
  ].join("\n");
  const first = renderToolchainChangelog(null, lock, existing);
  const second = renderToolchainChangelog(null, lock, first);

  assert.equal((second.match(/## 20260710\.3/g) ?? []).length, 1);
  assert.match(second, /## 20260709\.1/);
  assert.match(second, /\n\n## 20260709\.1/);
});
