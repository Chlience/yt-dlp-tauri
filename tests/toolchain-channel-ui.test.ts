import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("tool checks use the backend archive channel command", () => {
  const source = readFileSync("src/main.ts", "utf8");

  assert.match(source, /fetch_latest_tool_manifest/u);
  assert.doesNotMatch(source, /findToolManifestAsset/u);
  assert.match(source, /githubAccessMode: state\.githubAccessMode/u);
});
