import assert from "node:assert/strict";
import test from "node:test";

import {
  createFfmpegProvenanceAsset,
  resolveFfmpegProvenance,
  verifyFfmpegProvenance,
} from "../scripts/toolchain/ffmpeg-provenance.mjs";

function ffmpegLockSource() {
  return {
    id: "ffmpeg-windows",
    repository: "yt-dlp/FFmpeg-Builds",
    version: "autobuild-2026-06-30-16-38",
    assets: [
      {
        target: "win-x64",
        releaseId: 346969279,
        releaseTag: "autobuild-2026-06-30-16-38",
        releaseUrl:
          "https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/autobuild-2026-06-30-16-38",
        assetId: 462330428,
        assetName: "ffmpeg-N-125365-g9a01c1cb6a-win64-gpl.zip",
        sourceUrl:
          "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/autobuild-2026-06-30-16-38/ffmpeg-N-125365-g9a01c1cb6a-win64-gpl.zip",
        size: 167300768,
        sha256: "a".repeat(64),
      },
    ],
  };
}

function completeProvenance() {
  return {
    binaryReleaseUrl:
      "https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/autobuild-2026-06-30-16-38",
    binarySha256: "a".repeat(64),
    ffmpegSourceRevision: "b".repeat(40),
    buildRepositoryRevision: "c".repeat(40),
    checksumUrl:
      "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/autobuild-2026-06-30-16-38/checksums.sha256",
    licenseFiles: ["GPLv3.txt", "THIRD-PARTY-NOTICES.md"],
  };
}

test("mirror eligibility requires binary, source, build, checksum, and license provenance", () => {
  const result = verifyFfmpegProvenance(ffmpegLockSource(), completeProvenance());

  assert.equal(result.eligible, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.assets[0].sha256, "a".repeat(64));
});

test("mirror eligibility rejects a binary digest that differs from the lock", () => {
  const result = verifyFfmpegProvenance(ffmpegLockSource(), {
    ...completeProvenance(),
    binarySha256: "d".repeat(64),
  });

  assert.equal(result.eligible, false);
  assert.match(result.problems.join("\n"), /binary SHA-256.*lock/u);
});

test("mirror eligibility rejects mutable revisions and checksum URLs", () => {
  const result = verifyFfmpegProvenance(ffmpegLockSource(), {
    ...completeProvenance(),
    ffmpegSourceRevision: "master",
    buildRepositoryRevision: "main",
    checksumUrl:
      "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/checksums.sha256",
  });

  assert.equal(result.eligible, false);
  assert.match(result.problems.join("\n"), /full 40-character commit/u);
  assert.match(result.problems.join("\n"), /immutable release checksum/u);
});

test("mirror eligibility requires GPL and project notice files", () => {
  const result = verifyFfmpegProvenance(ffmpegLockSource(), {
    ...completeProvenance(),
    licenseFiles: ["README.md"],
  });

  assert.equal(result.eligible, false);
  assert.match(result.problems.join("\n"), /GPL license file/u);
  assert.match(result.problems.join("\n"), /THIRD-PARTY-NOTICES\.md/u);
});

test("publication provenance uses the exact revision and immutable asset identity", () => {
  const asset = createFfmpegProvenanceAsset(
    "20260711.1",
    ffmpegLockSource(),
    completeProvenance(),
  );

  assert.equal(asset.schemaVersion, 1);
  assert.equal(asset.revision, "20260711.1");
  assert.equal(asset.binary.assetId, "462330428");
  assert.equal(asset.ffmpegSource.revision, "b".repeat(40));
  assert.equal(asset.buildRepository.revision, "c".repeat(40));
});

test("resolver binds release, checksum, build tag, and FFmpeg commit", async () => {
  const source = ffmpegLockSource();
  const binary = source.assets[0];
  const checksumUrl = `${binary.sourceUrl.slice(0, binary.sourceUrl.lastIndexOf("/") + 1)}checksums.sha256`;
  const responses = new Map([
    [
      `https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases/tags/${binary.releaseTag}`,
      {
        id: binary.releaseId,
        tag_name: binary.releaseTag,
        assets: [
          { id: binary.assetId, name: binary.assetName },
          { id: 999, name: "checksums.sha256", browser_download_url: checksumUrl },
        ],
      },
    ],
    [
      `https://api.github.com/repos/yt-dlp/FFmpeg-Builds/git/ref/tags/${binary.releaseTag}`,
      { object: { type: "commit", sha: "c".repeat(40) } },
    ],
    [
      "https://api.github.com/repos/FFmpeg/FFmpeg/commits/9a01c1cb6a",
      { sha: "b".repeat(40) },
    ],
  ]);
  const provenance = await resolveFfmpegProvenance(source, {
    fetchImpl: async (url: string) => {
      if (url === checksumUrl) {
        return new Response(`${binary.sha256}  ${binary.assetName}\n`);
      }
      const body = responses.get(url);
      if (!body) return new Response("missing", { status: 404 });
      return Response.json(body);
    },
    licenseFiles: ["LICENSE", "THIRD-PARTY-NOTICES.md"],
  });

  assert.equal(provenance.binarySha256, binary.sha256);
  assert.equal(provenance.ffmpegSourceRevision, "b".repeat(40));
  assert.equal(provenance.buildRepositoryRevision, "c".repeat(40));
  assert.equal(verifyFfmpegProvenance(source, provenance).eligible, true);
});
