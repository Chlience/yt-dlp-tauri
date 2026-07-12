import assert from "node:assert/strict";
import test from "node:test";

import {
  createPublicationPlan,
  createRollbackPlan,
  verifyUploadedAsset,
} from "../scripts/publish-toolchain.mjs";
import { renderChannelRecord } from "../scripts/toolchain/channel.mjs";
import {
  createTargetReport,
  mergeTargetReports,
} from "../scripts/toolchain/validation-report.mjs";

function targetReport(target: string, windowsFfmpegSha256?: string) {
  const tools = ["deno", "ffmpeg", "ffprobe", "yt-dlp"].map((name) => ({
    name,
    version: "1.0.0",
  }));
  return createTargetReport({
    target,
    success: true,
    runnerImage: "windows-latest",
    architecture: "x64",
    checks: {
      supplyChain: true,
      executables: true,
      dash: true,
      projectTests: true,
    },
    tools,
    assets: tools.map((tool, index) => ({
      sourceId:
        target === "win-x64" && ["ffmpeg", "ffprobe"].includes(tool.name)
          ? "ffmpeg-windows"
          : tool.name,
      releaseId: index + 1,
      assetId: index + 10,
      assetName: `${tool.name}.zip`,
      sourceUrl: `https://example.test/${tool.name}.zip`,
      size: 100 + index,
      officialSha256:
        target === "win-x64" && ["ffmpeg", "ffprobe"].includes(tool.name)
          ? windowsFfmpegSha256 ?? String(index + 1).repeat(64)
          : String(index + 1).repeat(64),
    })),
    extractedHashes: tools.map((tool, index) => ({
      tool: tool.name,
      path: `Tools/${target}/${tool.name}`,
      sha256: String(index + 5).repeat(64),
    })),
  });
}

function releaseAsset(name: string, size: number, sha256: string) {
  return {
    name,
    size,
    digest: `sha256:${sha256}`,
    browser_download_url: `https://github.com/Chlience/yt-dlp-tauri/releases/download/toolchain-stable/${name}`,
  };
}

function publicationFixture(overrides = {}) {
  const revision = "20260711.1";
  const commitSha = "a".repeat(40);
  const manifestSha256 = "b".repeat(64);
  const lockSha256 = "c".repeat(64);
  const report = mergeTargetReports(
    [targetReport("win-x64")],
    {
      revision,
      commitSha,
      manifestSha256,
      lockSha256,
      runId: "1234",
      runUrl: "https://github.com/Chlience/yt-dlp-tauri/actions/runs/1234",
    },
  );
  if (overrides.reportCommitSha) report.commitSha = overrides.reportCommitSha;
  const mirrorName = `ffmpeg-win-x64-${revision}.zip`;
  return {
    repository: "Chlience/yt-dlp-tauri",
    revision,
    commitSha,
    mergedPullRequest: {
      number: 42,
      merged: true,
      mergeCommitSha: commitSha,
    },
    lock: {
      sha256: lockSha256,
      value: {
        revision,
        sources: [
          {
            id: "ffmpeg-windows",
            redistribution: {
              mirrorEligible: true,
              mirrorNameTemplate: "ffmpeg-win-x64-{revision}.zip",
            },
            assets: [{ target: "win-x64", sha256: "d".repeat(64), size: 1000 }],
          },
        ],
      },
    },
    manifest: {
      name: `tools-manifest-${revision}.json`,
      sha256: manifestSha256,
      size: 2048,
      value: {
        revision,
        targets: [
          {
            target: "win-x64",
            tools: [
              {
                name: "ffmpeg",
                sourceUrl: `https://github.com/Chlience/yt-dlp-tauri/releases/download/toolchain-stable/${mirrorName}`,
              },
              {
                name: "ffprobe",
                sourceUrl: `https://github.com/Chlience/yt-dlp-tauri/releases/download/toolchain-stable/${mirrorName}`,
              },
            ],
          },
        ],
      },
    },
    validation: {
      name: `toolchain-validation-${revision}.json`,
      sha256: "e".repeat(64),
      size: 4096,
      report,
    },
    mirrorCandidate: {
      name: mirrorName,
      sha256: "d".repeat(64),
      size: 1000,
      provenanceName: `ffmpeg-provenance-${revision}.json`,
      provenanceSha256: "f".repeat(64),
      provenanceSize: 1024,
      provenance: {
        schemaVersion: 1,
        revision,
        mirrorName,
        binary: { sha256: "d".repeat(64) },
      },
    },
    release: {
      id: 101,
      tag_name: "toolchain-stable",
      prerelease: true,
      draft: false,
      body: "# Stable toolchain\n\nManaged by automation\n",
      assets: [],
    },
    applicationRelease: {
      id: 202,
      tag_name: "v0.1.11",
      prerelease: false,
      draft: false,
    },
    currentChannel: {
      schemaVersion: 1,
      revision: "20260710.1",
      manifest: "tools-manifest-20260710.1.json",
      sha256: "9".repeat(64),
    },
    ...overrides,
  };
}

