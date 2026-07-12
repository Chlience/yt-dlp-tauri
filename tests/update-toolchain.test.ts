import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseUpdateToolchainArgs,
  runUpdateToolchain,
} from "../scripts/update-toolchain.mjs";

const fixturePath = "tests/fixtures/toolchain/resolver-input.json";

async function updateWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), "update-toolchain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    root,
    policyPath: join(root, "toolchain-policy.json"),
    lockPath: join(root, "toolchain-lock.json"),
    manifestPath: join(root, "tools-manifest.json"),
    changelogPath: join(root, "TOOLCHAIN_CHANGELOG.md"),
  };
  await writeFile(paths.policyPath, await readFile("toolchain-policy.json"));
  await writeFile(paths.manifestPath, await readFile("src-tauri/tools-manifest.json"));
  await writeFile(paths.changelogPath, await readFile("TOOLCHAIN_CHANGELOG.md"));
  return paths;
}

test("fixture update writes lock, manifest, and toolchain changelog together", async (t) => {
  const paths = await updateWorkspace(t);
  const result = await runUpdateToolchain({
    ...paths,
    fixturePath,
    now: new Date("2026-07-11T00:00:00Z"),
  });

  assert.equal(result.changed, true);
  assert.equal(result.revision, "20260711.1");
  assert.deepEqual(result.updatedSources, [
    "deno",
    "ffmpeg-windows",
    "yt-dlp",
  ]);
  const resolvedLock = JSON.parse(await readFile(paths.lockPath, "utf8"));
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  const changelog = await readFile(paths.changelogPath, "utf8");
  assert.equal(manifest.revision, result.revision);
  assert.equal(resolvedLock.revision, result.revision);
  assert.match(changelog, /## 20260711\.1 - 2026-07-11/);
  assert.deepEqual(
    resolvedLock.sources
      .find((source) => source.id === "ffmpeg-windows")
      .assets[0].members.map((member) => member.tool),
    ["ffmpeg", "ffprobe"],
  );

  const before = await Promise.all([
    readFile(paths.lockPath, "utf8"),
    readFile(paths.manifestPath, "utf8"),
    readFile(paths.changelogPath, "utf8"),
  ]);
  const second = await runUpdateToolchain({
    ...paths,
    fixturePath,
    now: new Date("2026-07-11T01:00:00Z"),
  });
  const after = await Promise.all([
    readFile(paths.lockPath, "utf8"),
    readFile(paths.manifestPath, "utf8"),
    readFile(paths.changelogPath, "utf8"),
  ]);
  assert.equal(second.changed, false);
  assert.deepEqual(after, before);
});

test("dry-run generates a result without writing output files", async (t) => {
  const paths = await updateWorkspace(t);
  const manifestBefore = await readFile(paths.manifestPath, "utf8");
  const result = await runUpdateToolchain({
    ...paths,
    fixturePath,
    dryRun: true,
    now: new Date("2026-07-11T00:00:00Z"),
  });

  assert.equal(result.changed, true);
  await assert.rejects(() => readFile(paths.lockPath), /ENOENT/);
  assert.equal(await readFile(paths.manifestPath, "utf8"), manifestBefore);
});

test("focused update changes one source and preserves the remaining lock", async (t) => {
  const paths = await updateWorkspace(t);
  await runUpdateToolchain({
    ...paths,
    fixturePath,
    now: new Date("2026-07-11T00:00:00Z"),
  });
  const before = JSON.parse(await readFile(paths.lockPath, "utf8"));
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const release = fixture.githubReleases["yt-dlp/yt-dlp"][0];
  release.id = 111;
  release.tagName = "2026.07.11";
  release.publishedAt = "2026-07-11T08:00:00Z";
  release.htmlUrl = "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.11";
  for (const asset of release.assets) {
    const oldUrl = asset.url;
    asset.url = oldUrl.replace("2026.07.10", "2026.07.11");
    asset.sha256 = asset.name === "yt-dlp.exe" ? "7".repeat(64) : "8".repeat(64);
    fixture.inspections[asset.url] = {
      ...fixture.inspections[oldUrl],
      sha256: asset.sha256,
      members: fixture.inspections[oldUrl].members.map((member) => ({
        ...member,
        sha256: asset.sha256,
      })),
    };
  }
  const nextFixturePath = join(paths.root, "resolver-input-next.json");
  await writeFile(nextFixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  const result = await runUpdateToolchain({
    ...paths,
    fixturePath: nextFixturePath,
    only: "yt-dlp",
    now: new Date("2026-07-11T09:00:00Z"),
  });
  const after = JSON.parse(await readFile(paths.lockPath, "utf8"));

  assert.deepEqual(result.updatedSources, ["yt-dlp"]);
  assert.equal(result.revision, "20260711.2");
  assert.deepEqual(
    after.sources.filter((source) => source.id !== "yt-dlp"),
    before.sources.filter((source) => source.id !== "yt-dlp"),
  );
});

test("argument parser supports exact update flags", () => {
  assert.deepEqual(
    parseUpdateToolchainArgs([
      "--policy",
      "policy.json",
      "--lock",
      "lock.json",
      "--manifest",
      "manifest.json",
      "--changelog",
      "changes.md",
      "--fixture",
      "fixture.json",
      "--only",
      "deno",
      "--now",
      "2026-07-11T00:00:00Z",
      "--dry-run",
    ]),
    {
      policyPath: "policy.json",
      lockPath: "lock.json",
      manifestPath: "manifest.json",
      changelogPath: "changes.md",
      fixturePath: "fixture.json",
      only: "deno",
      now: new Date("2026-07-11T00:00:00Z"),
      dryRun: true,
    },
  );
  assert.throws(() => parseUpdateToolchainArgs(["--unknown", "value"]), /Unknown argument/);
});
