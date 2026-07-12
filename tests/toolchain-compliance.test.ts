import assert from "node:assert/strict";
import test from "node:test";

import { createComplianceReport } from "../scripts/toolchain/compliance-report.mjs";
import { buildPublicationMetadata } from "../scripts/prepare-toolchain-publication.mjs";

const sha256 = "a".repeat(64);

function fixture() {
  return {
    policy: {
      sources: [
        {
          id: "ffmpeg",
          redistribution: {
            requiredEvidence: [
              "official-checksum",
              "binary-release",
              "source-revision",
              "build-revision",
              "source-license",
              "third-party-notices",
            ],
            licenseFiles: ["LICENSE"],
            noticeFiles: ["THIRD-PARTY-NOTICES.md"],
          },
        },
      ],
    },
    lock: {
      revision: "20260712.1",
      sources: [
        {
          id: "ffmpeg",
          version: "1.0.0",
          assets: [
            {
              sourceUrl: "https://example.test/ffmpeg.zip",
              checksumUrl: "https://example.test/ffmpeg.zip.sha256",
              size: 100,
              sha256,
            },
          ],
          redistribution: {
            provenance: {
              sourceRevision: "b".repeat(40),
              buildRepositoryRevision: "c".repeat(40),
            },
          },
        },
      ],
    },
    files: {
      LICENSE: { size: 100, sha256: "d".repeat(64) },
      "THIRD-PARTY-NOTICES.md": { size: 200, sha256: "e".repeat(64) },
    },
  };
}

test("compliance records every required evidence item", () => {
  const input = fixture();
  const report = createComplianceReport(input);

  assert.equal(report.passed, true);
  assert.deepEqual(
    report.sources[0].evidence.map((item) => [item.id, item.satisfied]),
    [
      ["binary-release", true],
      ["build-revision", true],
      ["official-checksum", true],
      ["source-license", true],
      ["source-revision", true],
      ["third-party-notices", true],
    ],
  );
});

test("compliance fails closed when revision or file evidence is absent", () => {
  const missingRevision = fixture();
  delete missingRevision.lock.sources[0].redistribution.provenance.sourceRevision;
  assert.equal(createComplianceReport(missingRevision).passed, false);

  const missingLicense = fixture();
  delete missingLicense.files.LICENSE;
  const report = createComplianceReport(missingLicense);
  assert.equal(report.passed, false);
  assert.equal(
    report.sources[0].evidence.find((item) => item.id === "source-license").satisfied,
    false,
  );
});

test("compliance requires policy and lock to contain the same source IDs", () => {
  const input = fixture();
  input.lock.sources.push({ id: "unexpected", assets: [] });
  assert.throws(() => createComplianceReport(input), /source IDs/u);
});

test("publication metadata includes reviewed evidence and deterministic checksums", () => {
  const input = fixture();
  input.lock.sources[0].assets[0].archive = {
    repository: "Chlience/yt-dlp-tauri-toolchain",
    releaseTag: "toolchain-20260712.1",
    assetName: "ffmpeg-1.0.0-aaaaaaaaaaaaaaaa.zip",
    size: 100,
    sha256,
  };
  const compliance = createComplianceReport(input);
  const generated = buildPublicationMetadata({
    policy: input.policy,
    lock: input.lock,
    manifestBytes: Buffer.from('{"revision":"20260712.1"}\n'),
    validationBytes: Buffer.from('{"schemaVersion":1}\n'),
    compliance,
    handoff: {
      mergeCommitSha: "f".repeat(40),
      pullRequestNumber: 3,
      headSha: "1".repeat(40),
      runId: "99",
      lockSha256: "2".repeat(64),
    },
    evidenceFiles: new Map([
      ["LICENSE", Buffer.from("license")],
      ["THIRD-PARTY-NOTICES.md", Buffer.from("notices")],
    ]),
    outputDirectory: ".toolchain/publication",
  });

  assert.deepEqual(
    generated.metadata.map((item) => item.category),
    ["manifest", "validation", "compliance", "provenance", "license", "notice", "checksums"],
  );
  assert.match(
    generated.files.get("toolchain-checksums-20260712.1.txt").toString("utf8"),
    /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ffmpeg-1\.0\.0-aaaaaaaaaaaaaaaa\.zip/u,
  );
});
