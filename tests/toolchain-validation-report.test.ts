import assert from "node:assert/strict";
import test from "node:test";

import {
  createTargetReport,
  mergeTargetReports,
  validatePublicationReport,
} from "../scripts/toolchain/validation-report.mjs";

const DIGESTS = {
  manifest: "b".repeat(64),
  lock: "c".repeat(64),
};

function targetReport(target: string, overrides = {}) {
  const architecture = target === "macos-arm64" ? "arm64" : "x64";
  const tools = ["yt-dlp", "ffprobe", "deno", "ffmpeg"].map((name, index) => ({
    name,
    version: `1.${index}`,
  }));
  return createTargetReport({
    target,
    success: true,
    runnerImage: target === "win-x64" ? "windows-latest" : "macos-15",
    architecture,
    checks: {
      supplyChain: true,
      executables: true,
      dash: true,
      projectTests: true,
    },
    tools,
    assets: tools.map((tool, index) => ({
      sourceId: tool.name,
      releaseId: index + 100,
      assetId: index + 200,
      assetName: `${tool.name}.zip`,
      sourceUrl: `https://example.test/${tool.name}.zip`,
      size: 1024 + index,
      officialSha256: String(index + 1).repeat(64),
    })),
    extractedHashes: tools.map((tool, index) => ({
      tool: tool.name,
      path: `Tools/${target}/${tool.name}`,
      sha256: String(index + 5).repeat(64),
    })),
    ...overrides,
  });
}

function targetReports() {
  return ["win-x64", "macos-x64", "macos-arm64"].map((target) =>
    targetReport(target),
  );
}

function reportContext() {
  return {
    revision: "20260711.1",
    commitSha: "a".repeat(40),
    manifestSha256: DIGESTS.manifest,
    lockSha256: DIGESTS.lock,
    runId: "1234",
    runUrl: "https://github.com/Chlience/yt-dlp-tauri/actions/runs/1234",
  };
}

function candidateIdentity() {
  return {
    artifactName: "toolchain-candidate-20260711.1",
    artifactId: "9876",
    artifactDigest: "d".repeat(64),
    repositoryId: "42",
    pullRequestNumber: 77,
    headSha: "e".repeat(40),
  };
}

test("publication report requires all native targets and exact hashes", () => {
  const report = mergeTargetReports(targetReports(), reportContext());

  assert.deepEqual(
    report.targets.map((target) => target.target),
    ["macos-arm64", "macos-x64", "win-x64"],
  );
  assert.doesNotThrow(() =>
    validatePublicationReport(report, {
      revision: "20260711.1",
      commitSha: "a".repeat(40),
      manifestSha256: DIGESTS.manifest,
      lockSha256: DIGESTS.lock,
    }),
  );
});

test("validation report binds the pull request candidate artifact", () => {
  const context = { ...reportContext(), candidate: candidateIdentity() };
  const report = mergeTargetReports(targetReports(), context);

  assert.deepEqual(report.candidate, candidateIdentity());
  assert.doesNotThrow(() => validatePublicationReport(report, context));
  assert.throws(
    () =>
      mergeTargetReports(targetReports(), {
        ...reportContext(),
        candidate: { ...candidateIdentity(), artifactDigest: "SHA256:invalid" },
      }),
    /artifact digest/u,
  );
});

test("target report sorts tools, assets, and extracted hashes", () => {
  const report = targetReport("win-x64");

  assert.deepEqual(
    report.tools.map((tool) => tool.name),
    ["deno", "ffmpeg", "ffprobe", "yt-dlp"],
  );
  assert.deepEqual(
    report.assets.map((asset) => asset.sourceId),
    ["deno", "ffmpeg", "ffprobe", "yt-dlp"],
  );
  assert.deepEqual(
    report.extractedHashes.map((hash) => hash.tool),
    ["deno", "ffmpeg", "ffprobe", "yt-dlp"],
  );
});

test("publication rejects a failed target check", () => {
  const failed = targetReport("win-x64", {
    success: false,
    checks: {
      supplyChain: true,
      executables: true,
      dash: false,
      projectTests: true,
    },
  });
  const report = mergeTargetReports(
    [targetReport("macos-arm64"), targetReport("macos-x64"), failed],
    reportContext(),
  );

  assert.throws(() => validatePublicationReport(report, reportContext()), /win-x64.*failed/u);
});

test("Canary status is optional and cannot become blocking", () => {
  assert.doesNotThrow(() =>
    mergeTargetReports(targetReports(), {
      ...reportContext(),
      canary: { status: "passing", blocking: false },
    }),
  );
  assert.throws(
    () =>
      mergeTargetReports(targetReports(), {
        ...reportContext(),
        canary: { status: "failing", blocking: true },
      }),
    /Canary.*non-blocking/u,
  );
});

test("a failing target Canary remains non-blocking for publication", () => {
  const windows = targetReport("win-x64", {
    canary: { status: "failing", blocking: false },
  });
  const report = mergeTargetReports(
    [targetReport("macos-arm64"), targetReport("macos-x64"), windows],
    reportContext(),
  );

  assert.equal(report.targets[2].canary.status, "failing");
  assert.doesNotThrow(() => validatePublicationReport(report, reportContext()));
  assert.throws(
    () =>
      targetReport("win-x64", {
        canary: { status: "failing", blocking: true },
      }),
    /Canary.*non-blocking/u,
  );
});

test("publication rejects a mismatched manifest digest", () => {
  const report = mergeTargetReports(targetReports(), reportContext());
  assert.throws(
    () =>
      validatePublicationReport(report, {
        ...reportContext(),
        manifestSha256: "d".repeat(64),
      }),
    /manifest SHA-256/u,
  );
});

test("redirect assets use explicit null release and asset IDs", () => {
  const base = targetReport("macos-arm64");
  const redirectedAssets = base.assets.map((asset, index) =>
    index === 0 ? { ...asset, releaseId: null, assetId: null } : asset,
  );
  const report = createTargetReport({
    target: base.target,
    success: base.success,
    runnerImage: base.runner.image,
    architecture: base.runner.architecture,
    checks: base.checks,
    tools: base.tools,
    assets: redirectedAssets,
    extractedHashes: base.extractedHashes,
  });
  assert.equal(report.assets[0].releaseId, null);
  assert.equal(report.assets[0].assetId, null);

  const missingId = redirectedAssets.map((asset, index) => {
    if (index !== 0) return asset;
    const copy = { ...asset };
    delete copy.assetId;
    return copy;
  });
  assert.throws(
    () =>
      createTargetReport({
        target: base.target,
        success: base.success,
        runnerImage: base.runner.image,
        architecture: base.runner.architecture,
        checks: base.checks,
        tools: base.tools,
        assets: missingId,
        extractedHashes: base.extractedHashes,
      }),
    /declare releaseId and assetId/u,
  );
});
