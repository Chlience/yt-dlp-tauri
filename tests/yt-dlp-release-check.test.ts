import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as ytDlpReleaseCheck from "../scripts/check-yt-dlp-release.mjs";

const { evaluateYtDlpManifest } = ytDlpReleaseCheck;

const latestRelease = JSON.parse(readFileSync("tests/fixtures/yt-dlp-latest-release.json", "utf8"));

test("production yt-dlp manifest matches the latest checked release fixture", () => {
  const manifest = JSON.parse(readFileSync("src-tauri/tools-manifest.json", "utf8"));

  assert.deepEqual(evaluateYtDlpManifest(manifest, latestRelease), {
    ok: true,
    latestVersion: "2026.07.04",
    problems: [],
  });
});

test("stale yt-dlp manifest reports actionable problems", () => {
  const manifest = JSON.parse(readFileSync("src-tauri/tools-manifest.json", "utf8"));
  const winYtDlp = manifest.targets[0].tools.find((tool: { name: string }) => tool.name === "yt-dlp");
  winYtDlp.version = "2026.03.17";
  winYtDlp.sourceUrl = "https://github.com/yt-dlp/yt-dlp/releases/download/2026.03.17/yt-dlp.exe";
  winYtDlp.sha256 = "3db811b366b2da47337d2fcfdfe5bbd9a258dad3f350c54974f005df115a1545";

  const result = evaluateYtDlpManifest(manifest, latestRelease);

  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /win-x64 yt-dlp version is 2026\.03\.17, expected 2026\.07\.04/);
  assert.match(result.problems.join("\n"), /win-x64 yt-dlp sourceUrl is stale/);
  assert.match(result.problems.join("\n"), /win-x64 yt-dlp sha256 is stale/);
});

test("latest yt-dlp release request uses bearer authentication when a token is available", () => {
  assert.equal(typeof ytDlpReleaseCheck.githubApiHeaders, "function");

  const headers = ytDlpReleaseCheck.githubApiHeaders("github-token");

  assert.equal(headers.Authorization, "Bearer github-token");
});
