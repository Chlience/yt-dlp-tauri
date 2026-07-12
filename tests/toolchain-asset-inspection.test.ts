import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  inspectAsset,
  selectArchiveMember,
  sha256File,
} from "../scripts/toolchain/inspect-asset.mjs";

const execFileAsync = promisify(execFile);
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

test("archive member selection requires exactly one normalized suffix match", () => {
  assert.equal(
    selectArchiveMember(
      ["ffmpeg-build/bin/ffmpeg.exe", "ffmpeg-build/bin/ffprobe.exe"],
      "bin/ffmpeg.exe",
    ),
    "ffmpeg-build/bin/ffmpeg.exe",
  );
  assert.throws(
    () =>
      selectArchiveMember(
        ["a/bin/ffmpeg.exe", "b/bin/ffmpeg.exe"],
        "bin/ffmpeg.exe",
      ),
    /multiple archive members/,
  );
  assert.throws(
    () => selectArchiveMember(["../bin/ffmpeg.exe"], "bin/ffmpeg.exe"),
    /unsafe archive member/,
  );
  assert.throws(
    () => selectArchiveMember(["C:\\bin\\ffmpeg.exe"], "bin/ffmpeg.exe"),
    /unsafe archive member/,
  );
});

test("sha256File returns lowercase hex", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "toolchain-hash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "asset.bin");
  await writeFile(path, "abc");

  assert.equal(await sha256File(path), ABC_SHA256);
});

test("inspectAsset streams and hashes a standalone executable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "toolchain-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await inspectAsset({
    url: "https://github.com/example/tool/releases/download/v1/tool.exe",
    kind: "file",
    tempDirectory: root,
    expectedSha256: ABC_SHA256,
    members: [{ tool: "tool" }],
    fetchImpl: async () => new Response("abc"),
  });

  assert.deepEqual(result, {
    size: 3,
    sha256: ABC_SHA256,
    members: [{ tool: "tool", archivePath: null, size: 3, sha256: ABC_SHA256 }],
  });
});

test(
  "inspectAsset extracts and hashes only selected ZIP members",
  {
    skip:
      process.platform === "win32"
        ? "Info-ZIP is not guaranteed on Windows runners"
        : false,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "toolchain-zip-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixtureRoot = join(root, "fixture");
    const binaryRoot = join(fixtureRoot, "ffmpeg-build", "bin");
    const archivePath = join(root, "ffmpeg.zip");
    await mkdir(binaryRoot, { recursive: true });
    await writeFile(join(binaryRoot, "ffmpeg.exe"), "abc");
    await writeFile(join(binaryRoot, "ffprobe.exe"), "probe");
    await execFileAsync("zip", ["-q", "-r", archivePath, "ffmpeg-build"], {
      cwd: fixtureRoot,
    });
    const archive = await readFile(archivePath);

    const result = await inspectAsset({
      url: "https://github.com/example/tool/releases/download/v1/ffmpeg.zip",
      kind: "zip",
      tempDirectory: join(root, "downloads"),
      members: [
        { tool: "ffmpeg", archivePathSuffix: "bin/ffmpeg.exe" },
        { tool: "ffprobe", archivePathSuffix: "bin/ffprobe.exe" },
      ],
      fetchImpl: async () => new Response(archive),
    });

    assert.equal(result.sha256, await sha256File(archivePath));
    assert.deepEqual(result.members, [
      {
        tool: "ffmpeg",
        archivePath: "ffmpeg-build/bin/ffmpeg.exe",
        size: 3,
        sha256: ABC_SHA256,
      },
      {
        tool: "ffprobe",
        archivePath: "ffmpeg-build/bin/ffprobe.exe",
        size: 5,
        sha256: "ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095",
      },
    ]);
  },
);

test("inspectAsset rejects a downloaded asset with the wrong digest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "toolchain-digest-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      inspectAsset({
        url: "https://github.com/example/tool/releases/download/v1/tool.exe",
        kind: "file",
        tempDirectory: root,
        expectedSha256: "0".repeat(64),
        members: [{ tool: "tool" }],
        fetchImpl: async () => new Response("abc"),
      }),
    new RegExp(`has SHA-256 ${ABC_SHA256}, expected ${"0".repeat(64)}`),
  );
});
