import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const installerCheck = readFileSync("scripts/verify-windows-installer.ps1", "utf8");
const cargoManifest = readFileSync("src-tauri/Cargo.toml", "utf8");

test("release workflow separates preflight builds from publication", () => {
  assert.match(workflow, /workflow_dispatch:[\s\S]*?ref:[\s\S]*?publish:[\s\S]*?tag:/u);
  assert.match(workflow, /PUBLISH_RELEASE:/u);
  assert.match(workflow, /persist-credentials: \$\{\{ env\.PUBLISH_RELEASE == 'true' \}\}/u);
  assert.match(workflow, /if: env\.PUBLISH_RELEASE != 'true'[\s\S]*?npm run tauri build -- --bundles nsis/u);
  assert.match(workflow, /if: env\.PUBLISH_RELEASE == 'true'[\s\S]*?tauri-apps\/tauri-action@v0/u);
  assert.match(workflow, /publish-tool-manifest:[\s\S]*?if:.*inputs\.publish/u);
});

test("release preflight installs, launches, and removes the Windows package", () => {
  assert.match(workflow, /verify-windows-installer\.ps1/u);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.match(workflow, /Upload preflight installer[\s\S]*?if: \$\{\{ always\(\) && env\.PUBLISH_RELEASE != 'true' \}\}/u);
  assert.match(installerCheck, /ArgumentList "\/S"/u);
  assert.match(installerCheck, /DisplayVersion/u);
  assert.match(installerCheck, /Start-Process.*installedExecutable/u);
  assert.match(installerCheck, /uninstall\.exe/u);
  assert.match(installerCheck, /ConvertTo-Json/u);
});

test("release builds pin the Tauri application binary", () => {
  const packageSection = cargoManifest.match(/^\[package\]\n([\s\S]*?)(?=^\[)/mu)?.[1] ?? "";

  assert.match(packageSection, /^default-run = "yt-dlp-tauri"$/mu);
  assert.doesNotMatch(packageSection, /^default-run = "toolchain-smoke"$/mu);
});
