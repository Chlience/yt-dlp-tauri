import assert from "node:assert/strict";
import test from "node:test";

import {
  createArchivePublicationPlan,
  createArchiveRollbackPlan,
} from "../scripts/toolchain/publication-plan.mjs";
import { renderChannelRecord } from "../scripts/toolchain/channel.mjs";
import {
  createTargetReport,
  mergeTargetReports,
} from "../scripts/toolchain/validation-report.mjs";

const archiveRepository = "Chlience/yt-dlp-tauri-toolchain";
const sourceRepository = "Chlience/yt-dlp-tauri";
const revision = "20260712.1";
const historicalRevision = "20260711.1";
const commitSha = "a".repeat(40);
const headSha = "b".repeat(40);
const lockSha256 = "c".repeat(64);
const manifestSha256 = "d".repeat(64);
const validationSha256 = "e".repeat(64);
const historicalByteSha256 = "1".repeat(64);
const proposedByteSha256 = "2".repeat(64);

function targetReport(target: string) {
  const tools = ["deno", "ffmpeg", "ffprobe", "yt-dlp"];
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
    tools: tools.map((name) => ({ name, version: "1.0.0" })),
    assets: tools.map((name, index) => ({
      sourceId: name,
      releaseId: index + 1,
      assetId: index + 10,
      assetName: `${name}.zip`,
      sourceUrl: `https://example.test/${target}/${name}.zip`,
      size: 100 + index,
      officialSha256: String(index + 3).repeat(64),
    })),
    extractedHashes: tools.map((name, index) => ({
      tool: name,
      path: `Tools/${target}/${name}`,
      sha256: String(index + 6).repeat(64),
    })),
  });
}

function validationReport({
  reportRevision = revision,
  reportCommitSha = commitSha,
  reportManifestSha256 = manifestSha256,
  reportLockSha256 = lockSha256,
  candidate = true,
} = {}) {
  const context = {
    revision: reportRevision,
    commitSha: reportCommitSha,
    manifestSha256: reportManifestSha256,
    lockSha256: reportLockSha256,
    runId: "9002",
    runUrl: `https://github.com/${sourceRepository}/actions/runs/9002`,
  };
  if (candidate) {
    Object.assign(context, {
      candidate: {
        artifactName: `toolchain-candidate-${revision}`,
        artifactId: "7001",
        artifactDigest: "f".repeat(64),
        repositoryId: "1250277749",
        pullRequestNumber: 3,
        headSha,
      },
    });
  }
  return mergeTargetReports(
    [targetReport("win-x64")],
    context,
  );
}

function descriptor(releaseTag: string, assetName: string, size: number, sha256: string) {
  return {
    repository: archiveRepository,
    releaseTag,
    assetName,
    size,
    sha256,
  };
}

function releaseAsset(tag: string, name: string, size: number, sha256: string, id = 501) {
  return {
    id,
    name,
    size,
    digest: `sha256:${sha256}`,
    browser_download_url: `https://github.com/${archiveRepository}/releases/download/${tag}/${name}`,
  };
}

function archiveRelease(tag: string, assets: unknown[], overrides = {}) {
  return {
    repository: archiveRepository,
    id: 401,
    tag_name: tag,
    draft: false,
    prerelease: true,
    immutable: true,
    assets,
    ...overrides,
  };
}

function metadata(category: string, name: string, sha256: string, extra = {}) {
  return {
    category,
    name,
    path: `.toolchain/publication/${name}`,
    size: 1000 + name.length,
    sha256,
    ...extra,
  };
}

