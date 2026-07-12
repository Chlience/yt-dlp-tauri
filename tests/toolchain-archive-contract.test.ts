import assert from "node:assert/strict";
import test from "node:test";

import {
  archiveAssetName,
  archiveDescriptorUrl,
  archiveReleaseTag,
  assignArchiveDescriptors,
  validateArchiveDescriptor,
  validateArchivePolicy,
} from "../scripts/toolchain/archive-contract.mjs";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const ARCHIVE_REPOSITORY = "Chlience/yt-dlp-tauri-toolchain";
const ASSET_NAME_TEMPLATE =
  "{source}-{version}-{assetStem}-{sha256Prefix}{extension}";

function archivePolicy() {
  return {
    enabled: true,
    repository: ARCHIVE_REPOSITORY,
    assetNameTemplate: ASSET_NAME_TEMPLATE,
  };
}

function policy() {
  return {
    sources: [
      {
        id: "yt-dlp",
        archive: archivePolicy(),
      },
    ],
  };
}

function sharedAsset() {
  return {
    target: "win-x64",
    assetName: "yt-dlp.exe",
    sourceUrl:
      "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe",
    kind: "file",
    size: 42,
    sha256: DIGEST_A,
    members: [],
  };
}

function lock(revision = "20260712.1") {
  return {
    schemaVersion: 2,
    revision,
    generatedAtUtc: "2026-07-12T00:00:00.000Z",
    targets: ["win-x64"],
    sources: [
      {
        id: "yt-dlp",
        version: "2026.07.04",
        assets: [sharedAsset(), sharedAsset()],
      },
    ],
  };
}

test("archive release tags are derived from strict toolchain revisions", () => {
  assert.equal(archiveReleaseTag("20260712.1"), "toolchain-20260712.1");
  assert.throws(() => archiveReleaseTag("v20260712.1"), /Invalid toolchain revision/u);
  assert.throws(() => archiveReleaseTag("20260712.0"), /Invalid toolchain revision/u);
});

test("archive names are deterministic and safe", () => {
  const name = archiveAssetName(
    { id: "deno", version: "v2.9.2" },
    {
      target: "win-x64",
      assetName: "deno-x86_64-pc-windows-msvc.zip",
      sourceUrl:
        "https://github.com/denoland/deno/releases/download/v2.9.2/deno-x86_64-pc-windows-msvc.zip",
      size: 123,
      sha256: DIGEST_A,
    },
    archivePolicy(),
  );

  assert.equal(
    name,
    "deno-v2.9.2-deno-x86_64-pc-windows-msvc-aaaaaaaaaaaaaaaa.zip",
  );
  assert.throws(
    () =>
      archiveAssetName(
        { id: "../deno", version: "v2.9.2" },
        {
          assetName: "deno.zip",
          sourceUrl: "https://example.test/deno.zip",
          size: 123,
          sha256: DIGEST_A,
        },
        archivePolicy(),
      ),
    /safe archive token/u,
  );
});

test("shared upstream bytes receive one archive descriptor", () => {
  const result = assignArchiveDescriptors({
    policy: policy(),
    currentLock: null,
    candidateLock: lock(),
  });
  const [first, second] = result.sources[0].assets;

  assert.deepEqual(first.archive, second.archive);
  assert.equal(first.archive.releaseTag, "toolchain-20260712.1");
  assert.equal(first.archive.repository, ARCHIVE_REPOSITORY);
  assert.equal(first.archive.size, 42);
  assert.equal(first.archive.sha256, DIGEST_A);
});

test("unchanged bytes preserve their historical descriptor", () => {
  const current = assignArchiveDescriptors({
    policy: policy(),
    currentLock: null,
    candidateLock: lock("20260711.2"),
  });
  const candidate = lock("20260712.1");
  const result = assignArchiveDescriptors({
    policy: policy(),
    currentLock: current,
    candidateLock: candidate,
  });

  assert.deepEqual(
    result.sources[0].assets[0].archive,
    current.sources[0].assets[0].archive,
  );
  assert.equal(result.sources[0].assets[0].archive.releaseTag, "toolchain-20260711.2");
});

test("changed bytes receive the candidate revision descriptor", () => {
  const current = assignArchiveDescriptors({
    policy: policy(),
    currentLock: null,
    candidateLock: lock("20260711.2"),
  });
  const candidate = lock("20260712.1");
  candidate.sources[0].assets[0].sha256 = DIGEST_B;
  candidate.sources[0].assets[0].size = 43;

  const result = assignArchiveDescriptors({
    policy: policy(),
    currentLock: current,
    candidateLock: candidate,
  });

  assert.equal(result.sources[0].assets[0].archive.releaseTag, "toolchain-20260712.1");
  assert.equal(result.sources[0].assets[0].archive.sha256, DIGEST_B);
  assert.equal(result.sources[0].assets[1].archive.releaseTag, "toolchain-20260711.2");
});

test("archive descriptors require exact repository, size, and digest", () => {
  const descriptor = {
    repository: ARCHIVE_REPOSITORY,
    releaseTag: "toolchain-20260712.1",
    assetName: "yt-dlp-2026.07.04-yt-dlp-aaaaaaaaaaaaaaaa.exe",
    size: 42,
    sha256: DIGEST_A,
  };

  assert.deepEqual(
    validateArchiveDescriptor(descriptor, {
      repository: ARCHIVE_REPOSITORY,
      size: 42,
      sha256: DIGEST_A,
    }),
    descriptor,
  );
  assert.throws(
    () => validateArchiveDescriptor(descriptor, { size: 43, sha256: DIGEST_A }),
    /size does not match/u,
  );
  assert.throws(
    () => validateArchiveDescriptor(descriptor, { size: 42, sha256: DIGEST_B }),
    /SHA-256 does not match/u,
  );
  assert.equal(
    archiveDescriptorUrl(descriptor),
    "https://github.com/Chlience/yt-dlp-tauri-toolchain/releases/download/toolchain-20260712.1/yt-dlp-2026.07.04-yt-dlp-aaaaaaaaaaaaaaaa.exe",
  );
});

test("archive policy requires the fixed repository and template", () => {
  assert.deepEqual(validateArchivePolicy(archivePolicy(), "deno"), archivePolicy());
  assert.throws(
    () =>
      validateArchivePolicy(
        { ...archivePolicy(), repository: "someone/else" },
        "deno",
      ),
    /archive repository/u,
  );
  assert.throws(
    () =>
      validateArchivePolicy(
        { ...archivePolicy(), assetNameTemplate: "{source}-{version}.zip" },
        "deno",
      ),
    /assetNameTemplate/u,
  );
});
