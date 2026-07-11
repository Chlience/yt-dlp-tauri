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
    schemaVersion: 1,
    targets: ["win-x64", "macos-arm64"],
    approvedHosts: ["github.com", "ffmpeg.martin-riedl.de"],
    sources: lock.sources.map((source) => ({ id: source.id })),
  };
}

test("manifest generation uses extracted hashes and fixed source URLs", () => {
  const manifest = generateManifest(policyFixture(), lock);

  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.revision, "20260710.3");
  assert.equal(manifest.retrievedAtUtc, "2026-07-10T04:00:00.000Z");
  assert.deepEqual(
    manifest.targets.map((target) => target.target),
    ["win-x64", "macos-arm64"],
  );
  assert.deepEqual(
    manifest.targets[0].tools.map((tool) => tool.name),
    ["yt-dlp", "ffmpeg", "ffprobe"],
  );
  for (const target of manifest.targets) {
    for (const tool of target.tools) {
      assert.doesNotMatch(tool.sourceUrl, /\/latest\//);
      assert.match(tool.sha256, /^[a-f0-9]{64}$/);
    }
  }
  const windowsFfmpeg = manifest.targets[0].tools.find(
    (tool) => tool.name === "ffmpeg",
  );
  assert.equal(windowsFfmpeg.sha256, "c".repeat(64));
  assert.equal(windowsFfmpeg.archivePathSuffix, "bin/ffmpeg.exe");
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
});