function publicationFixture(overrides = {}) {
  const historical = descriptor(
    `toolchain-${historicalRevision}`,
    `deno-${historicalRevision}-${historicalByteSha256.slice(0, 16)}.zip`,
    100,
    historicalByteSha256,
  );
  const proposed = descriptor(
    `toolchain-${revision}`,
    `yt-dlp-${revision}-${proposedByteSha256.slice(0, 16)}.exe`,
    200,
    proposedByteSha256,
  );
  const lock = {
    schemaVersion: 2,
    revision,
    sources: [
      {
        id: "deno",
        assets: [
          {
            target: "win-x64",
            size: historical.size,
            sha256: historical.sha256,
            archive: historical,
          },
        ],
      },
      {
        id: "yt-dlp",
        assets: [
          {
            target: "win-x64",
            size: proposed.size,
            sha256: proposed.sha256,
            archive: proposed,
          },
        ],
      },
    ],
  };
  const manifest = {
    schemaVersion: 4,
    revision,
    targets: [],
  };
  const handoff = {
    schemaVersion: 1,
    repository: sourceRepository,
    repositoryId: "1250277749",
    mergeCommitSha: commitSha,
    revision,
    lockSha256,
    pullRequestNumber: 3,
    headSha,
    headRepositoryId: "1250277749",
    workflowId: "311325680",
    workflowPath: ".github/workflows/toolchain-validate.yml",
    runId: "9001",
    runAttempt: 1,
    runUrl: `https://github.com/${sourceRepository}/actions/runs/9001`,
    candidateArtifact: {
      id: "7001",
      name: `toolchain-candidate-${revision}`,
      size: 300,
      digest: "f".repeat(64),
      archiveDownloadUrl: `https://api.github.com/repos/${sourceRepository}/actions/artifacts/7001/zip`,
    },
    validationArtifact: {
      id: "7002",
      name: "toolchain-validation-report",
      size: 400,
      digest: "0".repeat(64),
      archiveDownloadUrl: `https://api.github.com/repos/${sourceRepository}/actions/artifacts/7002/zip`,
    },
  };
  const validation = validationReport();
  const metadataAssets = [
    metadata("manifest", `tools-manifest-${revision}.json`, manifestSha256, {
      value: manifest,
    }),
    metadata("validation", `toolchain-validation-${revision}.json`, validationSha256, {
      report: validation,
    }),
    metadata("compliance", `toolchain-compliance-${revision}.json`, "3".repeat(64), {
      value: {
        schemaVersion: 1,
        revision,
        passed: true,
        sources: ["deno", "yt-dlp"].map((id) => ({
          id,
          passed: true,
          evidence: [{ id: "binary-release", satisfied: true }],
        })),
      },
    }),
    metadata("provenance", `toolchain-provenance-${revision}.json`, "4".repeat(64), {
      value: { schemaVersion: 1, revision },
    }),
    metadata("checksums", `toolchain-checksums-${revision}.txt`, "5".repeat(64)),
  ];
  const currentChannel = {
    schemaVersion: 2,
    repository: archiveRepository,
    revision: "20260710.1",
    releaseTag: "toolchain-20260710.1",
    manifest: "tools-manifest-20260710.1.json",
    sha256: "9".repeat(64),
  };
  return {
    mode: "publish",
    sourceRepository,
    archiveRepository,
    revision,
    commitSha,
    handoff,
    lock: { sha256: lockSha256, value: lock },
    candidateFiles: [
      {
        path: `assets/${proposedByteSha256}`,
        size: proposed.size,
        sha256: proposed.sha256,
      },
    ],
    historicalReleases: [
      archiveRelease(historical.releaseTag, [
        releaseAsset(
          historical.releaseTag,
          historical.assetName,
          historical.size,
          historical.sha256,
        ),
      ]),
    ],
    revisionRelease: null,
    stableRelease: {
      repository: archiveRepository,
      id: 402,
      tag_name: "toolchain-stable",
      draft: false,
      prerelease: true,
      immutable: true,
      body: renderChannelRecord("# Stable toolchain\n", currentChannel),
    },
    applicationRelease: {
      repository: sourceRepository,
      id: 403,
      tag_name: "v0.1.11",
      draft: false,
      prerelease: false,
    },
    metadata: metadataAssets,
    changedSources: ["yt-dlp"],
    ...overrides,
  };
}

test("publication reuses historical descriptors and uploads proposed descriptors", () => {
  const plan = createArchivePublicationPlan(publicationFixture());

  assert.deepEqual(
    plan.operations.map((operation) => operation.kind),
    [
      "reuse",
      "upload",
      "metadata",
      "metadata",
      "metadata",
      "metadata",
      "metadata",
      "publish-release",
      "promote-channel",
      "legacy-manifest",
    ],
  );
  assert.equal(plan.operations[1].path, `assets/${proposedByteSha256}`);
  assert.deepEqual(plan.operations.at(-2)?.channel, {
    schemaVersion: 2,
    repository: archiveRepository,
    revision,
    releaseTag: `toolchain-${revision}`,
    manifest: `tools-manifest-${revision}.json`,
    sha256: manifestSha256,
  });
  assert.equal(plan.operations.at(-1)?.applicationReleaseTag, "v0.1.11");
});

