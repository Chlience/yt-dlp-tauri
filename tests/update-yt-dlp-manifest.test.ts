import assert from "node:assert/strict";
import test from "node:test";

import {
  updateWindowsDownloadScript,
  updateYtDlpChangelog,
  updateYtDlpManifest,
  ytDlpReleaseFixture,
} from "../scripts/update-yt-dlp-manifest.mjs";

const latestRelease = {
  tag_name: "2026.07.04",
  assets: [
    {
      name: "yt-dlp.exe",
      browser_download_url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe",
      digest: "sha256:52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8",
    },
    {
      name: "yt-dlp_macos",
      browser_download_url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos",
      digest: "sha256:498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b",
    },
  ],
};

function manifestFixture() {
  return {
    schemaVersion: 2,
    retrievedAtUtc: "2026-06-23T00:00:00Z",
    targets: [
      {
        target: "win-x64",
        tools: [
          {
            name: "yt-dlp",
            sourceUrl: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.06.09/yt-dlp.exe",
            version: "2026.06.09",
            sha256: "3a48cb955d55c8821b60ccbdbbc6f61bc958f2f3d3b7ad5eaf3d83a543293a27",
          },
          {
            name: "deno",
            sourceUrl: "https://example.test/deno.zip",
            version: "2.7.14",
            sha256: "keep-deno-sha",
          },
        ],
      },
      {
        target: "macos-arm64",
        tools: [
          {
            name: "yt-dlp",
            sourceUrl: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.06.09/yt-dlp_macos",
            version: "2026.06.09",
            sha256: "b82c3626952e6c14eaf654cc565866775ffd0b9ffb7021628ac59b42c2f4f244",
          },
        ],
      },
    ],
  };
}

test("updateYtDlpManifest updates only yt-dlp tools from the latest release", () => {
  const original = manifestFixture();
  const result = updateYtDlpManifest(original, latestRelease, {
    retrievedAtUtc: "2026-07-06T00:00:00Z",
  });

  assert.equal(result.changed, true);
  assert.equal(result.latestVersion, "2026.07.04");
  assert.deepEqual(result.updatedTargets, ["win-x64", "macos-arm64"]);
  assert.equal(result.manifest.retrievedAtUtc, "2026-07-06T00:00:00Z");

  const winTools = result.manifest.targets[0].tools;
  assert.deepEqual(winTools[0], {
    name: "yt-dlp",
    sourceUrl: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe",
    version: "2026.07.04",
    sha256: "52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8",
  });
  assert.deepEqual(winTools[1], {
    name: "deno",
    sourceUrl: "https://example.test/deno.zip",
    version: "2.7.14",
    sha256: "keep-deno-sha",
  });
  assert.equal(original.targets[0].tools[0].version, "2026.06.09");
});

test("updateYtDlpManifest leaves an already current manifest unchanged", () => {
  const currentManifest = updateYtDlpManifest(manifestFixture(), latestRelease, {
    retrievedAtUtc: "2026-07-06T00:00:00Z",
  }).manifest;

  const result = updateYtDlpManifest(currentManifest, latestRelease, {
    retrievedAtUtc: "2026-07-07T00:00:00Z",
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.updatedTargets, []);
  assert.equal(result.manifest.retrievedAtUtc, "2026-07-06T00:00:00Z");
  assert.deepEqual(result.manifest, currentManifest);
});

test("ytDlpReleaseFixture keeps only release fields needed by tests", () => {
  const fixture = ytDlpReleaseFixture({
    ...latestRelease,
    html_url: "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.04",
    assets: [
      ...latestRelease.assets,
      {
        name: "SHA2-256SUMS",
        browser_download_url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/SHA2-256SUMS",
        digest: "sha256:ignored",
      },
    ],
  });

  assert.deepEqual(fixture, {
    tag_name: "2026.07.04",
    html_url: "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.04",
    assets: latestRelease.assets,
  });
});

test("updateYtDlpChangelog adds a single unreleased entry for the new yt-dlp version", () => {
  const changelog = `# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### 中文

- Existing Chinese note.

### English

- Existing English note.

## 0.1.11 - 2026-06-24
`;

  const result = updateYtDlpChangelog(changelog, "2026.07.04");
  const secondResult = updateYtDlpChangelog(result.changelog, "2026.07.04");

  assert.equal(result.changed, true);
  assert.equal(secondResult.changed, false);
  assert.match(
    result.changelog,
    /- 将应用管理的 `yt-dlp` 更新到 `2026\.07\.04`，减少站点 extractor 过期导致的解析失败。\n- Existing Chinese note\./,
  );
  assert.match(
    result.changelog,
    /- Updated the app-managed `yt-dlp` to `2026\.07\.04` to reduce parsing failures caused by stale site extractors\.\n- Existing English note\./,
  );
});

test("updateWindowsDownloadScript refreshes the pinned Windows yt-dlp URL and SHA-256", () => {
  const script = `Download-File 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.06.09/yt-dlp.exe' $ytDlp
Assert-Hash $ytDlp '3a48cb955d55c8821b60ccbdbbc6f61bc958f2f3d3b7ad5eaf3d83a543293a27'
`;

  const result = updateWindowsDownloadScript(script, latestRelease);
  const secondResult = updateWindowsDownloadScript(result.script, latestRelease);

  assert.equal(result.changed, true);
  assert.equal(secondResult.changed, false);
  assert.match(
    result.script,
    /Download-File 'https:\/\/github\.com\/yt-dlp\/yt-dlp\/releases\/download\/2026\.07\.04\/yt-dlp\.exe' \$ytDlp/,
  );
  assert.match(
    result.script,
    /Assert-Hash \$ytDlp '52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8'/,
  );
});
