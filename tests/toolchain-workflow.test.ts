import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const CHECKOUT_SHA = "93cb6efe18208431cddfb8368fd83d5badbf9bfd";
const SETUP_NODE_SHA = "a0853c24544627f65ddf259abe73b1d18a591444";
const APP_TOKEN_SHA = "fee1f7d63c2ff003460e3d139729b119787bc349";

test("weekly workflow uses a GitHub App and one managed branch", () => {
  const workflow = readFileSync(".github/workflows/toolchain-discover.yml", "utf8");

  assert.match(workflow, /cron: "17 3 \* \* 1"/);
  assert.match(workflow, new RegExp(`actions/checkout@${CHECKOUT_SHA}`));
  assert.match(workflow, new RegExp(`actions/setup-node@${SETUP_NODE_SHA}`));
  assert.match(
    workflow,
    new RegExp(`actions/create-github-app-token@${APP_TOKEN_SHA}`),
  );
  assert.match(workflow, /TOOLCHAIN_BOT_APP_ID/);
  assert.match(workflow, /TOOLCHAIN_BOT_PRIVATE_KEY/);
  assert.match(workflow, /bot\/toolchain-weekly/);
  assert.match(workflow, /node scripts\/update-toolchain\.mjs/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /check-tool-source-urls\.mjs/);
  assert.match(workflow, /gh pr (create|edit)/);
});

test("freshness workflow creates focused emergency pull requests", () => {
  const workflow = readFileSync(".github/workflows/toolchain-freshness.yml", "utf8");

  assert.match(workflow, /cron: "41 4 \* \* \*"/);
  assert.match(workflow, /tool:\s*\n\s*description:/);
  assert.match(workflow, /reason:\s*\n\s*description:/);
  assert.match(workflow, /check-toolchain-freshness\.mjs/);
  assert.match(workflow, /--json-output/);
  assert.match(workflow, /--only "\$\{\{ matrix\.source \}\}"/);
  assert.match(workflow, /bot\/toolchain-emergency-/);
  assert.match(workflow, new RegExp(`actions/create-github-app-token@${APP_TOKEN_SHA}`));
  assert.match(workflow, /gh pr (create|edit)/);
});

test("toolchain automation pins every third-party action to a commit", () => {
  const workflows = [
    readFileSync(".github/workflows/toolchain-discover.yml", "utf8"),
    readFileSync(".github/workflows/toolchain-freshness.yml", "utf8"),
  ];

  for (const workflow of workflows) {
    for (const line of workflow.split("\n").filter((item) => /uses:/.test(item))) {
      assert.match(line, /uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}\s*$/);
    }
  }
});

test("repository has one toolchain updater", () => {
  assert.equal(existsSync(".github/workflows/update-yt-dlp.yml"), false);
  assert.equal(existsSync("scripts/update-yt-dlp-manifest.mjs"), false);
  assert.equal(existsSync("scripts/update-toolchain.mjs"), true);
});
