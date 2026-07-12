import assert from "node:assert/strict";
import test from "node:test";

import {
  compareToolchainRevisions,
  summarizeRemoteTools,
  summarizeTools,
  type ToolStatus,
} from "../src/toolchain.ts";

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

test("remote archive revision produces update only when newer", () => {
  assert.equal(compareToolchainRevisions("20260712.1", "20260711.2"), 1);
  assert.equal(compareToolchainRevisions("20260712.1", "20260712.1"), 0);
  assert.equal(compareToolchainRevisions("20260711.2", "20260712.1"), -1);
  assert.throws(() => compareToolchainRevisions("20260229.1", "20260712.1"));
  assert.throws(() => compareToolchainRevisions("20260712.4294967296", "20260712.1"));
});

test("new archive revision updates matching installed bytes", () => {
  assert.equal(
    summarizeRemoteTools([tool("available")], "20260711.2", "20260712.1").action,
    "update",
  );
  assert.equal(
    summarizeRemoteTools([tool("available")], "20260712.1", "20260712.1").action,
    null,
  );
  assert.throws(() =>
    summarizeRemoteTools([tool("missing")], null, "20261301.1"),
  );
});
