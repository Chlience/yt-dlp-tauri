import assert from "node:assert/strict";
import test from "node:test";
import { createApp, healthyTools, managedAppState, video } from "./helpers/app-harness.ts";

test("tool updates use the selected channel manifest and GitHub access mode", async () => {
  const app = await createApp({
    fetch_latest_tool_manifest: () => ({ status: "available", manifestJson: "candidate manifest", revision: "20260712.1", source: "archive" }),
    check_tools_with_manifest: () => healthyTools,
    install_tools_from_manifest: () => healthyTools,
  });
  await app.click("github-proxy");
  await app.click("check-tool-updates");
  assert.deepEqual(app.calls.find(call => call.command === "fetch_latest_tool_manifest")?.args, { githubAccessMode: "gh-proxy" });
  assert.deepEqual(app.calls.find(call => call.command === "check_tools_with_manifest")?.args, { manifestJson: "candidate manifest" });
  app.el("toast-region").replaceChildren();
  await app.click("install-tools");
  assert.deepEqual(app.calls.find(call => call.command === "install_tools_from_manifest")?.args, { manifestJson: "candidate manifest", githubAccessMode: "gh-proxy" });
  assert.equal(app.el("toast-region").children.length, 1);
});

test("settings display the active revision and verify a selected local toolchain", async () => {
  const app = await createApp({ set_toolchain_source: () => ({
    ...managedAppState,
    toolchain_source: "local",
    local_toolchain_paths: { ytDlpPath: "/local/yt-dlp", ffmpegDirectory: "/local/ffmpeg", denoPath: "/local/deno" },
  }) });
  assert.equal(app.el("toolchain-revision").textContent, "20260711.1");
  app.input(video.webpage_url);
  await app.click("parse");
  await app.click("tool-source-local");
  assert.equal(app.el("local-yt-dlp-path").textContent, "/local/yt-dlp");
  assert.equal(app.el("check-tool-updates").hidden, true);
  assert.equal(app.el("install-tools").hidden, true);
  assert.equal(app.el("parse").disabled, false);
  assert.equal(app.el("download").disabled, true);
  assert.equal(app.calls.filter(call => call.command === "check_tools").length, 2);
});
