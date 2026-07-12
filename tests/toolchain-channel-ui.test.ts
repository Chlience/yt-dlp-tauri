import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("tool checks use the backend archive channel command", () => {
  const source = readFileSync("src/main.ts", "utf8");

  assert.match(source, /fetch_latest_tool_manifest/u);
  assert.doesNotMatch(source, /findToolManifestAsset/u);
  assert.match(source, /githubAccessMode: state\.githubAccessMode/u);
});

test("settings display the active toolchain revision", () => {
  const html = readFileSync("index.html", "utf8");
  const source = readFileSync("src/main.ts", "utf8");

  assert.match(html, /id="toolchain-revision"/u);
  assert.match(source, /state\.toolchainRevision = appState\.toolchain_revision/u);
  assert.match(source, /renderToolchainRevision\(\)/u);
  assert.match(source, /settings\.noActiveRevision/u);
});
