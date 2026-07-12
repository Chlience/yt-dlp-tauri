import { createHash } from "node:crypto";

import { parseChannelRecord, selectManifestAsset } from "./channel.mjs";

export const ARCHIVE_REPOSITORY = "Chlience/yt-dlp-tauri-toolchain";
export const GITHUB_API_VERSION = "2026-03-10";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[0-9]{8}\.[1-9][0-9]*$/u;

export class ArchiveChannelError extends Error {
  constructor(failureClass, message, options) {
    super(message, options);
    this.name = "ArchiveChannelError";
    this.failureClass = failureClass;
  }
}

export async function fetchStableToolchainManifest({
  token = "",
  fetchImpl = globalThis.fetch,
  repository = ARCHIVE_REPOSITORY,
  userAgent = "yt-dlp-tauri-toolchain-consumer",
} = {}) {
  requireArchiveRepository(repository);
  const headers = githubHeaders(token, userAgent);
  const stableUrl = `https://api.github.com/repos/${repository}/releases/tags/toolchain-stable`;
  const stableResponse = await request(stableUrl, { headers }, fetchImpl);
  if (stableResponse.status === 404) return { status: "missing" };
  requireResponse(
    stableResponse,
    "archive-unavailable",
    "Stable archive channel lookup",
  );
  const stableRelease = await responseJson(
    stableResponse,
    "Stable archive channel",
  );
  let channel;
  try {
    channel = parseChannelRecord(stableRelease.body ?? "");
  } catch (error) {
    throw integrityError(
      `Stable archive channel is invalid: ${error.message}`,
      error,
    );
  }
  if (channel.schemaVersion !== 2 || channel.repository !== repository) {
    throw integrityError(
      "Stable archive channel must use schema 2 and the configured repository",
    );
  }

  const release = await fetchToolchainRevisionRelease({
    revision: channel.revision,
    token,
    fetchImpl,
    repository,
    userAgent,
  });
  if (release.tag_name !== channel.releaseTag) {
    throw integrityError(
      `Revision release tag does not match ${channel.releaseTag}`,
    );
  }
  let asset;
  try {
    asset = selectManifestAsset(release, channel);
  } catch (error) {
    throw integrityError(
      `Stable manifest asset is invalid: ${error.message}`,
      error,
    );
  }
  const downloaded = await downloadVerifiedReleaseAsset({
    release,
    name: channel.manifest,
    token,
    fetchImpl,
    repository,
    userAgent,
  });
  if (downloaded.sha256 !== channel.sha256) {
    throw integrityError(
      `Stable manifest SHA-256 mismatch: expected ${channel.sha256}, received ${downloaded.sha256}`,
    );
  }
  const manifest = verifyArchiveManifestBytes(channel, downloaded.bytes);
  return {
    status: "available",
    channel,
    release,
    asset,
    manifest,
    bytes: downloaded.bytes,
    sha256: downloaded.sha256,
  };
}

export async function fetchToolchainRevisionRelease({
  revision,
  token = "",
  fetchImpl = globalThis.fetch,
  repository = ARCHIVE_REPOSITORY,
  userAgent = "yt-dlp-tauri-toolchain-consumer",
}) {
  requireArchiveRepository(repository);
  requireRevision(revision);
  const releaseTag = `toolchain-${revision}`;
  const url = `https://api.github.com/repos/${repository}/releases/tags/${releaseTag}`;
  const response = await request(
    url,
    { headers: githubHeaders(token, userAgent) },
    fetchImpl,
  );
  requireResponse(
    response,
    "archive-unavailable",
    `Archive revision ${releaseTag} lookup`,
  );
  const release = await responseJson(
    response,
    `Archive revision ${releaseTag}`,
  );
  if (
    release.tag_name !== releaseTag ||
    release.draft !== false ||
    release.prerelease === true ||
    release.immutable !== true ||
    !Array.isArray(release.assets)
  ) {
    throw integrityError(
      `Archive revision ${releaseTag} must be published and immutable`,
    );
  }
  return release;
}

export async function downloadVerifiedReleaseAsset({
  release,
  name,
  token = "",
  fetchImpl = globalThis.fetch,
  repository = ARCHIVE_REPOSITORY,
  userAgent = "yt-dlp-tauri-toolchain-consumer",
}) {
  requireArchiveRepository(repository);
  const releaseTag = requireImmutableRelease(release);
  const matches = release.assets.filter((asset) => asset?.name === name);
  if (matches.length !== 1) {
    throw integrityError(
      `Expected exactly one archive asset named ${name}, found ${matches.length}`,
    );
  }
  const asset = matches[0];
  const expectedDigest = normalizeAsset(asset, repository, releaseTag, name);
  const response = await request(
    asset.browser_download_url,
    { headers: githubHeaders(token, userAgent) },
    fetchImpl,
  );
  requireResponse(
    response,
    "archive-unavailable",
    `Archive asset ${name} download`,
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== asset.size || sha256 !== expectedDigest) {
    throw integrityError(
      `Archive asset ${name} differs from immutable release metadata: expected ${asset.size} bytes and ${expectedDigest}, received ${bytes.length} bytes and ${sha256}`,
    );
  }
  return { asset, bytes, sha256 };
}

