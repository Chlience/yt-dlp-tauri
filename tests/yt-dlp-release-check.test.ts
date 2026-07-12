import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateYtDlpManifest } from "../scripts/check-yt-dlp-release.mjs";
import { generateManifest } from "../scripts/toolchain/generate-manifest.mjs";

function lockFixture() {
  return JSON.parse(readFileSync("tests/fixtures/toolchain/current-lock.json", "utf8"));
}

function manifestFixture(lock = lockFixture()) {
  return generateManifest(
    {
      targets: lock.targets,
      sources: lock.sources.map((source) => ({ id: source.id })),
    },
    lock,
  );
}

test("yt-dlp manifest matches the unified lock", () => {
  const lock = lockFixture();

  assert.deepEqual(evaluateYtDlpManifest(manifestFixture(lock), lock), {
    ok: true,
    lockedVersion: "2026.07.04",
    problems: [],
  });
});

test("stale yt-dlp manifest reports actionable lock differences", () => {
  const lock = lockFixture();
  const manifest = manifestFixture(lock);
  const winYtDlp = manifest.targets
    .find((target) => target.target === "win-x64")
    .tools.find((tool) => tool.name === "yt-dlp");
  winYtDlp.version = "2026.03.17";
  winYtDlp.sourceUrl =
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.03.17/yt-dlp.exe";
  winYtDlp.sha256 = "3db811b366b2da47337d2fcfdfe5bbd9a258dad3f350c54974f005df115a1545";

  const result = evaluateYtDlpManifest(manifest, lock);

  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /win-x64 yt-dlp version is 2026\.03\.17/);
  assert.match(result.problems.join("\n"), /sourceUrl differs from toolchain-lock\.json/);
  assert.match(result.problems.join("\n"), /sha256 differs from toolchain-lock\.json/);
});

test("yt-dlp diagnostic requires one locked source", () => {
  const lock = lockFixture();
  lock.sources = lock.sources.filter((source) => source.id !== "yt-dlp");

  assert.throws(
    () => evaluateYtDlpManifest(manifestFixture(lockFixture()), lock),
    /exactly one yt-dlp source/,
  );
});
