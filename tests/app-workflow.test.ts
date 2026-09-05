import assert from "node:assert/strict";
import test from "node:test";
import { createApp, deferred, flush, healthyTools, video } from "./helpers/app-harness.ts";

test("changing the URL discards a pending parse result and keeps download disabled", async () => {
  const parse = deferred<typeof video>();
  const app = await createApp({ parse_metadata: () => parse.promise });
  app.input(video.webpage_url);
  await app.click("parse");
  app.input("https://video.example/b");
  parse.resolve(video);
  await flush();
  assert.equal(app.el("download").disabled, true);
  assert.notEqual(app.el("video-title").textContent, video.title);
  await app.click("download");
  assert.equal(app.calls.filter(call => call.command === "download_video").length, 0);
  assert.equal(app.el("parse").disabled, false);
});

test("a failed reparse clears the previous quality and download state", async () => {
  let fail = false;
  const app = await createApp({ parse_metadata: () => {
    if (fail) throw new Error("Metadata unavailable");
    return video;
  } });
  app.input(video.webpage_url);
  await app.click("parse");
  assert.equal(app.el("download").disabled, false);
  fail = true;
  await app.click("parse");
  assert.equal(app.el("download").disabled, true);
  assert.equal(app.el("quality").children.length, 0);
  assert.equal(app.el("parse").disabled, false);
});

test("successful parsing downloads the selected video", async () => {
  const app = await createApp();
  app.input(video.webpage_url);
  await app.click("parse");
  await app.click("download");
  const download = app.calls.find(call => call.command === "download_video");
  assert.equal(download?.args.request.url, video.webpage_url);
  assert.equal(download?.args.request.format_selector, "b");
  assert.equal(app.el("progress").value, 100);
});

for (const availability of ["available", "outdated"]) {
  test(`an update with ${availability} remote bytes keeps a healthy local toolchain usable`, async () => {
    const app = await createApp({
      fetch_latest_tool_manifest: () => ({ status: "available", manifestJson: "{}", revision: "20260712.1", source: "archive" }),
      check_tools_with_manifest: () => healthyTools.map(tool => ({ ...tool, availability })),
    });
    app.input(video.webpage_url);
    await app.click("parse");
    await app.click("check-tool-updates");
    assert.equal(app.el("parse").disabled, false);
    assert.equal(app.el("download").disabled, false);
    assert.equal(app.el("install-tools").hidden, false);
    assert.equal(app.el("install-tools").textContent, "Update tools");
  });
}

test("remote availability does not enable a damaged local toolchain", async () => {
  const app = await createApp({
    check_tools: () => healthyTools.map(tool => ({ ...tool, availability: "missing" })),
    fetch_latest_tool_manifest: () => ({ status: "available", manifestJson: "{}", revision: "20260712.1", source: "archive" }),
    check_tools_with_manifest: () => healthyTools,
  });
  app.input(video.webpage_url);
  await app.click("check-tool-updates");
  assert.equal(app.el("parse").disabled, true);
});
