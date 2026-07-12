import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  archiveReleaseTag,
  validateArchiveDescriptor,
} from "./archive-contract.mjs";

const INDEX_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const INDEX_FIELDS = [
  "schemaVersion",
  "revision",
  "repositoryId",
  "pullRequestNumber",
  "headSha",
  "lockSha256",
  "createdAtUtc",
  "assets",
];

function compareStrings(left, right) {
  return String(left).localeCompare(String(right));
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function canonicalLockBytes(lock, lockBytes) {
  if (lockBytes !== undefined) {
    if (!Buffer.isBuffer(lockBytes) && !(lockBytes instanceof Uint8Array)) {
      throw new Error("Toolchain lock bytes must be a Buffer or Uint8Array");
    }
    return Buffer.from(lockBytes);
  }
  return Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeContext(value = {}) {
  const context = requireObject(value, "Candidate context");
  let repositoryId = null;
  if (context.repositoryId !== undefined && context.repositoryId !== null && context.repositoryId !== "") {
    repositoryId = String(context.repositoryId);
    if (!/^[1-9][0-9]*$/u.test(repositoryId)) {
      throw new Error("Candidate repository ID must be a positive integer");
    }
  }
  let pullRequestNumber = null;
  if (
    context.pullRequestNumber !== undefined &&
    context.pullRequestNumber !== null &&
    context.pullRequestNumber !== ""
  ) {
    pullRequestNumber = Number(context.pullRequestNumber);
    requirePositiveInteger(pullRequestNumber, "Candidate pull request number");
  }
  let headSha = null;
  if (context.headSha !== undefined && context.headSha !== null && context.headSha !== "") {
    headSha = String(context.headSha).toLowerCase();
    if (!SHA_PATTERN.test(headSha)) {
      throw new Error("Candidate head SHA must be a 40-character lowercase commit SHA");
    }
  }
  return { repositoryId, pullRequestNumber, headSha };
}

function referenceComparator(left, right) {
  return (
    compareStrings(left.sourceId, right.sourceId) ||
    compareStrings(left.target, right.target) ||
    compareStrings(left.sourceUrl, right.sourceUrl) ||
    compareStrings(left.archive.assetName, right.archive.assetName)
  );
}

export function candidateAssetsForRevision(lockValue) {
  const lock = requireObject(lockValue, "Toolchain lock");
  const releaseTag = archiveReleaseTag(lock.revision);
  if (!Array.isArray(lock.sources)) throw new Error("Toolchain lock sources must be an array");
  const byDigest = new Map();

  for (const source of lock.sources) {
    if (typeof source.id !== "string" || source.id === "") {
      throw new Error("Toolchain lock source must have an ID");
    }
    if (!Array.isArray(source.assets)) {
      throw new Error(`Toolchain lock source ${source.id} assets must be an array`);
    }
    for (const asset of source.assets) {
      const archive = validateArchiveDescriptor(asset.archive, {
        repository: "Chlience/yt-dlp-tauri-toolchain",
        size: asset.size,
        sha256: asset.sha256,
      });
      if (archive.releaseTag !== releaseTag) continue;
      const sha256 = requireSha256(asset.sha256, `${source.id} candidate SHA-256`);
      const size = requirePositiveInteger(asset.size, `${source.id} candidate size`);
      if (asset.kind !== "file" && asset.kind !== "zip") {
        throw new Error(`${source.id} candidate kind must be file or zip`);
      }
      const sourceUrl = String(asset.sourceUrl ?? "");
      if (sourceUrl === "") throw new Error(`${source.id} candidate source URL is missing`);
      const reference = {
        sourceId: source.id,
        target: String(asset.target ?? ""),
        sourceUrl,
        archive,
      };
      const existing = byDigest.get(sha256);
      if (existing) {
        if (existing.size !== size || existing.kind !== asset.kind) {
          throw new Error(`Candidate digest ${sha256} has conflicting byte metadata`);
        }
        existing.references.push(reference);
      } else {
        byDigest.set(sha256, {
          path: `assets/${sha256}`,
          size,
          sha256,
          kind: asset.kind,
          references: [reference],
        });
      }
    }
  }

  return [...byDigest.values()]
    .map((entry) => ({
      ...entry,
      references: entry.references.sort(referenceComparator),
    }))
    .sort((left, right) => compareStrings(left.sha256, right.sha256));
}

function approvedUrl(value, approvedHosts, label, { allowQuery = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (!allowQuery && url.search) ||
    url.hash
  ) {
    throw new Error(`${label} must be an immutable HTTPS URL`);
  }
  if (!approvedHosts.has(url.hostname)) {
    throw new Error(`${label} uses unapproved source host ${url.hostname}`);
  }
  return url;
}

async function writeChunk(handle, chunk) {
  const bytes = Buffer.from(chunk);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten <= 0) throw new Error("Candidate download write made no progress");
    offset += result.bytesWritten;
  }
}

