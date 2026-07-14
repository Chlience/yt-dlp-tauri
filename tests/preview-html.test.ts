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

test("release notes dialog is available from Settings", () => {
  const html = readFileSync("index.html", "utf8");

  assert.match(html, /\bid="release-notes-button"/);
  assert.match(html, /\bid="release-notes-backdrop"/);
  assert.match(html, /\bid="release-notes-dialog"/);
  assert.match(html, /\bid="release-notes-list"/);
});

test("toolchain settings expose managed and local sources with path controls", () => {
  const html = readFileSync("index.html", "utf8");

  assert.match(html, /id="tool-source-managed"/u);
  assert.match(html, /id="tool-source-local"/u);
  assert.match(html, /id="local-toolchain-paths"/u);
  assert.match(html, /id="choose-local-yt-dlp"/u);
  assert.match(html, /id="choose-local-ffmpeg"/u);
  assert.match(html, /id="choose-local-deno"/u);
  assert.match(html, /id="auto-detect-local-tools"/u);
});

test("status messages render in a toast region", () => {
  const html = readFileSync("index.html", "utf8");

  assert.match(html, /\bid="toast-region"/);
  assert.match(html, /\baria-live="polite"/);
  assert.doesNotMatch(html, /\bid="notice"/);
});
