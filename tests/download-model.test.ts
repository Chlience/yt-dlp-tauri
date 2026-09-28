import assert from "node:assert/strict";
import test from "node:test";
import { QueueModel, type DownloadItem } from "../src/download-model.ts";
import {
  linkScope,
  mergeEntries,
  selectRange,
  type PlaylistItem,
} from "../src/playlist-model.ts";

const item = (revision: number, percent = 0): DownloadItem => ({
  id: "request-1",
  revision,
  status: "running",
  directory: "/downloads",
  filename: "Video",
  request: {
    url: "https://video.example/1",
    title: "Video",
    format_selector: "b",
    label: "Best",
    audio_only: false,
  },
  progress: { status: "downloading", percent },
});

test("newer request progress survives late snapshots and cleared rows stay cleared", () => {
  const model = new QueueModel();
  model.progress(item(5, 50));
  model.apply({
    revision: 3,
    concurrency: 1,
    paused: false,
    requests: [item(3)],
  });
  assert.equal(model.snapshot.requests[0].progress?.percent, 50);
  model.apply({
    revision: 4,
    concurrency: 2,
    paused: false,
    requests: [item(3)],
  });
  assert.equal(model.snapshot.requests[0].progress?.percent, 50);
  model.progress(item(4, 40));
  assert.equal(model.snapshot.requests[0].progress?.percent, 50);
  model.apply({ revision: 7, concurrency: 2, paused: false, requests: [] });
  model.progress(item(6, 60));
  model.apply({
    revision: 2,
    concurrency: 1,
    paused: false,
    requests: [item(2)],
  });
  assert.equal(model.snapshot.requests.length, 0);
  assert.equal(model.snapshot.concurrency, 2);
});

test("selection preserves original numbers, skips unavailable items, and rejects unloaded ranges", () => {
  const entries: PlaylistItem[] = [1, 2, 3, 4, 5, 6, 7].map((index) => ({
    index,
    title: `Video ${index}`,
    url: `https://video.example/${index}`,
  }));
  entries[3].unavailable_reason = "Private";
  assert.deepEqual([...selectRange("3-5,7", entries)!], [3, 5, 7]);
  for (const value of ["0", "7-3", "3,x", "1-999999999999", "8"])
    assert.equal(selectRange(value, entries), null);
  assert.deepEqual([...selectRange("", entries)!], []);
  assert.deepEqual(
    mergeEntries(entries.slice(0, 3), [entries[2], entries[4]]).map(
      (item) => item.index,
    ),
    [1, 2, 3, 5],
  );
});

test("scope choices distinguish video links with a playlist from pure list links", () => {
  assert.equal(linkScope("https://www.youtube.com/watch?v=a&list=b"), "choice");
  assert.equal(
    linkScope("https://www.youtube.com/playlist?list=b"),
    "playlist",
  );
  assert.equal(
    linkScope("https://www.bilibili.com/video/BV123/?p=3"),
    "choice",
  );
  assert.equal(linkScope("https://video.example/watch/1"), "video");
});
