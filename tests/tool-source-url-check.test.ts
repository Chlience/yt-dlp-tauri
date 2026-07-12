import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  checkToolSourceUrl,
  evaluateToolSourceUrls,
  selectSourceCheckManifest,
} from "../scripts/check-tool-source-urls.mjs";

test("pre-publication source checks use immutable upstream URLs", () => {
  const manifest = JSON.parse(readFileSync("src-tauri/tools-manifest.json", "utf8"));
  const policy = JSON.parse(readFileSync("toolchain-policy.json", "utf8"));
  const lock = JSON.parse(readFileSync("toolchain-lock.json", "utf8"));

  const selected = selectSourceCheckManifest({
    sourceMode: "upstream",
    manifest,
    policy,
    lock,
  });
  const ffmpegUrls = selected.targets
    .find((target) => target.target === "win-x64")
    .tools.filter((tool) => ["ffmpeg", "ffprobe"].includes(tool.name))
    .map((tool) => tool.sourceUrl);

  assert.ok(ffmpegUrls.every((url) => url.includes("yt-dlp/FFmpeg-Builds")));
  assert.ok(ffmpegUrls.every((url) => !url.includes("toolchain-stable")));
});

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

test("tool source URL check falls back to a ranged GET when HEAD is unsupported", async () => {
  const calls: RequestInit[] = [];
  const result = await checkToolSourceUrl(
    "https://example.test/tool.zip",
    async (_url, init) => {
      calls.push(init ?? {});
      return init?.method === "HEAD"
        ? new Response(null, { status: 405, statusText: "Method Not Allowed" })
        : new Response("x", { status: 206, statusText: "Partial Content" });
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["HEAD", "GET"],
  );
  assert.equal((calls[1].headers as Record<string, string>).Range, "bytes=0-0");
});
