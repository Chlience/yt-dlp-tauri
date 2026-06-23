import assert from "node:assert/strict";
import test from "node:test";

import { evaluateToolSourceUrls } from "../scripts/check-tool-source-urls.mjs";

test("tool source URL check reports unavailable manifest URLs with target and tool names", async () => {
  const manifest = {
    targets: [
      {
        target: "win-x64",
        tools: [
          {
            name: "ffmpeg",
            sourceUrl: "https://example.test/missing.zip",
          },
          {
            name: "ffprobe",
            sourceUrl: "https://example.test/missing.zip",
          },
          {
            name: "yt-dlp",
            sourceUrl: "https://example.test/yt-dlp.exe",
          },
        ],
      },
    ],
  };
  const checkedUrls: string[] = [];

  const result = await evaluateToolSourceUrls(manifest, async (url: string) => {
    checkedUrls.push(url);
    if (url.endsWith("/missing.zip")) {
      return { ok: false, status: 404, statusText: "Not Found" };
    }
    return { ok: true, status: 200, statusText: "OK" };
  });

  assert.deepEqual(checkedUrls, [
    "https://example.test/missing.zip",
    "https://example.test/yt-dlp.exe",
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    "win-x64 ffmpeg sourceUrl is unavailable. 404 Not Found. https://example.test/missing.zip",
    "win-x64 ffprobe sourceUrl is unavailable. 404 Not Found. https://example.test/missing.zip",
  ]);
});

test("tool source URL check retries transient failures", async () => {
  const manifest = {
    targets: [
      {
        target: "win-x64",
        tools: [
          {
            name: "deno",
            sourceUrl: "https://example.test/deno.zip",
          },
        ],
      },
    ],
  };
  let attempts = 0;

  const result = await evaluateToolSourceUrls(manifest, async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("fetch failed");
    }
    return { ok: true, status: 200, statusText: "OK" };
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    ok: true,
    checkedUrlCount: 1,
    problems: [],
  });
});
