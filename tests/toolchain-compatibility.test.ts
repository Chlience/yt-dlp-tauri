import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assertAudioVideoStreams,
  ffmpegDashCommand,
  runCommand,
  runCompatibilitySuite,
  startMediaServer,
  ytDlpDashCommand,
} from "../scripts/toolchain/compatibility.mjs";
import { nativeToolchainTarget } from "../scripts/toolchain/current-target.mjs";

test("DASH download pins Deno and FFmpeg paths", () => {
  const command = ytDlpDashCommand({
    ytDlp: "/tools/yt-dlp",
    deno: "/tools/deno",
    ffmpegDir: "/tools/ffmpeg/bin",
    manifestUrl: "http://127.0.0.1:43123/media.mpd",
    output: "/tmp/result.%(ext)s",
  });

  assert.deepEqual(command.args.slice(0, 6), [
    "--no-js-runtimes",
    "--js-runtimes",
    "deno:/tools/deno",
    "--ffmpeg-location",
    "/tools/ffmpeg/bin",
    "-f",
  ]);
  assert.equal(command.args[6], "bestvideo+bestaudio");
});

test("media generation uses synthetic video and audio inputs", () => {
  const command = ffmpegDashCommand({
    ffmpeg: "/tools/ffmpeg",
    outputDirectory: "/tmp/media",
  });

  assert.equal(command.command, "/tools/ffmpeg");
  assert.ok(command.args.includes("testsrc2=size=320x180:rate=24"));
  assert.ok(command.args.includes("sine=frequency=1000:sample_rate=48000"));
  assert.ok(command.args.includes("dash"));
});

test("native target mapping covers every supported runner", () => {
  assert.equal(nativeToolchainTarget("win32", "x64"), "win-x64");
  assert.throws(
    () => nativeToolchainTarget("darwin", "x64"),
    /Unsupported native toolchain target/,
  );
  assert.throws(
    () => nativeToolchainTarget("linux", "x64"),
    /Unsupported native toolchain target/,
  );
});

test("FFprobe requires one audio and one video stream", () => {
  assert.doesNotThrow(() =>
    assertAudioVideoStreams({
      streams: [{ codec_type: "video" }, { codec_type: "audio" }],
    }),
  );
  assert.throws(
    () => assertAudioVideoStreams({ streams: [{ codec_type: "video" }] }),
    /audio stream/,
  );
});

test("command failures prefer error lines over warnings", async () => {
  await assert.rejects(
    runCommand({
      command: process.execPath,
      args: [
        "-e",
        "console.error('WARNING: fallback'); console.error('ERROR: root cause'); process.exit(1)",
      ],
    }),
    /ERROR: root cause/u,
  );
});

test("media server rejects decoded paths outside its root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "yt-dlp-tauri-media-server-"));
  const mediaRoot = join(parent, "media");
  await writeFile(join(parent, "outside.txt"), "private", { flag: "wx" });
  await mkdir(mediaRoot);
  await writeFile(join(mediaRoot, "media.mpd"), "manifest");
  const server = await startMediaServer(mediaRoot);

  try {
    const valid = await fetch(`${server.origin}/media.mpd`);
    assert.equal(valid.status, 200);
    assert.equal(await valid.text(), "manifest");

    const traversal = await fetch(`${server.origin}/%2e%2e%2foutside.txt`);
    assert.equal(traversal.status, 403);
  } finally {
    await server.close();
    await rm(dirname(mediaRoot), { recursive: true, force: true });
  }
});

test("compatibility suite runs generation, download, and probe in order", async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "yt-dlp-tauri-suite-"));
  const commands: string[] = [];
  const smokeReport = {
    target: "win-x64",
    ffmpegDirectory: "/tools/ffmpeg/bin",
    denoBinary: "/tools/deno",
    tools: [
      { name: "yt-dlp", full_path: "/tools/yt-dlp" },
      { name: "ffmpeg", full_path: "/tools/ffmpeg/bin/ffmpeg" },
      { name: "ffprobe", full_path: "/tools/ffmpeg/bin/ffprobe" },
      { name: "deno", full_path: "/tools/deno" },
    ],
  };

  try {
    const report = await runCompatibilitySuite({
      smokeReport,
      workRoot,
      commandRunner: async (command: { command: string }) => {
        commands.push(command.command);
        return command.command.endsWith("ffprobe")
          ? {
              code: 0,
              stdout: JSON.stringify({
                streams: [{ codec_type: "video" }, { codec_type: "audio" }],
              }),
              stderr: "",
            }
          : { code: 0, stdout: "", stderr: "" };
      },
    });

    assert.deepEqual(commands, [
      "/tools/ffmpeg/bin/ffmpeg",
      "/tools/yt-dlp",
      "/tools/ffmpeg/bin/ffprobe",
    ]);
    assert.deepEqual(report.streamTypes, ["audio", "video"]);
    assert.equal(report.ok, true);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});