test("publication supports a metadata-only revision with historical tool bytes", () => {
  const fixture = publicationFixture();
  const reused = descriptor(
    `toolchain-${historicalRevision}`,
    `yt-dlp-${historicalRevision}-${proposedByteSha256.slice(0, 16)}.exe`,
    200,
    proposedByteSha256,
  );
  fixture.lock.value.sources[1].assets[0].archive = reused;
  fixture.candidateFiles = [];
  fixture.historicalReleases[0].assets.push(
    releaseAsset(
      reused.releaseTag,
      reused.assetName,
      reused.size,
      reused.sha256,
      502,
    ),
  );
  fixture.changedSources = [];

  const plan = createArchivePublicationPlan(fixture);
  const release = plan.operations.find(
    (operation) => operation.kind === "publish-release",
  );

  assert.equal(plan.operations.filter((operation) => operation.kind === "reuse").length, 2);
  assert.equal(plan.operations.some((operation) => operation.kind === "upload"), false);
  assert.equal(release.requiredDraftAssets.length, fixture.metadata.length);
  assert.equal(plan.draftRelease.body.includes("Changed sources: none"), true);
});

test("publication resumes only an exact mutable revision draft", () => {
  const initialPlan = createArchivePublicationPlan(publicationFixture());
  const revisionDraft = {
    repository: archiveRepository,
    id: 404,
    tag_name: `toolchain-${revision}`,
    name: initialPlan.draftRelease.name,
    body: initialPlan.draftRelease.body,
    draft: true,
    prerelease: false,
    immutable: false,
    assets: [],
  };
  const resumed = createArchivePublicationPlan(
    publicationFixture({ revisionRelease: revisionDraft }),
  );

  assert.equal(resumed.draftRelease.existingId, "404");
  assert.equal(resumed.revisionState, "draft");

  assert.throws(
    () =>
      createArchivePublicationPlan(
        publicationFixture({
          revisionRelease: { ...revisionDraft, body: `${revisionDraft.body}\nstale` },
        }),
      ),
    /release.*does not match/iu,
  );
  assert.throws(
    () =>
      createArchivePublicationPlan(
        publicationFixture({
          revisionRelease: { ...revisionDraft, draft: false, immutable: false },
        }),
      ),
    /resumable draft/iu,
  );
});

test("publication resumes after an exact immutable revision was published", () => {
  const initialPlan = createArchivePublicationPlan(publicationFixture());
  const expected = initialPlan.operations.find(
    (operation) => operation.kind === "publish-release",
  ).requiredDraftAssets;
  const revisionRelease = {
    repository: archiveRepository,
    id: 405,
    tag_name: `toolchain-${revision}`,
    name: initialPlan.draftRelease.name,
    body: initialPlan.draftRelease.body,
    draft: false,
    prerelease: false,
    immutable: true,
    assets: expected.map((asset, index) =>
      releaseAsset(
        `toolchain-${revision}`,
        asset.name,
        asset.size,
        asset.sha256,
        700 + index,
      ),
    ),
  };
  const resumed = createArchivePublicationPlan(
    publicationFixture({ revisionRelease }),
  );

  assert.equal(resumed.revisionState, "published");
  assert.equal(resumed.draftRelease.existingId, null);

  revisionRelease.assets[0].digest = `sha256:${"9".repeat(64)}`;
  assert.throws(
    () => createArchivePublicationPlan(publicationFixture({ revisionRelease })),
    /revision.*asset.*digest/iu,
  );
});

test("publication requires one exact candidate byte object", () => {
  assert.throws(
    () => createArchivePublicationPlan(publicationFixture({ candidateFiles: [] })),
    /candidate byte object/u,
  );
  const fixture = publicationFixture();
  fixture.candidateFiles.push({ ...fixture.candidateFiles[0] });
  assert.throws(() => createArchivePublicationPlan(fixture), /candidate byte object/u);
});

test("publication reuses only exact immutable historical assets", () => {
  const fixture = publicationFixture();
  fixture.historicalReleases[0].immutable = false;
  assert.throws(() => createArchivePublicationPlan(fixture), /immutable historical release/u);

  const wrongDigest = publicationFixture();
  wrongDigest.historicalReleases[0].assets[0].digest = `sha256:${"8".repeat(64)}`;
  assert.throws(() => createArchivePublicationPlan(wrongDigest), /digest/u);

  const normalRelease = publicationFixture();
  normalRelease.historicalReleases[0].prerelease = false;
  assert.doesNotThrow(() => createArchivePublicationPlan(normalRelease));
});

test("publication validates main report, metadata completeness, and channel order", () => {
  const wrongReport = publicationFixture();
  wrongReport.metadata.find((item) => item.category === "validation").report.commitSha =
    "7".repeat(40);
  assert.throws(() => createArchivePublicationPlan(wrongReport), /validation.*commit/iu);

  const incomplete = publicationFixture();
  incomplete.metadata = incomplete.metadata.filter((item) => item.category !== "compliance");
  assert.throws(() => createArchivePublicationPlan(incomplete), /metadata categories/u);

  const stale = publicationFixture();
  stale.stableRelease.body = renderChannelRecord("", {
    schemaVersion: 2,
    repository: archiveRepository,
    revision: "20260713.1",
    releaseTag: "toolchain-20260713.1",
    manifest: "tools-manifest-20260713.1.json",
    sha256: "6".repeat(64),
  });
  assert.throws(() => createArchivePublicationPlan(stale), /newer than the promoted revision/u);
});

