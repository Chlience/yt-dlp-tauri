import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveFfmpegProvenance,
  verifyFfmpegProvenance,
} from "./ffmpeg-provenance.mjs";
import {
  assignArchiveDescriptors,
  hasCompleteArchiveDescriptors,
} from "./archive-contract.mjs";
import { fetchGitHubReleases } from "./github-releases.mjs";
import { inspectAsset as inspectAssetDefault } from "./inspect-asset.mjs";
import { validateToolchainPolicy } from "./policy.mjs";
import {
  selectLatestStable,
  selectPreviousCompleteMonth,
} from "./select-release.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^([0-9]{8})\.([1-9][0-9]*)$/;

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function validDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
  return value;
}

function utcDateKey(now) {
  return validDate(now, "Toolchain revision date")
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
}

function isCalendarDate(dateKey) {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(4, 6));
  const day = Number(dateKey.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function nextRevision(current, now = new Date()) {
  const dateKey = utcDateKey(now);
  if (current === undefined || current === null || current === "") {
    return `${dateKey}.1`;
  }
  if (typeof current !== "string") {
    throw new Error("Current toolchain revision must be a string");
  }
  const match = current.match(REVISION_PATTERN);
  if (!match || !isCalendarDate(match[1])) {
    throw new Error(`Invalid current toolchain revision: ${current}`);
  }
  if (match[1] > dateKey) {
    throw new Error(`Current toolchain revision ${current} is later than ${dateKey}`);
  }
  if (match[1] < dateKey) return `${dateKey}.1`;

  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Current toolchain revision sequence is too large: ${current}`);
  }
  return `${dateKey}.${sequence + 1}`;
}

function approvedUrl(value, approvedHosts, label) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  if (!approvedHosts.has(url.hostname)) {
    throw new Error(`${label} uses unapproved host ${url.hostname}`);
  }
  return url;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function selectGitHubAsset(release, assetPolicy, sourceId) {
  if (!Array.isArray(release.assets)) {
    throw new Error(`Release ${release.tagName} for ${sourceId} has no assets array`);
  }
  const matches = release.assets.filter((asset) => {
    if (assetPolicy.assetName) return asset.name === assetPolicy.assetName;
    return new RegExp(assetPolicy.assetPattern).test(asset.name);
  });
  const selector = assetPolicy.assetName ?? assetPolicy.assetPattern;
  if (matches.length === 0) {
    throw new Error(`Release ${release.tagName} for ${sourceId} has no asset matching ${selector}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Release ${release.tagName} for ${sourceId} has multiple assets matching ${selector}`,
    );
  }
  return matches[0];
}

function selectRelease(source, releases, now) {
  if (source.selection === "latest-stable") return selectLatestStable(releases);
  if (source.selection === "previous-complete-month") {
    return selectPreviousCompleteMonth(releases, now);
  }
  throw new Error(`Unsupported GitHub release selection for ${source.id}: ${source.selection}`);
}

function mergeMembers(sourceId, assetPolicy, inspected) {
  if (!Array.isArray(inspected.members)) {
    throw new Error(`Inspected asset for ${sourceId} has no members array`);
  }
  const inspectedByTool = new Map();
  for (const member of inspected.members) {
    if (inspectedByTool.has(member.tool)) {
      throw new Error(`Inspected asset for ${sourceId} contains duplicate tool ${member.tool}`);
    }
    inspectedByTool.set(member.tool, member);
  }
  if (inspectedByTool.size !== assetPolicy.members.length) {
    throw new Error(`Inspected asset for ${sourceId} returned an unexpected member count`);
  }

  return assetPolicy.members
    .map((memberPolicy) => {
      const member = inspectedByTool.get(memberPolicy.tool);
      if (!member) {
        throw new Error(`Inspected asset for ${sourceId} is missing ${memberPolicy.tool}`);
      }
      const result = {
        tool: memberPolicy.tool,
        path: memberPolicy.path,
        size: requireSize(member.size, `${sourceId} ${memberPolicy.tool} size`),
        sha256: requireSha256(
          member.sha256,
          `${sourceId} ${memberPolicy.tool} executable digest`,
        ),
        licenseNotes: memberPolicy.licenseNotes,
      };
      if (assetPolicy.kind === "zip") {
        if (typeof member.archivePath !== "string" || member.archivePath === "") {
          throw new Error(`Inspected ZIP asset for ${sourceId} is missing ${memberPolicy.tool}`);
        }
        result.archivePathSuffix = memberPolicy.archivePathSuffix;
        result.archivePath = member.archivePath;
      }
      return result;
    })
    .sort((left, right) =>
      compareStrings(left.tool, right.tool) || compareStrings(left.path, right.path),
    );
}

function assetComparator(left, right) {
  return (
    compareStrings(left.target, right.target) ||
    compareStrings(left.assetName, right.assetName) ||
    compareStrings(left.sourceUrl, right.sourceUrl)
  );
}

function inspectionKey(url, assetPolicy) {
  return JSON.stringify({
    url,
    kind: assetPolicy.kind,
    members: assetPolicy.members
      .map((member) => ({
        tool: member.tool,
        archivePathSuffix: member.archivePathSuffix ?? null,
      }))
      .sort((left, right) => compareStrings(left.tool, right.tool)),
  });
}

function createInspector(inspectAsset, tempDirectory, approvedHosts) {
  const cache = new Map();
  return async function inspect(url, assetPolicy, expected) {
    const key = inspectionKey(url, assetPolicy);
    if (!cache.has(key)) {
      cache.set(
        key,
        Promise.resolve(
          inspectAsset({
            url,
            kind: assetPolicy.kind,
            tempDirectory,
            members: assetPolicy.members,
            expectedSha256: expected.sha256 ?? undefined,
            expectedSize: expected.size ?? undefined,
            approvedHosts: [...approvedHosts],
          }),
        ),
      );
    }
    return cache.get(key);
  };
}

async function resolveGitHubSource({
  source,
  now,
  approvedHosts,
  githubAdapter,
  githubToken,
  inspect,
}) {
  const releases = await githubAdapter(source.repository, { token: githubToken });
  const release = selectRelease(source, releases, now);
  const assets = [];

  for (const assetPolicy of source.assets) {
    const releaseAsset = selectGitHubAsset(release, assetPolicy, source.id);
    const sourceUrl = approvedUrl(
      releaseAsset.url,
      approvedHosts,
      `${source.id} asset URL`,
    ).toString();
    if (source.selection === "latest-stable" && !releaseAsset.sha256) {
      throw new Error(`${source.id} asset ${releaseAsset.name} is missing its upstream SHA-256`);
    }
    if (releaseAsset.sha256) {
      requireSha256(releaseAsset.sha256, `${source.id} upstream asset digest`);
    }
    requireSize(releaseAsset.size, `${source.id} upstream asset size`);

    const inspected = await inspect(sourceUrl, assetPolicy, {
      sha256: releaseAsset.sha256,
      size: releaseAsset.size,
    });
    requireSize(inspected.size, `${source.id} downloaded asset size`);
    const digest = requireSha256(inspected.sha256, `${source.id} downloaded asset digest`);
    if (inspected.size !== releaseAsset.size) {
      throw new Error(`${source.id} asset ${releaseAsset.name} changed size during inspection`);
    }
    if (releaseAsset.sha256 && digest !== releaseAsset.sha256) {
      throw new Error(`${source.id} asset ${releaseAsset.name} changed digest during inspection`);
    }

    assets.push({
      target: assetPolicy.target,
      releaseId: release.id,
      releaseTag: release.tagName,
      releasePublishedAtUtc: release.publishedAt,
      releaseUrl: release.htmlUrl,
      assetId: releaseAsset.id,
      assetName: releaseAsset.name,
      sourceUrl,
      kind: assetPolicy.kind,
      size: inspected.size,
      sha256: digest,
      members: mergeMembers(source.id, assetPolicy, inspected),
    });
  }

  return {
    id: source.id,
    adapter: source.adapter,
    selection: source.selection,
    repository: source.repository,
    version: release.tagName,
    assets: assets.sort(assetComparator),
  };
}

async function attachRedistribution({
  policySource,
  lockSource,
  currentSource,
  provenanceResolver,
  githubToken,
}) {
  const redistribution = policySource.redistribution;
  if (
    policySource.id !== "ffmpeg-windows" ||
    !redistribution?.requiredEvidence?.includes("build-revision")
  ) {
    return lockSource;
  }
  let provenance;
  try {
    provenance = await provenanceResolver(lockSource, {
      githubToken,
      licenseFiles: redistribution.licenseFiles,
    });
  } catch (error) {
    const previous = currentSource?.redistribution;
    const currentWithoutRedistribution = structuredClone(currentSource ?? {});
    delete currentWithoutRedistribution.redistribution;
    for (const asset of currentWithoutRedistribution.assets ?? []) delete asset.archive;
    const sameLockedSource =
      currentSource &&
      JSON.stringify(stableValue(currentWithoutRedistribution)) ===
        JSON.stringify(stableValue(lockSource));
    const sameLicenseFiles =
      JSON.stringify([...(previous?.provenance?.licenseFiles ?? [])].sort(compareStrings)) ===
      JSON.stringify([...redistribution.licenseFiles].sort(compareStrings));
    const previousEligibility = verifyFfmpegProvenance(
      lockSource,
      previous?.provenance,
    );
    if (
      sameLockedSource &&
      previous?.archiveEligible === true &&
      sameLicenseFiles &&
      previousEligibility.eligible
    ) {
      return {
        ...lockSource,
        redistribution: previous,
      };
    }
    return {
      ...lockSource,
      redistribution: {
        archiveEligible: false,
      },
    };
  }
  const eligibility = verifyFfmpegProvenance(lockSource, provenance);
  return {
    ...lockSource,
    redistribution: {
      archiveEligible: eligibility.eligible,
      ...(eligibility.eligible ? { provenance } : {}),
    },
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareStrings)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function lockContent(lock) {
  if (!lock || typeof lock !== "object") return null;
  const {
    revision: _revision,
    generatedAtUtc: _generatedAtUtc,
    ...content
  } = structuredClone(lock);
  for (const source of content.sources ?? []) {
    for (const asset of source.assets ?? []) delete asset.archive;
  }
  return stableValue(content);
}

function sameContent(left, right) {
  return JSON.stringify(lockContent(left)) === JSON.stringify(lockContent(right));
}

export async function resolveToolchainLock({
  policy: policyValue,
  currentLock,
  now = new Date(),
  tempDirectory,
  githubAdapter = fetchGitHubReleases,
  inspectAsset = inspectAssetDefault,
  provenanceResolver = resolveFfmpegProvenance,
  githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
}) {
  validDate(now, "Toolchain lock generation time");
  const policy = validateToolchainPolicy(structuredClone(policyValue));
  const approvedHosts = new Set(policy.approvedHosts);
  const ownsTempDirectory = !tempDirectory;
  const inspectionDirectory =
    tempDirectory ?? (await mkdtemp(join(tmpdir(), "yt-dlp-tauri-toolchain-")));
  const inspect = createInspector(inspectAsset, inspectionDirectory, approvedHosts);
  const currentSources = new Map(
    (currentLock?.sources ?? []).map((source) => [source.id, source]),
  );

  try {
    const sources = [];
    for (const source of policy.sources) {
      if (source.adapter === "github-release") {
        const resolved = await resolveGitHubSource({
            source,
            now,
            approvedHosts,
            githubAdapter,
            githubToken,
            inspect,
          });
        sources.push(
          await attachRedistribution({
            policySource: source,
            lockSource: resolved,
            currentSource: currentSources.get(source.id),
            provenanceResolver,
            githubToken,
          }),
        );
      } else {
        throw new Error(`Unsupported toolchain source adapter: ${source.adapter}`);
      }
    }

    const rawCandidate = {
      schemaVersion: 2,
      targets: [...policy.targets].sort(compareStrings),
      sources: sources.sort((left, right) => compareStrings(left.id, right.id)),
    };
    const completeArchive = hasCompleteArchiveDescriptors({
      policy,
      currentLock,
      candidateLock: rawCandidate,
    });
    if (
      sameContent(rawCandidate, currentLock) &&
      completeArchive &&
      typeof currentLock?.revision === "string" &&
      typeof currentLock?.generatedAtUtc === "string"
    ) {
      return assignArchiveDescriptors({
        policy,
        currentLock,
        candidateLock: {
          ...rawCandidate,
          revision: currentLock.revision,
          generatedAtUtc: currentLock.generatedAtUtc,
        },
      });
    }
    return assignArchiveDescriptors({
      policy,
      currentLock,
      candidateLock: {
        ...rawCandidate,
        revision: nextRevision(currentLock?.revision, now),
        generatedAtUtc: now.toISOString(),
      },
    });
  } finally {
    if (ownsTempDirectory) {
      await rm(inspectionDirectory, { recursive: true, force: true });
    }
  }
}