export function verifyArchiveManifestBytes(channel, bytes) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== channel.sha256) {
    throw integrityError(
      `Archive manifest digest differs from channel: expected ${channel.sha256}, received ${sha256}`,
    );
  }
  let manifest;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    manifest = JSON.parse(json);
  } catch (error) {
    throw integrityError(
      `Archive manifest is not valid UTF-8 JSON: ${error.message}`,
      error,
    );
  }
  if (
    manifest?.schemaVersion !== 4 ||
    manifest.revision !== channel.revision ||
    !Array.isArray(manifest.targets)
  ) {
    throw integrityError(
      "Archive manifest schema or revision does not match the stable channel",
    );
  }
  const sourcePrefix = `https://github.com/${channel.repository}/releases/download/${channel.releaseTag}/`;
  const sourcePathPrefix = `/${channel.repository}/releases/download/${channel.releaseTag}/`;
  for (const target of manifest.targets) {
    if (typeof target?.target !== "string" || !Array.isArray(target.tools)) {
      throw integrityError("Archive manifest contains an invalid target");
    }
    for (const tool of target.tools) {
      let sourceUrl;
      try {
        sourceUrl = new URL(tool?.sourceUrl);
      } catch {
        sourceUrl = null;
      }
      const assetName = sourceUrl?.pathname.startsWith(sourcePathPrefix)
        ? sourceUrl.pathname.slice(sourcePathPrefix.length)
        : "";
      if (
        !sourceUrl ||
        sourceUrl.protocol !== "https:" ||
        sourceUrl.hostname !== "github.com" ||
        sourceUrl.username ||
        sourceUrl.password ||
        sourceUrl.search ||
        sourceUrl.hash ||
        !tool.sourceUrl.startsWith(sourcePrefix) ||
        !assetName ||
        assetName.includes("/") ||
        !Number.isSafeInteger(tool.sourceSize) ||
        tool.sourceSize <= 0 ||
        !SHA256_PATTERN.test(tool.sourceSha256 ?? "") ||
        !SHA256_PATTERN.test(tool.sha256 ?? "")
      ) {
        throw integrityError(
          `Archive manifest contains invalid runtime bytes for ${target.target}/${tool?.name}`,
        );
      }
    }
  }
  return manifest;
}

function requireImmutableRelease(release) {
  if (
    !release ||
    typeof release.tag_name !== "string" ||
    release.draft !== false ||
    release.prerelease === true ||
    release.immutable !== true ||
    !Array.isArray(release.assets)
  ) {
    throw integrityError("Archive release must be published and immutable");
  }
  return release.tag_name;
}

function normalizeAsset(asset, repository, releaseTag, name) {
  if (
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0
  ) {
    throw integrityError(
      `Archive asset ${name} must have a positive ID and byte size`,
    );
  }
  const expectedDigest = String(asset.digest ?? "").replace(/^sha256:/u, "");
  if (!SHA256_PATTERN.test(expectedDigest)) {
    throw integrityError(
      `Archive asset ${name} must have a lowercase SHA-256 digest`,
    );
  }
  let url;
  try {
    url = new URL(asset.browser_download_url);
  } catch (error) {
    throw integrityError(`Archive asset ${name} has an invalid URL`, error);
  }
  const expectedPath = `/${repository}/releases/download/${releaseTag}/${encodeURIComponent(name)}`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== expectedPath
  ) {
    throw integrityError(
      `Archive asset ${name} URL does not match ${releaseTag}`,
    );
  }
  return expectedDigest;
}

function githubHeaders(token, userAgent) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": userAgent,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function request(url, options, fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  try {
    return await fetchImpl(url, options);
  } catch (error) {
    throw new ArchiveChannelError(
      "archive-unavailable",
      `Archive request failed for ${url}: ${error.message}`,
      { cause: error },
    );
  }
}

function requireResponse(response, failureClass, label) {
  if (!response?.ok) {
    throw new ArchiveChannelError(
      failureClass,
      `${label} failed with HTTP ${response?.status ?? "unknown"}`,
    );
  }
}

async function responseJson(response, label) {
  try {
    return await response.json();
  } catch (error) {
    throw integrityError(
      `${label} returned invalid JSON: ${error.message}`,
      error,
    );
  }
}

function requireArchiveRepository(repository) {
  if (repository !== ARCHIVE_REPOSITORY) {
    throw new Error(`Archive repository must be ${ARCHIVE_REPOSITORY}`);
  }
}

function requireRevision(revision) {
  if (!REVISION_PATTERN.test(revision ?? "")) {
    throw new Error(`Invalid toolchain revision: ${revision}`);
  }
  const [date] = revision.split(".");
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const sequence = BigInt(revision.split(".")[1]);
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    sequence > 4_294_967_295n
  ) {
    throw new Error(`Invalid toolchain revision: ${revision}`);
  }
}

function integrityError(message, cause) {
  return new ArchiveChannelError("archive-integrity", message, { cause });
}
