import assert from "node:assert/strict";
import test from "node:test";
import { createApp, deferred, flush, video } from "./helpers/app-harness.ts";

const entries = Array.from({ length: 7 }, (_, i) => ({
  index: i + 1,
  id: `video-${i + 1}`,
  title: `Video ${i + 1}`,
  url: `https://video.example/${i + 1}`,
}));
const page = {
  title: "Course",
  directory_name: "Course",
  entries,
  total: 123,
  next_start: 8,
};

test("playlist selection enqueues one request per original item and leaves later pages unselected", async () => {
  const app = await createApp({
    parse_playlist_page: ({ start }) =>
      start === 1
        ? page
        : {
            ...page,
            entries: [{ ...entries[0], index: 8, id: "video-8" }],
            next_start: null,
          },
  });
  app.input("https://www.youtube.com/playlist?list=course");
  await app.click("parse");
  assert.equal(app.el("download").disabled, true);
  assert.equal(app.el("operation-status").hidden, true);
  app.el("playlist-range").value = "3,5,7";
  await app.click("apply-range");
  await app.click("playlist-load-more");
  assert.match(app.el("playlist-summary").textContent, /3 selected/u);
  await app.click("download");
  const requests = app.calls.find(
    (call) => call.command === "enqueue_downloads",
  )!.args.requests;
  assert.deepEqual(
    requests.map((request: any) => request.playlist.index),
    [3, 5, 7],
  );
  assert.deepEqual(
    requests.map((request: any) => request.url),
    [3, 5, 7].map((index) => `https://video.example/${index}`),
  );
  assert.equal(app.el("queue-list").children.length, 3);
  assert.equal(app.el("parse").disabled, false);
  assert.equal(app.el("reinstall-tools").disabled, true);
});

test("scope choice prevents implicit playlist expansion and current-video keeps a single request", async () => {
  const app = await createApp();
  app.input("https://www.youtube.com/watch?v=one&list=course");
  await app.click("parse");
  assert.equal(app.el("scope-chooser").hidden, false);
  assert.equal(
    app.calls.filter((call) => call.command === "parse_metadata").length,
    0,
  );
  await app.click("scope-video");
  await app.click("download");
  const requests = app.calls.find(
    (call) => call.command === "enqueue_downloads",
  )!.args.requests;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].playlist, undefined);
});

test("partial playlist errors preserve loaded items and retry starts after them", async () => {
  const app = await createApp({
    parse_playlist_page: ({ start }) =>
      start === 1
        ? {
            ...page,
            entries: entries.slice(0, 3),
            next_start: 4,
            error: "Network interrupted",
          }
        : { ...page, entries: entries.slice(3), next_start: null },
  });
  app.input("https://www.youtube.com/playlist?list=course");
  await app.click("parse");
  assert.match(app.el("playlist-message").textContent, /Network interrupted/u);
  await app.click("select-all");
  assert.equal(app.el("download").disabled, false);
  await app.click("playlist-load-more");
  assert.equal(
    app.calls.filter((call) => call.command === "parse_playlist_page")[1].args
      .start,
    4,
  );
  assert.match(app.el("playlist-summary").textContent, /3 selected/u);
});

test("changing the input while a playlist loads discards its late result", async () => {
  const pending = deferred<typeof page>();
  const app = await createApp({ parse_playlist_page: () => pending.promise });
  app.input("https://www.youtube.com/playlist?list=course");
  await app.click("parse");
  app.input(video.webpage_url);
  pending.resolve(page);
  await flush();
  assert.equal(app.el("download-workspace").hidden, true);
  assert.equal(app.el("download").disabled, true);
  assert.equal(app.el("playlist-list").children.length, 0);
});

test("request actions address their own ID and progress events do not alter other rows", async () => {
  const requests = entries.slice(0, 2).map((entry, index) => ({
    id: `request-${index + 1}`,
    revision: 1,
    request: {
      ...entry,
      audio_only: false,
      format_selector: "b",
      label: "Best",
    },
    status: index === 0 ? "running" : "failed",
    directory: "/downloads",
    filename: entry.title,
  }));
  const snapshot = { revision: 1, concurrency: 1, paused: false, requests };
  const app = await createApp({
    get_download_queue: () => structuredClone(snapshot),
    cancel_request: ({ id }) => ({
      ...snapshot,
      revision: 3,
      requests: requests.map((item) =>
        item.id === id ? { ...item, revision: 3, status: "cancelling" } : item,
      ),
    }),
    retry_request: ({ id }) => ({
      ...snapshot,
      revision: 4,
      requests: requests.map((item) =>
        item.id === id
          ? { ...item, revision: 4, status: "waiting" }
          : { ...item, revision: 3, status: "cancelled" },
      ),
    }),
  });
  app.emit("request-progress", {
    ...requests[0],
    revision: 2,
    progress: { percent: 42, status: "downloading" },
  });
  assert.match(
    app.el("queue-list").children[0].children[0].children[2].textContent,
    /42.0%/u,
  );
  assert.match(
    app.el("queue-list").children[1].children[0].children[2].textContent,
    /Failed/u,
  );
  app.el("queue-list").children[0].children[1].children[0].dispatch("click");
  await flush();
  assert.equal(
    app.calls.find((call) => call.command === "cancel_request")!.args.id,
    "request-1",
  );
  app.el("queue-list").children[1].children[1].children[0].dispatch("click");
  await flush();
  assert.equal(
    app.calls.find((call) => call.command === "retry_request")!.args.id,
    "request-2",
  );
});


test("audio-only selection creates audio requests and language changes keep the chosen quality", async () => {
  const app = await createApp({ parse_playlist_page: () => page });
  app.input("https://www.youtube.com/playlist?list=course");
  await app.click("parse");
  await app.click("select-all");
  app.el("quality").selectedIndex = 3;
  app.el("quality").dispatch("change");
  await app.click("language-zh");
  assert.equal(app.el("quality").selectedIndex, 3);
  assert.equal(app.el("quality").children[0].textContent, "最佳可用画质");
  app.el("media-mode").value = "audio";
  app.el("media-mode").dispatch("change");
  await app.click("download");
  const requests = app.calls.find(call => call.command === "enqueue_downloads")!.args.requests;
  assert.equal(requests.length, 7);
  assert.ok(requests.every((request: any) => request.audio_only && request.format_selector === "ba/b"));
});


test("pending queue options prevent a second change from sending stale pause state", async () => {
  const pending = deferred<{ revision: number; concurrency: number; paused: boolean; requests: [] }>();
  const app = await createApp({ set_queue_options: () => pending.promise });
  await app.click("queue-pause");
  assert.equal(app.el("queue-pause").disabled, true);
  assert.equal(app.el("queue-concurrency").disabled, true);
  app.el("queue-concurrency").value = "2";
  app.el("queue-concurrency").dispatch("change");
  assert.equal(app.calls.filter(call => call.command === "set_queue_options").length, 1);
  pending.resolve({ revision: 1, concurrency: 1, paused: true, requests: [] });
  await flush();
  assert.equal(app.el("queue-pause").disabled, false);
  assert.equal(app.el("queue-pause").textContent, "Resume starting requests");
  assert.equal(app.el("queue-concurrency").value, "1");
});
