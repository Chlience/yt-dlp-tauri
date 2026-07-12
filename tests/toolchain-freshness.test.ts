import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateToolchainFreshness } from "../scripts/check-toolchain-freshness.mjs";
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

test("freshness maps a shared ffmpeg URL failure to one source unit", async () => {
  const checkedUrls: string[] = [];
  const result = await evaluateToolchainFreshness(
    lockFixture(),
    manifestFixture(),
    async (url) => {
      checkedUrls.push(url);
      const failed = url.includes("FFmpeg-Builds");
      return {
        ok: !failed,
        status: failed ? 404 : 200,
        statusText: failed ? "Not Found" : "OK",
      };
    },
  );

  assert.deepEqual(result.failedSourceIds, ["ffmpeg-windows"]);
  assert.equal(
    result.problems.filter((problem) => problem.message.includes("ffmpeg-windows"))
      .length,
    1,
  );
  assert.equal(result.problems[0].class, "upstream-discovery");
  assert.equal(
    checkedUrls.filter((url) => url.includes("FFmpeg-Builds")).length,
    1,
  );
});

test("freshness retries a transient source failure", async () => {
  const lock = lockFixture();
  const transientUrl = lock.sources.find((source) => source.id === "yt-dlp").assets[0]
    .sourceUrl;
  let attempts = 0;
  const result = await evaluateToolchainFreshness(
    lock,
    manifestFixture(lock),
    async (url) => {
      if (url === transientUrl) {
        attempts += 1;
        if (attempts === 1) {
          return { ok: false, status: 503, statusText: "Service Unavailable" };
        }
      }
      return { ok: true, status: 200, statusText: "OK" };
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(result, { ok: true, failedSourceIds: [], problems: [] });
});

test("freshness attributes a mirrored runtime URL to its lock source", async () => {
  const lock = lockFixture();
  const manifest = manifestFixture(lock);
  const windows = manifest.targets.find((target) => target.target === "win-x64");
  for (const tool of windows.tools.filter((item) => item.name.startsWith("ff"))) {
    tool.sourceUrl =
      "https://github.com/Chlience/yt-dlp-tauri/releases/download/toolchain-stable/ffmpeg-win.zip";
  }
  const result = await evaluateToolchainFreshness(lock, manifest, async (url) => ({
    ok: !url.includes("toolchain-stable"),
    status: url.includes("toolchain-stable") ? 404 : 200,
    statusText: url.includes("toolchain-stable") ? "Not Found" : "OK",
  }));

  assert.deepEqual(result.failedSourceIds, ["ffmpeg-windows"]);
  assert.equal(result.problems[0].class, "archive-integrity");
  assert.match(result.problems[0].message, /toolchain-stable\/ffmpeg-win\.zip/);
});

test("freshness reports a manifest tool missing from its locked source", async () => {
  const lock = lockFixture();
  const manifest = manifestFixture(lock);
  const windows = manifest.targets.find((target) => target.target === "win-x64");
  windows.tools = windows.tools.filter((tool) => tool.name !== "ffprobe");
  const result = await evaluateToolchainFreshness(lock, manifest, async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
  }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.failedSourceIds, ["ffmpeg-windows"]);
  assert.equal(result.problems[0].class, "archive-integrity");
  assert.match(result.problems[0].message, /manifest is missing win-x64\/ffprobe/);
});

test("freshness classifies archive failures separately", async () => {
  const result = await evaluateToolchainFreshness(
    lockFixture(),
    manifestFixture(),
    async () => ({ ok: true, status: 200, statusText: "OK" }),
    {
      archiveObservation: {
        ok: false,
        class: "archive-unavailable",
        message: "stable archive returned HTTP 503",
      },
    },
  );

  assert.equal(result.problems[0].class, "archive-unavailable");
  assert.deepEqual(result.failedSourceIds, []);
});
