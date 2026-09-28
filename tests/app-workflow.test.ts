import assert from "node:assert/strict";
import test from "node:test";
import {
  createApp,
  deferred,
  flush,
  healthyTools,
  managedAppState,
  video,
} from "./helpers/app-harness.ts";

test("startup errors are visible and retry loads configuration before enabling operations", async () => {
  let fail = true;
  const app = await createApp({
    get_app_state: () => {
      if (fail) throw new Error("Invalid Cookie selection");
      return managedAppState;
    },
  });
  app.input(video.webpage_url);
  assert.equal(app.el("retry-startup").hidden, false);
  assert.equal(app.el("parse").disabled, true);
  assert.equal(app.el("save-folder").disabled, true);
  assert.match(
    app.el("progress-text").textContent,
    /Invalid Cookie selection/u,
  );
  assert.equal(app.el("toast-region").children.length, 1);
  app.el("url").dispatch("keydown", { key: "Enter", preventDefault() {} });
  assert.deepEqual(
    app.calls.map((call) => call.command),
    ["get_app_state"],
  );
  fail = false;
  await app.click("retry-startup");
  assert.equal(app.el("retry-startup").hidden, true);
  assert.equal(app.el("parse").disabled, false);
  assert.equal(app.el("save-folder").disabled, false);
  assert.deepEqual(
    app.calls.map((call) => call.command),
    ["get_app_state", "get_app_state", "get_download_queue", "check_tools"],
  );
  await app.click("parse");
  assert.equal(app.el("download").disabled, false);
});

for (const [name, availability, button, command] of [
  ["install", "missing", "install-tools", "install_tools"],
  ["repair", "outdated", "install-tools", "reinstall_tools"],
  ["manual reinstall", "available", "reinstall-tools", "reinstall_tools"],
]) {
  test(`${name} reports success once and restores the controls`, async () => {
    const app = await createApp({
      check_tools: () =>
        healthyTools.map((tool) => ({ ...tool, availability })),
      [command]: () => healthyTools,
    });
    app.el("toast-region").replaceChildren();
    app.input(video.webpage_url);
    await app.click(button);
    assert.equal(
      app.calls.filter((call) => call.command === command).length,
      1,
    );
    const notices = app.el("toast-region").children;
    assert.equal(notices.length, 1);
    assert.equal(notices[0].children[1].textContent, "Toolchain installed");
    assert.equal(app.el("parse").disabled, false);
    assert.equal(app.el("verify-tools").disabled, false);
  });
}

test("failed installation reports one error and keeps missing tools unavailable", async () => {
  const app = await createApp({
    check_tools: () => healthyTools.map(tool => ({ ...tool, availability: "missing" })),
    install_tools: () => { throw new Error("Tool download failed"); },
  });
  app.el("toast-region").replaceChildren();
  app.input(video.webpage_url);
  await app.click("install-tools");
  assert.equal(app.el("toast-region").children.length, 1);
  assert.match(app.el("tool-install-status").textContent, /Tool download failed/u);
  assert.equal(app.el("parse").disabled, true);
  assert.equal(app.el("install-tools").disabled, false);
});

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
  assert.equal(
    app.calls.filter((call) => call.command === "enqueue_downloads").length,
    0,
  );
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
  const download = app.calls.find(
    (call) => call.command === "enqueue_downloads",
  );
  assert.equal(download?.args.requests[0].url, video.webpage_url);
  assert.equal(download?.args.requests[0].format_selector, "b");
  assert.equal(app.el("queue-view").hidden, false);
  assert.equal(app.el("queue-list").children.length, 1);
  assert.equal(app.el("parse").disabled, false);
});

for (const availability of ["available", "outdated"]) {
  test(`an update with ${availability} remote bytes keeps a healthy local toolchain usable`, async () => {
    const app = await createApp({
      fetch_latest_tool_manifest: () => ({
        status: "available",
        manifestJson: "{}",
        revision: "20260712.1",
        source: "archive",
      }),
      check_tools_with_manifest: () =>
        healthyTools.map((tool) => ({ ...tool, availability })),
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

test("Cookie selection sends the chosen URL and displays the bound origin", async () => {
  const selection = deferred<{ cookies_file: string; cookies_origin: string }>();
  const app = await createApp({
    open: () => "/cookies/header.txt",
    set_cookies_file: () => selection.promise,
  });
  app.input(video.webpage_url);
  await app.click("parse");
  await app.click("choose-cookies");
  assert.equal(app.el("parse").disabled, true);
  const command = app.calls.find(call => call.command === "set_cookies_file");
  assert.equal(command?.args.url, video.webpage_url);
  selection.resolve({ cookies_file: "/cookies/header.txt", cookies_origin: "https://video.example" });
  await flush();
  assert.match(app.el("cookies-file").textContent, /https:\/\/video.example/u);
  assert.equal(app.el("download").disabled, true);
  assert.equal(app.el("parse").disabled, false);
});

test("metadata parsing can be cancelled and retried", async () => {
  const parse = deferred<typeof video>();
  let attempts = 0;
  const app = await createApp({
    parse_metadata: () => (++attempts === 1 ? parse.promise : video),
    cancel_metadata: () => parse.reject("Operation cancelled."),
  });
  app.input(video.webpage_url);
  await app.click("parse");
  assert.equal(app.el("cancel").disabled, false);
  await app.click("cancel");
  assert.equal(app.el("parse").disabled, false);
  assert.equal(app.el("download").disabled, true);
  assert.equal(
    app.el("progress-text").textContent,
    "Metadata parsing cancelled",
  );
  await app.click("parse");
  assert.equal(app.el("download").disabled, false);
});

test("an enqueue failure keeps the parsed selection available for retry", async () => {
  const app = await createApp({
    enqueue_downloads: () => {
      throw new Error("Output directory unavailable");
    },
  });
  app.input(video.webpage_url);
  await app.click("parse");
  await app.click("download");
  assert.equal(app.el("download").disabled, false);
  assert.equal(app.el("video-title").textContent, video.title);
  assert.match(
    app.el("toast-region").children[0].children[1].textContent,
    /Output directory unavailable/u,
  );
});

test("successive Escape presses dismiss separate notices during their exit animations", async () => {
  const app = await createApp({ parse_metadata: () => { throw new Error("Video unavailable"); } });
  app.input(video.webpage_url);
  await app.click("parse");
  await app.click("parse");
  const notices = app.el("toast-region").children;
  assert.equal(notices.length, 2);
  await app.key("Escape");
  await app.key("Escape");
  assert.ok(notices.every((notice) => notice.classList.contains("is-leaving")));
});