function rollbackFixture(overrides = {}) {
  const rollbackRevision = "20260710.1";
  const currentRevision = "20260711.2";
  const currentCommitSha = "8".repeat(40);
  const manifestSha256 = "1".repeat(64);
  const lockSha256 = "3".repeat(64);
  const mirrorSha256 = "2".repeat(64);
  const validationSha256 = "4".repeat(64);
  const provenanceSha256 = "5".repeat(64);
  const mirrorName = `ffmpeg-win-x64-${rollbackRevision}.zip`;
  const manifestName = `tools-manifest-${rollbackRevision}.json`;
  const validationName = `toolchain-validation-${rollbackRevision}.json`;
  const provenanceName = `ffmpeg-provenance-${rollbackRevision}.json`;
  const reports = [targetReport("win-x64", mirrorSha256)];
  const historicalReport = mergeTargetReports(reports, {
    revision: rollbackRevision,
    commitSha: "7".repeat(40),
    manifestSha256,
    lockSha256,
    runId: "1200",
    runUrl: "https://github.com/Chlience/yt-dlp-tauri/actions/runs/1200",
  });
  const revalidationReport = mergeTargetReports(reports, {
    revision: rollbackRevision,
    commitSha: currentCommitSha,
    manifestSha256,
    lockSha256,
    runId: "1300",
    runUrl: "https://github.com/Chlience/yt-dlp-tauri/actions/runs/1300",
  });
  const currentChannel = {
    schemaVersion: 1,
    revision: currentRevision,
    manifest: `tools-manifest-${currentRevision}.json`,
    sha256: "6".repeat(64),
  };
  const body = renderChannelRecord(
    "# Stable toolchain\n\nManaged by automation\n",
    currentChannel,
  );
  const provenance = {
    schemaVersion: 1,
    revision: rollbackRevision,
    mirrorName,
    binary: { sha256: mirrorSha256 },
  };
  return {
    mode: "rollback",
    repository: "Chlience/yt-dlp-tauri",
    rollbackRevision,
    currentCommitSha,
    reason: "Restore the last validated FFmpeg combination",
    actor: "maintainer",
    dryRun: false,
    skipRevalidation: false,
    release: {
      id: 101,
      tag_name: "toolchain-stable",
      prerelease: true,
      draft: false,
      body,
      assets: [
        releaseAsset(manifestName, 2048, manifestSha256),
        releaseAsset(validationName, 4096, validationSha256),
        releaseAsset(mirrorName, 1000, mirrorSha256),
        releaseAsset(provenanceName, 1024, provenanceSha256),
      ],
    },
    applicationRelease: {
      id: 202,
      tag_name: "v0.1.11",
      prerelease: false,
      draft: false,
    },
    historicalManifest: {
      name: manifestName,
      size: 2048,
      sha256: manifestSha256,
      value: {
        revision: rollbackRevision,
        targets: [
          {
            target: "win-x64",
            tools: [
              {
                name: "ffmpeg",
                sourceUrl: `https://github.com/Chlience/yt-dlp-tauri/releases/download/toolchain-stable/${mirrorName}`,
              },
              {
                name: "ffprobe",
                sourceUrl: `https://github.com/Chlience/yt-dlp-tauri/releases/download/toolchain-stable/${mirrorName}`,
              },
            ],
          },
        ],
      },
    },
    historicalValidation: {
      name: validationName,
      size: 4096,
      sha256: validationSha256,
      report: historicalReport,
    },
    historicalAssets: [
      { name: mirrorName, size: 1000, sha256: mirrorSha256 },
    ],
    historicalProvenance: {
      name: provenanceName,
      size: 1024,
      sha256: provenanceSha256,
      value: provenance,
    },
    revalidation: { report: revalidationReport },
    ...overrides,
  };
}

test("publication promotes the channel after every immutable asset", () => {
  const plan = createPublicationPlan(publicationFixture());

  assert.deepEqual(
    plan.steps.map((step) => step.kind),
    [
      "upload-ffmpeg",
      "verify-ffmpeg",
      "upload-provenance",
      "upload-manifest",
      "upload-validation",
      "promote-channel",
      "update-application-compatibility-manifest",
    ],
  );
  assert.equal(
    plan.steps.at(-1)?.releaseTag,
    "v0.1.11",
    "compatibility manifest must target the latest normal application release",
  );
});

