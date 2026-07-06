import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("yt-dlp update workflow prepares a pull request from the managed bot branch", () => {
  const workflow = readFileSync(".github/workflows/update-yt-dlp.yml", "utf8");

  assert.match(workflow, /contents: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(
    workflow,
    /node scripts\/update-yt-dlp-manifest\.mjs --release-fixture tests\/fixtures\/yt-dlp-latest-release\.json --changelog CHANGELOG\.md/,
  );
  assert.match(workflow, /--windows-download-script scripts\/download-tools\.ps1/);
  assert.match(workflow, /bot\/update-yt-dlp/);
  assert.match(workflow, /gh pr create/);
});

test("toolchain freshness tolerates stale yt-dlp manifests when a bot PR is open", () => {
  const workflow = readFileSync(".github/workflows/toolchain-freshness.yml", "utf8");

  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /gh pr list --head bot\/update-yt-dlp/);
  assert.match(workflow, /yt-dlp manifest is stale; update PR/);
});