async function downloadCandidateAsset({
  entry,
  destination,
  approvedHosts,
  fetchImpl,
}) {
  for (const reference of entry.references) {
    approvedUrl(reference.sourceUrl, approvedHosts, `${reference.sourceId} candidate URL`);
  }
  const sourceUrl = entry.references[0]?.sourceUrl;
  if (!sourceUrl) throw new Error(`Candidate ${entry.sha256} has no source reference`);
  const response = await fetchImpl(sourceUrl, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "yt-dlp-tauri-toolchain-candidate",
    },
    redirect: "follow",
  });
  if (!response?.ok) {
    throw new Error(`Candidate download failed with HTTP ${response?.status ?? "unknown"}: ${sourceUrl}`);
  }
  if (response.url) {
    approvedUrl(response.url, approvedHosts, "Candidate final URL", {
      allowQuery: true,
    });
  }
  if (!response.body) throw new Error(`Candidate download returned no body: ${sourceUrl}`);

  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    if (!/^[0-9]+$/u.test(contentLength)) {
      throw new Error(`Candidate download has invalid Content-Length: ${contentLength}`);
    }
    const advertised = Number(contentLength);
    if (!Number.isSafeInteger(advertised) || advertised !== entry.size) {
      throw new Error(
        `Candidate Content-Length mismatch for ${entry.sha256}: expected ${entry.size}, got ${contentLength}`,
      );
    }
  }

  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  const hasher = createHash("sha256");
  let size = 0;
  try {
    try {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        await writeChunk(handle, bytes);
        hasher.update(bytes);
        size += bytes.length;
        if (size > entry.size) {
          throw new Error(
            `Candidate size mismatch for ${entry.sha256}: download exceeds ${entry.size}`,
          );
        }
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (size !== entry.size) {
      throw new Error(
        `Candidate size mismatch for ${entry.sha256}: expected ${entry.size}, got ${size}`,
      );
    }
    const digest = hasher.digest("hex");
    if (digest !== entry.sha256) {
      throw new Error(
        `Candidate SHA-256 mismatch for ${entry.sha256}: got ${digest}`,
      );
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function canonicalIndex(index) {
  return `${JSON.stringify(index, null, 2)}\n`;
}

function requireDate(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date`);
  }
  if (new Date(value).toISOString() !== value) {
    throw new Error(`${label} must use canonical ISO formatting`);
  }
  return value;
}

async function requireAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists at ${path}`);
}

export async function prepareCandidateBundle({
  policy: policyValue,
  lock: lockValue,
  lockBytes,
  outputDirectory,
  fetchImpl = globalThis.fetch,
  context = {},
  now = new Date(),
}) {
  const policy = requireObject(policyValue, "Toolchain policy");
  const lock = requireObject(lockValue, "Toolchain lock");
  if (!Array.isArray(policy.approvedHosts) || policy.approvedHosts.length === 0) {
    throw new Error("Toolchain policy approvedHosts must be a non-empty array");
  }
  if (typeof fetchImpl !== "function") throw new Error("Candidate fetch must be a function");
  if (typeof outputDirectory !== "string" || outputDirectory === "") {
    throw new Error("Candidate output directory must be a non-empty path");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Candidate creation time must be a valid Date");
  }

  const assets = candidateAssetsForRevision(lock);
  const normalizedContext = normalizeContext(context);
  const index = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    revision: lock.revision,
    ...normalizedContext,
    lockSha256: sha256Bytes(canonicalLockBytes(lock, lockBytes)),
    createdAtUtc: now.toISOString(),
    assets,
  };
  const assetsDirectory = join(outputDirectory, "assets");
  const indexPath = join(outputDirectory, "candidate-assets.json");
  await mkdir(assetsDirectory, { recursive: true });
  await requireAbsent(indexPath, "Candidate index");
  const created = [];
  try {
    const approvedHosts = new Set(policy.approvedHosts);
    for (const entry of assets) {
      const destination = join(outputDirectory, entry.path);
      await requireAbsent(destination, "Candidate asset");
      await downloadCandidateAsset({
        entry,
        destination,
        approvedHosts,
        fetchImpl,
      });
      created.push(destination);
    }
    await writeFile(indexPath, canonicalIndex(index), { flag: "wx" });
    created.push(indexPath);
    await verifyCandidateBundle({
      lock,
      lockBytes,
      directory: outputDirectory,
      expectedContext: normalizedContext,
    });
    return index;
  } catch (error) {
    await Promise.all(created.map((path) => rm(path, { force: true })));
    throw error;
  }
}

async function sha256File(path) {
  const handle = await open(path, "r");
  const hasher = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hasher.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hasher.digest("hex");
}

function assertContext(index, expectedContextValue) {
  const expected = normalizeContext(expectedContextValue);
  if (expected.repositoryId !== null && index.repositoryId !== expected.repositoryId) {
    throw new Error("Candidate repository ID does not match");
  }
  if (
    expected.pullRequestNumber !== null &&
    index.pullRequestNumber !== expected.pullRequestNumber
  ) {
    throw new Error("Candidate pull request number does not match");
  }
  if (expected.headSha !== null && index.headSha !== expected.headSha) {
    throw new Error("Candidate head SHA does not match");
  }
}

export async function verifyCandidateBundle({
  lock: lockValue,
  lockBytes,
  directory,
  expectedContext = {},
}) {
  const lock = requireObject(lockValue, "Toolchain lock");
  if (typeof directory !== "string" || directory === "") {
    throw new Error("Candidate directory must be a non-empty path");
  }
  const indexPath = join(directory, "candidate-assets.json");
  const indexMetadata = await lstat(indexPath);
  if (!indexMetadata.isFile() || indexMetadata.isSymbolicLink()) {
    throw new Error("Candidate index must be a regular file");
  }
  const indexText = await readFile(indexPath, "utf8");
  let index;
  try {
    index = JSON.parse(indexText);
  } catch (error) {
    throw new Error(`Candidate index contains invalid JSON: ${error.message}`);
  }
  requireObject(index, "Candidate index");
  if (JSON.stringify(Object.keys(index)) !== JSON.stringify(INDEX_FIELDS)) {
    throw new Error("Candidate index has missing, unknown, or reordered fields");
  }
  if (index.schemaVersion !== INDEX_SCHEMA_VERSION) {
    throw new Error(`Unsupported candidate index schema: ${index.schemaVersion}`);
  }
  if (index.revision !== lock.revision) {
    throw new Error("Candidate revision does not match the toolchain lock");
  }
  normalizeContext(index);
  assertContext(index, expectedContext);
  const expectedLockSha256 = sha256Bytes(canonicalLockBytes(lock, lockBytes));
  if (index.lockSha256 !== expectedLockSha256) {
    throw new Error("Candidate lock SHA-256 does not match");
  }
  requireDate(index.createdAtUtc, "Candidate creation time");
  const expectedAssets = candidateAssetsForRevision(lock);
  if (JSON.stringify(index.assets) !== JSON.stringify(expectedAssets)) {
    throw new Error("Candidate asset index differs from the toolchain lock");
  }
  if (indexText !== canonicalIndex(index)) {
    throw new Error("Candidate index is not canonical JSON");
  }

  const rootEntries = await readdir(directory, { withFileTypes: true });
  for (const entry of rootEntries) {
    const expectedDirectory = entry.name === "assets" && entry.isDirectory();
    const expectedIndex = entry.name === "candidate-assets.json" && entry.isFile();
    if (entry.isSymbolicLink() || (!expectedDirectory && !expectedIndex)) {
      throw new Error(`Found unexpected candidate bundle entry: ${entry.name}`);
    }
  }
  const hasAssetsDirectory = rootEntries.some(
    (entry) => entry.name === "assets" && entry.isDirectory(),
  );
  if (
    rootEntries.length !== (hasAssetsDirectory ? 2 : 1) ||
    (expectedAssets.length > 0 && !hasAssetsDirectory)
  ) {
    throw new Error("Candidate bundle root has missing or extra entries");
  }

  const assetEntries = hasAssetsDirectory
    ? await readdir(join(directory, "assets"), { withFileTypes: true })
    : [];
  const expectedNames = new Set(expectedAssets.map((entry) => entry.sha256));
  for (const entry of assetEntries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !expectedNames.has(entry.name)) {
      throw new Error(`Found unexpected candidate asset: ${entry.name}`);
    }
  }
  if (assetEntries.length !== expectedNames.size) {
    throw new Error("Candidate asset directory has missing files");
  }

  for (const entry of expectedAssets) {
    const path = join(directory, entry.path);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Candidate asset must be a regular file: ${entry.sha256}`);
    }
    if (metadata.size !== entry.size) {
      throw new Error(
        `Candidate size mismatch for ${entry.sha256}: expected ${entry.size}, got ${metadata.size}`,
      );
    }
    const digest = await sha256File(path);
    if (digest !== entry.sha256) {
      throw new Error(`Candidate SHA-256 mismatch for ${entry.sha256}: got ${digest}`);
    }
  }
  return index;
}
