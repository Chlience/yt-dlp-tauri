import assert from "node:assert/strict";
import test from "node:test";

import { findToolManifestAsset, summarizeTools, type ToolStatus } from "../src/toolchain.ts";

function tool(availability: ToolStatus["availability"], version = "1.0.0", expectedVersion = "1.0.0"): ToolStatus {
  return {
    name: "yt-dlp",
    relative_path: "yt-dlp/yt-dlp",
    full_path: "/tools/yt-dlp/yt-dlp",
    availability,
    version,
    expected_version: expectedVersion,
  };
}

test("summarizeTools leaves healthy toolchains without a primary action", () => {
  assert.deepEqual(summarizeTools([tool("available")], "local"), {
    ready: true,
    action: null,
    settingsKey: "settings.toolsAvailable",
    noticeKey: "notice.toolchainReady",
    eventKey: "event.toolsAvailable",
    tone: "success",
  });
});

test("summarizeTools asks for reinstall when local verification finds damaged tools", () => {
  assert.deepEqual(summarizeTools([tool("outdated", "1.0.0", "1.0.0")], "local"), {
    ready: false,
    action: "reinstall",
    settingsKey: "settings.toolsDamaged",
    noticeKey: "notice.toolsDamaged",
    eventKey: "event.toolsDamaged",
    tone: "warning",
  });
});

test("summarizeTools asks for update when release manifest verification finds newer tools", () => {
  assert.deepEqual(summarizeTools([tool("outdated", "1.0.0", "2.0.0")], "remote"), {
    ready: false,
    action: "update",
    settingsKey: "settings.toolUpdatesAvailable",
    noticeKey: "notice.toolsOutdated",
    eventKey: "event.toolUpdatesAvailable",
    tone: "warning",
  });
});

test("findToolManifestAsset reads the project release manifest asset", () => {
  assert.deepEqual(
    findToolManifestAsset({
      assets: [
        {
          name: "yt-dlp-tauri_0.1.8_windows_x86_64-setup.exe",
          browser_download_url: "https://example.test/app.exe",
        },
        {
          name: "tools-manifest.json",
          browser_download_url: "https://github.com/Chlience/yt-dlp-tauri/releases/download/v0.1.8/tools-manifest.json",
        },
      ],
    }),
    {
      name: "tools-manifest.json",
      downloadUrl: "https://github.com/Chlience/yt-dlp-tauri/releases/download/v0.1.8/tools-manifest.json",
    },
  );
});
