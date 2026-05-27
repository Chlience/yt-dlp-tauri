import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("thumbnail preview does not send referrer to remote CDNs", () => {
  const html = readFileSync("index.html", "utf8");
  const thumbnailTag = html.match(/<img\b[^>]*\bid="thumbnail"[^>]*>/)?.[0] ?? "";

  assert.match(thumbnailTag, /\breferrerpolicy="no-referrer"/);
});

test("cookie controls are available beside the URL workflow", () => {
  const html = readFileSync("index.html", "utf8");
  const urlPanel = html.match(/<section class="url-panel"[\s\S]*?<\/section>/)?.[0] ?? "";

  assert.match(urlPanel, /\bid="cookies-file"/);
  assert.match(urlPanel, /\bid="choose-cookies"/);
  assert.match(urlPanel, /\bid="clear-cookies"/);
});
