import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const REVISION_PATTERN = /^[0-9]{8}\.[1-9][0-9]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

export function verifyFfmpegProvenance(lockSource, provenance) {
  const problems = [];
  const assets = normalizeLockAssets(lockSource, problems);
  const repository = lockSource?.repository;
  const asset = lockSource?.assets?.[0];

  if (lockSource?.id !== "ffmpeg-windows") {
    problems.push("FFmpeg mirror source must be ffmpeg-windows");
  }
  if (repository !== "yt-dlp/FFmpeg-Builds") {
    problems.push("FFmpeg mirror source repository must be yt-dlp/FFmpeg-Builds");
  }
  if (!asset || lockSource.assets.length !== 1) {
    problems.push("FFmpeg mirror source must contain exactly one Windows asset");
  }
  if (!provenance || typeof provenance !== "object") {
    problems.push("FFmpeg redistribution provenance is missing");
    return { eligible: false, problems, assets };
  }

  if (provenance.binaryReleaseUrl !== asset?.releaseUrl) {
    problems.push("FFmpeg binary release URL does not match the lock");
  }
  if (!SHA256_PATTERN.test(provenance.binarySha256 ?? "")) {
    problems.push("FFmpeg binary SHA-256 is invalid");
  } else if (provenance.binarySha256 !== asset?.sha256) {
    problems.push("FFmpeg binary SHA-256 does not match the lock");
  }
  for (const [label, value] of [
    ["FFmpeg source revision", provenance.ffmpegSourceRevision],
    ["FFmpeg build repository revision", provenance.buildRepositoryRevision],
  ]) {
    if (!COMMIT_PATTERN.test(value ?? "")) {
      problems.push(`${label} must be a full 40-character commit SHA`);
    }
  }

  const expectedChecksumUrl =
    asset && repository
      ? `https://github.com/${repository}/releases/download/${asset.releaseTag}/checksums.sha256`
      : null;
  if (
    provenance.checksumUrl !== expectedChecksumUrl ||
    !isImmutableHttpsUrl(provenance.checksumUrl)
  ) {
    problems.push("FFmpeg provenance must use the immutable release checksum URL");
  }

  const licenseFiles = Array.isArray(provenance.licenseFiles)
    ? provenance.licenseFiles
    : [];
  if (licenseFiles.length === 0 || licenseFiles.some((path) => !isSafeRelativePath(path))) {
    problems.push("FFmpeg provenance license files must be safe relative paths");
  }
  if (!licenseFiles.some((path) => /(?:^|\/)(?:copying|license|gpl)[^/]*$/iu.test(path))) {
    problems.push("FFmpeg provenance requires a GPL license file");
  }
  if (!licenseFiles.includes("THIRD-PARTY-NOTICES.md")) {
    problems.push("FFmpeg provenance requires THIRD-PARTY-NOTICES.md");
  }

  return { eligible: problems.length === 0, problems, assets };
}

export async function resolveFfmpegProvenance(
  lockSource,
  {
    fetchImpl = globalThis.fetch,
    githubToken,
    licenseFiles = ["LICENSE", "THIRD-PARTY-NOTICES.md"],
  } = {},
) {
  const repository = requireString(lockSource?.repository, "FFmpeg build repository");
  const asset = requireSingleAsset(lockSource);
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "yt-dlp-tauri-ffmpeg-provenance",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  const api = "https://api.github.com/repos";
  const release = await fetchJson(
    fetchImpl,
    `${api}/${repository}/releases/tags/${encodeURIComponent(asset.releaseTag)}`,
    headers,
    "FFmpeg build release",
  );
  if (release.id !== asset.releaseId || release.tag_name !== asset.releaseTag) {
    throw new Error("FFmpeg release identity differs from the lock");
  }
  const binaryAsset = release.assets?.find((item) => item.id === asset.assetId);
  if (!binaryAsset || binaryAsset.name !== asset.assetName) {
    throw new Error("FFmpeg binary asset identity differs from the lock");
  }
  const checksumAsset = release.assets?.find((item) => item.name === "checksums.sha256");
  if (!checksumAsset) throw new Error("FFmpeg release is missing checksums.sha256");
  const checksumResponse = await fetchImpl(checksumAsset.browser_download_url, { headers });
  if (!checksumResponse.ok) {
    throw new Error(`FFmpeg checksum download failed: ${checksumResponse.status}`);
  }
  const checksumText = await checksumResponse.text();
  const binarySha256 = checksumForAsset(checksumText, asset.assetName);
  if (binarySha256 !== asset.sha256) {
    throw new Error("FFmpeg release checksum differs from the lock");
  }

  const buildRepositoryRevision = await resolveTagCommit(
    fetchImpl,
    `${api}/${repository}`,
    asset.releaseTag,
    headers,
  );
  const shortFfmpegRevision = asset.assetName.match(/-g([a-f0-9]{7,40})-/u)?.[1];
  if (!shortFfmpegRevision) {
    throw new Error(`Unable to parse FFmpeg revision from ${asset.assetName}`);
  }
  const ffmpegCommit = await fetchJson(
    fetchImpl,
    `${api}/FFmpeg/FFmpeg/commits/${shortFfmpegRevision}`,
    headers,
    "FFmpeg source commit",
  );
  const ffmpegSourceRevision = requireCommit(ffmpegCommit.sha, "FFmpeg source revision");

  return {
    binaryReleaseUrl: asset.releaseUrl,
    binarySha256,
    ffmpegSourceRevision,
    buildRepositoryRevision,
    checksumUrl: checksumAsset.browser_download_url,
    checksumSha256: createHash("sha256").update(checksumText).digest("hex"),
    licenseFiles: [...licenseFiles].sort(),
  };
}

