import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions, getUpdateStatus, parseLatestRelease, resolveGithubUrl } from "../src/update-check.ts";

test("compareVersions handles v-prefixed semantic versions", () => {
  assert.equal(compareVersions("0.1.0", "v0.2.0"), -1);
  assert.equal(compareVersions("v1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.10.0", "1.2.0"), 1);
});

test("getUpdateStatus reports an available GitHub release", () => {
  const status = getUpdateStatus("0.1.0", {
    tagName: "v0.2.0",
    releaseUrl: "https://github.com/Chlience/yt-dlp-tauri/releases/tag/v0.2.0",
  });

  assert.deepEqual(status, {
    kind: "available",
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    releaseUrl: "https://github.com/Chlience/yt-dlp-tauri/releases/tag/v0.2.0",
  });
});

test("parseLatestRelease rejects incomplete GitHub responses", () => {
  assert.equal(parseLatestRelease({ tag_name: "v0.2.0" }), null);
  assert.deepEqual(
    parseLatestRelease({
      tag_name: "v0.2.0",
      html_url: "https://github.com/Chlience/yt-dlp-tauri/releases/tag/v0.2.0",
    }),
    {
      tagName: "v0.2.0",
      releaseUrl: "https://github.com/Chlience/yt-dlp-tauri/releases/tag/v0.2.0",
    },
  );
});

test("resolveGithubUrl can route GitHub URLs through gh-proxy", () => {
  assert.equal(
    resolveGithubUrl("https://github.com/Chlience/yt-dlp-tauri/releases", "direct"),
    "https://github.com/Chlience/yt-dlp-tauri/releases",
  );
  assert.equal(
    resolveGithubUrl("https://github.com/Chlience/yt-dlp-tauri/releases", "gh-proxy"),
    "https://gh-proxy.com/https://github.com/Chlience/yt-dlp-tauri/releases",
  );
  assert.equal(
    resolveGithubUrl("https://api.github.com/repos/Chlience/yt-dlp-tauri/releases/latest", "gh-proxy"),
    "https://gh-proxy.com/https://api.github.com/repos/Chlience/yt-dlp-tauri/releases/latest",
  );
});
