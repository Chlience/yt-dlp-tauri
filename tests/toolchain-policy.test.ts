import assert from "node:assert/strict";
import test from "node:test";

import {
  readToolchainPolicy,
  sourceById,
  validateToolchainPolicy,
} from "../scripts/toolchain/policy.mjs";

const archive = {
  enabled: true,
  repository: "Chlience/yt-dlp-tauri-toolchain",
  assetNameTemplate: "{source}-{version}-{assetStem}-{sha256Prefix}{extension}",
};

const redistribution = {
  licenseFiles: [],
  requiredEvidence: ["binary-release", "source-license"],
  noticeFiles: ["THIRD-PARTY-NOTICES.md"],
};

test("production policy covers every populated manifest target", () => {
  const policy = readToolchainPolicy("toolchain-policy.json");

  assert.deepEqual(policy.targets, ["win-x64"]);
  assert.deepEqual(
    policy.sources.map((source) => source.id),
    ["yt-dlp", "deno", "ffmpeg-windows"],
  );
  assert.equal(sourceById(policy, "deno").repository, "denoland/deno");
  assert.deepEqual(sourceById(policy, "deno").redistribution.licenseFiles, [
    "third-party/deno/LICENSE.md",
  ]);
  for (const source of policy.sources) {
    assert.deepEqual(source.archive, archive);
    assert.ok(source.redistribution.requiredEvidence.length > 0);
    assert.ok(Array.isArray(source.redistribution.licenseFiles));
    assert.ok(Array.isArray(source.redistribution.noticeFiles));
  }
  assert.deepEqual(sourceById(policy, "ffmpeg-windows").redistribution, {
    licenseFiles: ["LICENSE", "THIRD-PARTY-NOTICES.md"],
    requiredEvidence: [
      "official-checksum",
      "binary-release",
      "source-revision",
      "build-revision",
      "source-license",
      "third-party-notices",
    ],
    noticeFiles: ["THIRD-PARTY-NOTICES.md", "docs/ffmpeg-redistribution.md"],
  });
});

test("policy rejects the retired redirect source adapter", () => {
  assert.throws(
    () =>
      validateToolchainPolicy({
        schemaVersion: 2,
        targets: ["win-x64"],
        approvedHosts: ["github.com"],
        sources: [
          {
            id: "bad",
            adapter: "redirect-release",
            selection: "latest-redirect",
            archive,
            redistribution,
            assets: [
              {
                target: "win-x64",
                url: "https://evil.test/tool.zip",
                kind: "zip",
                members: [],
              },
            ],
          },
        ],
      }),
    /unsupported adapter redirect-release/,
  );
});

test("policy rejects duplicate source identifiers", () => {
  const source = {
    id: "duplicate",
    adapter: "github-release",
    repository: "owner/repository",
    selection: "latest-stable",
    archive,
    redistribution,
    assets: [
      {
        target: "win-x64",
        assetName: "tool.exe",
        kind: "file",
        members: [
          {
            tool: "tool",
            path: "Tools/win-x64/tool/tool.exe",
            licenseNotes: "Test license",
          },
        ],
      },
    ],
  };

  assert.throws(
    () =>
      validateToolchainPolicy({
        schemaVersion: 2,
        targets: ["win-x64"],
        approvedHosts: ["github.com"],
        sources: [source, { ...source }],
      }),
    /duplicate source id duplicate/,
  );
});

test("policy requires archive declarations for every source", () => {
  const policy = readToolchainPolicy("toolchain-policy.json");
  const source = structuredClone(sourceById(policy, "yt-dlp"));
  delete source.archive;

  assert.throws(
    () => validateToolchainPolicy({ ...policy, sources: [source] }),
    /source yt-dlp archive must be an object/u,
  );
});

test("policy rejects unknown redistribution evidence", () => {
  const policy = readToolchainPolicy("toolchain-policy.json");
  const source = structuredClone(sourceById(policy, "ffmpeg-windows"));
  source.redistribution.requiredEvidence.push("unreviewed-evidence");

  assert.throws(
    () => validateToolchainPolicy({ ...policy, sources: [source] }),
    /unknown redistribution evidence unreviewed-evidence/u,
  );
});

test("policy rejects unsafe redistribution paths", () => {
  const policy = readToolchainPolicy("toolchain-policy.json");
  const source = structuredClone(sourceById(policy, "deno"));
  source.redistribution.noticeFiles = ["../NOTICE"];

  assert.throws(
    () => validateToolchainPolicy({ ...policy, sources: [source] }),
    /safe relative path/u,
  );
});