export function createFfmpegProvenanceAsset(revision, lockSource, provenance) {
  if (!REVISION_PATTERN.test(revision ?? "")) {
    throw new Error(`Invalid toolchain revision: ${revision}`);
  }
  const eligibility = verifyFfmpegProvenance(lockSource, provenance);
  if (!eligibility.eligible) {
    throw new Error(`FFmpeg is not mirror eligible:\n${eligibility.problems.join("\n")}`);
  }
  const asset = lockSource.assets[0];
  const buildRepository = lockSource.repository;
  return {
    schemaVersion: SCHEMA_VERSION,
    revision,
    sourceId: lockSource.id,
    binary: {
      releaseId: String(asset.releaseId),
      releaseTag: asset.releaseTag,
      releaseUrl: asset.releaseUrl,
      assetId: String(asset.assetId),
      assetName: asset.assetName,
      sourceUrl: asset.sourceUrl,
      size: asset.size,
      sha256: asset.sha256,
    },
    checksum: {
      url: provenance.checksumUrl,
      sha256: provenance.checksumSha256 ?? null,
    },
    ffmpegSource: {
      repository: "FFmpeg/FFmpeg",
      revision: provenance.ffmpegSourceRevision,
      commitUrl: `https://github.com/FFmpeg/FFmpeg/commit/${provenance.ffmpegSourceRevision}`,
      archiveUrl: `https://github.com/FFmpeg/FFmpeg/archive/${provenance.ffmpegSourceRevision}.tar.gz`,
    },
    buildRepository: {
      repository: buildRepository,
      revision: provenance.buildRepositoryRevision,
      commitUrl: `https://github.com/${buildRepository}/commit/${provenance.buildRepositoryRevision}`,
      archiveUrl: `https://github.com/${buildRepository}/archive/${provenance.buildRepositoryRevision}.tar.gz`,
    },
    licenseFiles: [...provenance.licenseFiles].sort(),
  };
}

export function canonicalFfmpegProvenanceJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function checksumForAsset(checksumText, assetName) {
  const matches = String(checksumText)
    .split(/\r?\n/u)
    .map((line) => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/iu))
    .filter((match) => match?.[2] === assetName);
  if (matches.length !== 1) {
    throw new Error(`Expected one checksum for ${assetName}, found ${matches.length}`);
  }
  return matches[0][1].toLowerCase();
}

async function resolveTagCommit(fetchImpl, repositoryApi, tag, headers) {
  let object = await fetchJson(
    fetchImpl,
    `${repositoryApi}/git/ref/tags/${encodeURIComponent(tag)}`,
    headers,
    "FFmpeg build tag",
  );
  object = object.object;
  for (let depth = 0; depth < 3 && object?.type === "tag"; depth += 1) {
    const tagObject = await fetchJson(
      fetchImpl,
      `${repositoryApi}/git/tags/${object.sha}`,
      headers,
      "FFmpeg annotated build tag",
    );
    object = tagObject.object;
  }
  if (object?.type !== "commit") throw new Error("FFmpeg build tag does not resolve to a commit");
  return requireCommit(object.sha, "FFmpeg build repository revision");
}

async function fetchJson(fetchImpl, url, headers, label) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) throw new Error(`${label} lookup failed: ${response.status}`);
  return response.json();
}

function normalizeLockAssets(lockSource, problems) {
  if (!Array.isArray(lockSource?.assets)) return [];
  return lockSource.assets
    .map((asset) => {
      if (
        asset?.target !== "win-x64" ||
        typeof asset.assetName !== "string" ||
        !SHA256_PATTERN.test(asset.sha256 ?? "") ||
        !Number.isSafeInteger(asset.size) ||
        asset.size <= 0
      ) {
        problems.push("FFmpeg lock contains an invalid mirror asset");
      }
      return {
        target: asset?.target,
        assetName: asset?.assetName,
        sourceUrl: asset?.sourceUrl,
        size: asset?.size,
        sha256: asset?.sha256,
      };
    })
    .sort((left, right) => String(left.target).localeCompare(String(right.target)));
}

function requireSingleAsset(lockSource) {
  if (!Array.isArray(lockSource?.assets) || lockSource.assets.length !== 1) {
    throw new Error("FFmpeg lock source must contain exactly one asset");
  }
  return lockSource.assets[0];
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireCommit(value, label) {
  if (!COMMIT_PATTERN.test(value ?? "")) throw new Error(`${label} is not a full commit SHA`);
  return value;
}

function isImmutableHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/\/(?:latest|master|main)(?:\/|$)/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.replaceAll("\\", "/").split("/").includes("..")
  );
}
