import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateYtDlpManifest } from "../scripts/check-yt-dlp-release.mjs";

const latestRelease = {
  tag_name: "2026.06.09",
  html_url: "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.06.09",
  assets: [
    {
      name: "yt-dlp.exe",
      browser_download_url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.06.09/yt-dlp.exe",
      digest: "sha256:3a48cb955d55c8821b60ccbdbbc6f61bc958f2f3d3b7ad5eaf3d83a543293a27",
    },
    {
      name: "yt-dlp_macos",
      browser_download_url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.06.09/yt-dlp_macos",
      digest: "sha256:b82c3626952e6c14eaf654cc565866775ffd0b9ffb7021628ac59b42c2f4f244",
    },
  ],
};

test("production yt-dlp manifest matches the latest checked release fixture", () => {
  const manifest = JSON.parse(readFileSync("src-tauri/tools-manifest.json", "utf8"));

  assert.deepEqual(evaluateYtDlpManifest(manifest, latestRelease), {
    ok: true,
    latestVersion: "2026.06.09",
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
  assert.match(result.problems.join("\n"), /win-x64 yt-dlp version is 2026\.03\.17, expected 2026\.06\.09/);
  assert.match(result.problems.join("\n"), /win-x64 yt-dlp sourceUrl is stale/);
  assert.match(result.problems.join("\n"), /win-x64 yt-dlp sha256 is stale/);
});
