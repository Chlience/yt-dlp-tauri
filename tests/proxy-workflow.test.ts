import assert from "node:assert/strict";
import test from "node:test";
import { createApp, deferred, flush, managedAppState, video } from "./helpers/app-harness.ts";

test("saved custom proxy is restored and switching to direct clears its address on save", async () => {
  const app = await createApp({
    get_app_state: () => ({ ...managedAppState, proxy: { mode: "custom", url: "socks5h://localhost:1080" } }),
    set_proxy_config: ({ config }) => config,
  });
  assert.equal(app.el("proxy-mode").value, "custom");
  assert.equal(app.el("proxy-url").value, "socks5h://localhost:1080");
  assert.equal(app.el("proxy-url").disabled, false);
  app.el("proxy-mode").value = "direct";
  app.el("proxy-mode").dispatch("change");
  assert.equal(app.el("proxy-url").disabled, true);
  await app.click("save-proxy");
  assert.deepEqual(app.calls.find(call => call.command === "set_proxy_config")!.args.config, { mode: "direct", url: null });
  assert.equal(app.el("proxy-url").value, "");
});

test("saving a custom proxy uses the normalized response without discarding parsed selections", async () => {
  const app = await createApp({
    set_proxy_config: () => ({ mode: "custom", url: "http://localhost:7890/" }),
  });
  app.input(video.webpage_url);
  await app.click("parse");
  app.el("proxy-mode").value = "custom";
  app.el("proxy-mode").dispatch("change");
  app.el("proxy-url").value = " http://localhost:7890 ";
  await app.click("save-proxy");
  assert.deepEqual(app.calls.find(call => call.command === "set_proxy_config")!.args.config, { mode: "custom", url: "http://localhost:7890" });
  assert.equal(app.el("proxy-url").value, "http://localhost:7890/");
  assert.equal(app.el("download").disabled, false);
  await app.click("download");
  assert.equal(app.calls.find(call => call.command === "enqueue_downloads")!.args.requests[0].url, video.webpage_url);
});

test("failed proxy saves keep the draft and restore controls", async () => {
  const app = await createApp({ set_proxy_config: () => { throw new Error("Invalid proxy address"); } });
  app.el("proxy-mode").value = "custom";
  app.el("proxy-mode").dispatch("change");
  app.el("proxy-url").value = "invalid";
  await app.click("save-proxy");
  assert.equal(app.el("proxy-url").value, "invalid");
  assert.equal(app.el("proxy-url").disabled, false);
  assert.equal(app.el("save-proxy").disabled, false);
  assert.match(app.el("toast-region").children[0].children[1].textContent, /Invalid proxy address/u);
});

test("a pending proxy save prevents parsing and enqueuing with ambiguous settings", async () => {
  const pending = deferred<{ mode: string; url: null }>();
  const app = await createApp({ set_proxy_config: () => pending.promise });
  app.input(video.webpage_url);
  await app.click("parse");
  await app.click("save-proxy");
  for (const id of ["proxy-mode", "proxy-url", "save-proxy", "parse", "download", "reinstall-tools"]) {
    assert.equal(app.el(id).disabled, true, id);
  }
  await app.click("download");
  assert.equal(app.calls.filter(call => call.command === "enqueue_downloads").length, 0);
  pending.resolve({ mode: "system", url: null });
  await flush();
  assert.equal(app.el("download").disabled, false);
});

test("proxy controls are locked during parsing and unlocked when parsing ends", async () => {
  const pending = deferred<typeof video>();
  const app = await createApp({ parse_metadata: () => pending.promise });
  app.input(video.webpage_url);
  await app.click("parse");
  assert.equal(app.el("save-proxy").disabled, true);
  pending.resolve(video);
  await flush();
  assert.equal(app.el("save-proxy").disabled, false);
});