test("publisher requires the fixed prerelease and a normal application release", () => {
  const stableRelease = publicationFixture().release;
  assert.throws(
    () =>
      createPublicationPlan(
        publicationFixture({ release: { ...stableRelease, prerelease: false } }),
      ),
    /stable release must be a prerelease/iu,
  );
  assert.throws(
    () =>
      createPublicationPlan(
        publicationFixture({
          applicationRelease: {
            id: 202,
            tag_name: "v0.1.11",
            prerelease: true,
            draft: false,
          },
        }),
      ),
    /application release must be a published normal release/iu,
  );
});

test("publisher reuses only an exact immutable release asset", () => {
  const fixture = publicationFixture();
  const mirror = fixture.mirrorCandidate;
  fixture.release.assets = [
    {
      name: mirror.name,
      size: mirror.size,
      digest: `sha256:${mirror.sha256}`,
      browser_download_url: `https://github.com/Chlience/yt-dlp-tauri/releases/download/toolchain-stable/${mirror.name}`,
    },
  ];
  assert.equal(createPublicationPlan(fixture).steps[0].action, "reuse");

  fixture.release.assets[0].digest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => createPublicationPlan(fixture), /digest does not match/u);
});

test("publisher rejects a report from another commit", () => {
  assert.throws(
    () => createPublicationPlan(publicationFixture({ reportCommitSha: "d".repeat(40) })),
    /validation commit does not match/u,
  );
});

test("publisher requires a newer revision and associated merged PR", () => {
  assert.throws(
    () =>
      createPublicationPlan(
        publicationFixture({
          currentChannel: {
            schemaVersion: 1,
            revision: "20260712.1",
            manifest: "tools-manifest-20260712.1.json",
            sha256: "9".repeat(64),
          },
        }),
      ),
    /newer than the promoted revision/u,
  );
  assert.throws(
    () =>
      createPublicationPlan(
        publicationFixture({
          mergedPullRequest: { number: 42, merged: false, mergeCommitSha: "a".repeat(40) },
        }),
      ),
    /merged pull request/u,
  );
});

test("uploaded asset verification requires exact name, size, and digest", () => {
  const expected = {
    name: "tools-manifest-20260711.1.json",
    size: 100,
    sha256: "a".repeat(64),
  };
  assert.doesNotThrow(() =>
    verifyUploadedAsset(
      {
        name: expected.name,
        size: expected.size,
        digest: `sha256:${expected.sha256}`,
        browser_download_url: "https://github.com/example/repo/releases/download/tag/file",
      },
      expected,
    ),
  );
  assert.throws(
    () =>
      verifyUploadedAsset(
        {
          name: expected.name,
          size: expected.size,
          digest: `sha256:${"b".repeat(64)}`,
          browser_download_url: "https://github.com/example/repo/releases/download/tag/file",
        },
        expected,
      ),
    /digest does not match/u,
  );
});

test("rollback changes only the channel after verifying historical assets", () => {
  const plan = createRollbackPlan(rollbackFixture());

  assert.deepEqual(
    plan.steps.map((step) => step.kind),
    [
      "verify-historical-manifest",
      "verify-historical-assets",
      "promote-channel",
      "record-rollback",
    ],
  );
  assert.equal(plan.steps[2].channel.revision, "20260710.1");
  assert.equal(plan.steps[3].releaseTag, "v0.1.11");
});

test("rollback rejects the current revision and requires a reason", () => {
  assert.throws(
    () => createRollbackPlan(rollbackFixture({ rollbackRevision: "20260711.2" })),
    /already promoted/u,
  );
  assert.throws(
    () => createRollbackPlan(rollbackFixture({ reason: "  " })),
    /reason/u,
  );
});

test("rollback verifies historical mirror and provenance digests", () => {
  const fixture = rollbackFixture();
  fixture.historicalAssets[0].sha256 = "0".repeat(64);
  assert.throws(() => createRollbackPlan(fixture), /historical source asset/iu);

  const invalidProvenance = rollbackFixture();
  invalidProvenance.historicalProvenance.value.binary.sha256 = "0".repeat(64);
  assert.throws(() => createRollbackPlan(invalidProvenance), /provenance/u);
});

test("rollback requires revalidation or protected environment approval", () => {
  assert.throws(
    () => createRollbackPlan(rollbackFixture({ revalidation: undefined })),
    /revalidation/u,
  );
  assert.throws(
    () =>
      createRollbackPlan(
        rollbackFixture({
          skipRevalidation: true,
          revalidation: undefined,
          approval: { approved: true, environment: "another-environment" },
        }),
      ),
    /protected rollback environment/u,
  );
  assert.doesNotThrow(() =>
    createRollbackPlan(
      rollbackFixture({
        skipRevalidation: true,
        revalidation: undefined,
        approval: { approved: true, environment: "toolchain-rollback" },
      }),
    ),
  );
});
