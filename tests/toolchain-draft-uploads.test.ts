import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createDraftUploadPlan } from "../scripts/prepare-toolchain-draft-uploads.mjs";

const binarySha256 = "a".repeat(64);
const metadataSha256 = "b".repeat(64);

function publicationPlan() {
  const requiredDraftAssets = [
    { name: "yt-dlp.exe", size: 3, sha256: binarySha256 },
    { name: "tools-manifest.json", size: 4, sha256: metadataSha256 },
  ];
  return {
    mode: "publish",
    operations: [
      {
        kind: "upload",
        path: `assets/${binarySha256}`,
        descriptor: {
          assetName: "yt-dlp.exe",
          size: 3,
          sha256: binarySha256,
        },
      },
      {
        kind: "metadata",
        path: ".toolchain/publication/tools-manifest.json",
        asset: requiredDraftAssets[1],
      },
      { kind: "publish-release", requiredDraftAssets },
    ],
  };
}

test("draft uploads stage every missing asset under its public name", () => {
  const result = createDraftUploadPlan(publicationPlan(), { assets: [] });

  assert.deepEqual(result.uploads, [
    {
      name: "yt-dlp.exe",
      size: 3,
      sha256: binarySha256,
      sourcePath: join(".toolchain/candidate", `assets/${binarySha256}`),
      uploadPath: join(".toolchain/publication/draft-uploads", "yt-dlp.exe"),
    },
    {
      name: "tools-manifest.json",
      size: 4,
      sha256: metadataSha256,
      sourcePath: ".toolchain/publication/tools-manifest.json",
      uploadPath: join(
        ".toolchain/publication/draft-uploads",
        "tools-manifest.json",
      ),
    },
  ]);
  assert.deepEqual(result.reused, []);
});

test("draft uploads reuse only exact existing assets", () => {
  const result = createDraftUploadPlan(publicationPlan(), {
    assets: [
      {
        id: 1,
        name: "yt-dlp.exe",
        size: 3,
        digest: `sha256:${binarySha256}`,
      },
      {
        id: 2,
        name: "tools-manifest.json",
        size: 4,
        digest: `sha256:${metadataSha256}`,
      },
    ],
  });

  assert.deepEqual(result.uploads, []);
  assert.deepEqual(result.reused, ["yt-dlp.exe", "tools-manifest.json"]);
});

test("draft uploads reject mismatched or unexpected existing assets", () => {
  assert.throws(
    () =>
      createDraftUploadPlan(publicationPlan(), {
        assets: [
          {
            id: 1,
            name: "yt-dlp.exe",
            size: 3,
            digest: `sha256:${"c".repeat(64)}`,
          },
        ],
      }),
    /yt-dlp\.exe.*digest/iu,
  );
  assert.throws(
    () =>
      createDraftUploadPlan(publicationPlan(), {
        assets: [
          {
            id: 1,
            name: "unexpected.bin",
            size: 1,
            digest: `sha256:${"c".repeat(64)}`,
          },
        ],
      }),
    /unexpected draft asset/iu,
  );
});