function rollbackFixture(overrides = {}) {
  const manifestName = `tools-manifest-${historicalRevision}.json`;
  const validationName = `toolchain-validation-${historicalRevision}.json`;
  const manifestDigest = "6".repeat(64);
  const validationDigest = "7".repeat(64);
  const historicalDescriptor = descriptor(
    `toolchain-${historicalRevision}`,
    `deno-${historicalRevision}-${historicalByteSha256.slice(0, 16)}.zip`,
    100,
    historicalByteSha256,
  );
  const historicalManifest = {
    schemaVersion: 4,
    revision: historicalRevision,
    targets: [
      {
        target: "win-x64",
        tools: [
          {
            name: "deno",
            sourceUrl: `https://github.com/${archiveRepository}/releases/download/${historicalDescriptor.releaseTag}/${historicalDescriptor.assetName}`,
            sourceSize: historicalDescriptor.size,
            sourceSha256: historicalDescriptor.sha256,
          },
        ],
      },
    ],
  };
  const historicalValidation = validationReport({
    reportRevision: historicalRevision,
    reportCommitSha: "8".repeat(40),
    reportManifestSha256: manifestDigest,
    reportLockSha256: "9".repeat(64),
    candidate: false,
  });
  const revalidation = validationReport({
    reportRevision: historicalRevision,
    reportCommitSha: commitSha,
    reportManifestSha256: manifestDigest,
    reportLockSha256: "9".repeat(64),
    candidate: false,
  });
  const release = archiveRelease(historicalDescriptor.releaseTag, [
    releaseAsset(
      historicalDescriptor.releaseTag,
      historicalDescriptor.assetName,
      historicalDescriptor.size,
      historicalDescriptor.sha256,
      601,
    ),
    releaseAsset(historicalDescriptor.releaseTag, manifestName, 2000, manifestDigest, 602),
    releaseAsset(
      historicalDescriptor.releaseTag,
      validationName,
      3000,
      validationDigest,
      603,
    ),
  ]);
  const currentChannel = {
    schemaVersion: 2,
    repository: archiveRepository,
    revision,
    releaseTag: `toolchain-${revision}`,
    manifest: `tools-manifest-${revision}.json`,
    sha256: manifestSha256,
  };
  return {
    mode: "rollback",
    sourceRepository,
    archiveRepository,
    rollbackRevision: historicalRevision,
    currentCommitSha: commitSha,
    reason: "Restore the previous validated toolchain",
    actor: "maintainer",
    dryRun: false,
    skipRevalidation: false,
    stableRelease: {
      repository: archiveRepository,
      id: 402,
      tag_name: "toolchain-stable",
      draft: false,
      prerelease: true,
      immutable: true,
      body: renderChannelRecord("# Stable toolchain\n", currentChannel),
    },
    applicationRelease: {
      repository: sourceRepository,
      id: 403,
      tag_name: "v0.1.11",
      draft: false,
      prerelease: false,
    },
    revisionRelease: release,
    historicalReleases: [release],
    manifest: {
      name: manifestName,
      size: 2000,
      sha256: manifestDigest,
      value: historicalManifest,
    },
    validation: {
      name: validationName,
      size: 3000,
      sha256: validationDigest,
      report: historicalValidation,
    },
    revalidation: { report: revalidation },
    ...overrides,
  };
}

test("rollback verifies history and emits only channel and compatibility operations", () => {
  const plan = createArchiveRollbackPlan(rollbackFixture());
  assert.deepEqual(
    plan.operations.map((operation) => operation.kind),
    ["promote-channel", "legacy-manifest"],
  );
  assert.equal(plan.operations[0].channel.revision, historicalRevision);
  assert.equal(plan.operations[1].manifestSource.name, `tools-manifest-${historicalRevision}.json`);
});

test("rollback rejects mutable history and requires revalidation or protected approval", () => {
  const mutable = rollbackFixture();
  mutable.revisionRelease.immutable = false;
  assert.throws(() => createArchiveRollbackPlan(mutable), /immutable revision release/u);

  assert.throws(
    () => createArchiveRollbackPlan(rollbackFixture({ revalidation: undefined })),
    /revalidation/u,
  );
  assert.doesNotThrow(() =>
    createArchiveRollbackPlan(
      rollbackFixture({
        skipRevalidation: true,
        revalidation: undefined,
        approval: { approved: true, environment: "toolchain-rollback" },
      }),
    ),
  );
});
