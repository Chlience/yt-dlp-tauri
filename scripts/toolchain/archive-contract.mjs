import { basename, extname } from "node:path";

const ARCHIVE_REPOSITORY = "Chlience/yt-dlp-tauri-toolchain";
const ASSET_NAME_TEMPLATE =
  "{source}-{version}-{assetStem}-{sha256Prefix}{extension}";
const REVISION_PATTERN = /^[0-9]{8}\.[1-9][0-9]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const MAX_ASSET_NAME_BYTES = 200;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireSafeToken(value, label) {
  const token = requireString(value, label);
  if (
    !SAFE_TOKEN_PATTERN.test(token) ||
    token === "." ||
    token === ".." ||
    token.includes("..")
  ) {
    throw new Error(`${label} must be a safe archive token`);
  }
  return token;
}

function requireAssetName(value, label) {
  const name = requireSafeToken(value, label);
  if (Buffer.byteLength(name, "utf8") > MAX_ASSET_NAME_BYTES) {
    throw new Error(`${label} exceeds ${MAX_ASSET_NAME_BYTES} UTF-8 bytes`);
  }
  return name;
}

function sourceAssetName(asset) {
  if (typeof asset.assetName === "string" && asset.assetName.trim() !== "") {
    return asset.assetName.trim();
  }
  const sourceUrl = new URL(requireString(asset.sourceUrl, "Archive source URL"));
  let filename;
  try {
    filename = decodeURIComponent(basename(sourceUrl.pathname));
  } catch {
    throw new Error("Archive source URL contains an invalid encoded asset name");
  }
  return requireString(filename, "Archive source asset name");
}

function byteObjectKey(sourceId, asset) {
  return JSON.stringify([
    sourceId,
    requireString(asset.sourceUrl, `${sourceId} source URL`),
    requireSize(asset.size, `${sourceId} source size`),
    requireSha256(asset.sha256, `${sourceId} source SHA-256`),
  ]);
}

function descriptorSignature(descriptor) {
  return JSON.stringify([
    descriptor.repository,
    descriptor.releaseTag,
    descriptor.assetName,
    descriptor.size,
    descriptor.sha256,
  ]);
}

export function validateArchivePolicy(value, sourceId) {
  const archive = requireObject(value, `source ${sourceId} archive`);
  if (archive.enabled !== true) {
    throw new Error(`source ${sourceId} archive must be enabled`);
  }
  if (archive.repository !== ARCHIVE_REPOSITORY) {
    throw new Error(
      `source ${sourceId} archive repository must be ${ARCHIVE_REPOSITORY}`,
    );
  }
  if (archive.assetNameTemplate !== ASSET_NAME_TEMPLATE) {
    throw new Error(
      `source ${sourceId} archive assetNameTemplate must be ${ASSET_NAME_TEMPLATE}`,
    );
  }
  return {
    enabled: true,
    repository: ARCHIVE_REPOSITORY,
    assetNameTemplate: ASSET_NAME_TEMPLATE,
  };
}

export function archiveReleaseTag(revision) {
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) {
    throw new Error(`Invalid toolchain revision: ${revision}`);
  }
  return `toolchain-${revision}`;
}

export function archiveAssetName(sourceValue, assetValue, archivePolicyValue) {
  const source = requireObject(sourceValue, "Archive source");
  const asset = requireObject(assetValue, "Archive asset");
  const archive = validateArchivePolicy(archivePolicyValue, source.id ?? "unknown");
  const sourceId = requireSafeToken(source.id, "Archive source ID");
  const version = requireSafeToken(source.version, `Archive source ${sourceId} version`);
  const filename = sourceAssetName(asset);
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const assetStem = requireSafeToken(stem, `Archive source ${sourceId} asset stem`);
  const safeExtension = extension
    ? `.${requireSafeToken(extension.slice(1), `Archive source ${sourceId} extension`)}`
    : "";
  const sha256Prefix = requireSha256(
    asset.sha256,
    `Archive source ${sourceId} SHA-256`,
  ).slice(0, 16);

  const name = archive.assetNameTemplate
    .replace("{source}", sourceId)
    .replace("{version}", version)
    .replace("{assetStem}", assetStem)
    .replace("{sha256Prefix}", sha256Prefix)
    .replace("{extension}", safeExtension);
  return requireAssetName(name, `Archive source ${sourceId} asset name`);
}

export function validateArchiveDescriptor(value, expectedValue = {}) {
  const descriptor = requireObject(value, "Archive descriptor");
  const expected = requireObject(expectedValue, "Archive descriptor expectation");
  if (descriptor.repository !== ARCHIVE_REPOSITORY) {
    throw new Error(`Archive descriptor repository must be ${ARCHIVE_REPOSITORY}`);
  }
  if (
    expected.repository !== undefined &&
    descriptor.repository !== expected.repository
  ) {
    throw new Error("Archive descriptor repository does not match");
  }
  const releaseTag = requireString(
    descriptor.releaseTag,
    "Archive descriptor releaseTag",
  );
  if (!releaseTag.startsWith("toolchain-") || !REVISION_PATTERN.test(releaseTag.slice(10))) {
    throw new Error("Archive descriptor releaseTag must identify a toolchain revision");
  }
  const assetName = requireAssetName(
    descriptor.assetName,
    "Archive descriptor assetName",
  );
  const size = requireSize(descriptor.size, "Archive descriptor size");
  const sha256 = requireSha256(descriptor.sha256, "Archive descriptor SHA-256");
  if (expected.size !== undefined && size !== expected.size) {
    throw new Error("Archive descriptor size does not match source bytes");
  }
  if (expected.sha256 !== undefined && sha256 !== expected.sha256) {
    throw new Error("Archive descriptor SHA-256 does not match source bytes");
  }
  return {
    repository: descriptor.repository,
    releaseTag,
    assetName,
    size,
    sha256,
  };
}

export function archiveDescriptorUrl(descriptorValue) {
  const descriptor = validateArchiveDescriptor(descriptorValue, descriptorValue);
  return `https://github.com/${descriptor.repository}/releases/download/${descriptor.releaseTag}/${encodeURIComponent(descriptor.assetName)}`;
}

export function assignArchiveDescriptors({
  policy: policyValue,
  currentLock,
  candidateLock: candidateLockValue,
}) {
  const policy = requireObject(policyValue, "Toolchain policy");
  const candidateLock = structuredClone(
    requireObject(candidateLockValue, "Candidate toolchain lock"),
  );
  archiveReleaseTag(candidateLock.revision);
  if (!Array.isArray(policy.sources) || !Array.isArray(candidateLock.sources)) {
    throw new Error("Toolchain policy and lock must contain sources arrays");
  }

  const policySources = new Map(policy.sources.map((source) => [source.id, source]));
  const currentSources = new Map(
    (currentLock?.sources ?? []).map((source) => [source.id, source]),
  );

  for (const source of candidateLock.sources) {
    const policySource = policySources.get(source.id);
    if (!policySource) throw new Error(`Archive policy is missing source ${source.id}`);
    const archivePolicy = validateArchivePolicy(policySource.archive, source.id);
    if (!Array.isArray(source.assets)) {
      throw new Error(`Toolchain lock source ${source.id} must contain assets`);
    }

    const currentDescriptors = new Map();
    for (const asset of currentSources.get(source.id)?.assets ?? []) {
      const key = byteObjectKey(source.id, asset);
      if (!asset.archive || asset.archive.repository !== archivePolicy.repository) continue;
      const descriptor = validateArchiveDescriptor(asset.archive, {
        repository: archivePolicy.repository,
        size: asset.size,
        sha256: asset.sha256,
      });
      const existing = currentDescriptors.get(key);
      if (existing && descriptorSignature(existing) !== descriptorSignature(descriptor)) {
        throw new Error(`Conflicting archive descriptors for ${source.id}`);
      }
      currentDescriptors.set(key, descriptor);
    }

    const assignedDescriptors = new Map();
    for (const asset of source.assets) {
      const key = byteObjectKey(source.id, asset);
      let descriptor = assignedDescriptors.get(key) ?? currentDescriptors.get(key);
      if (!descriptor) {
        descriptor = {
          repository: archivePolicy.repository,
          releaseTag: archiveReleaseTag(candidateLock.revision),
          assetName: archiveAssetName(source, asset, archivePolicy),
          size: asset.size,
          sha256: asset.sha256,
        };
        descriptor = validateArchiveDescriptor(descriptor, {
          repository: archivePolicy.repository,
          size: asset.size,
          sha256: asset.sha256,
        });
      }
      assignedDescriptors.set(key, descriptor);
      asset.archive = structuredClone(descriptor);
    }
  }

  return candidateLock;
}

export function hasCompleteArchiveDescriptors({
  policy: policyValue,
  currentLock,
  candidateLock: candidateLockValue,
}) {
  const policy = requireObject(policyValue, "Toolchain policy");
  const candidateLock = requireObject(candidateLockValue, "Candidate toolchain lock");
  if (!Array.isArray(policy.sources) || !Array.isArray(candidateLock.sources)) {
    throw new Error("Toolchain policy and lock must contain sources arrays");
  }
  if (!currentLock || !Array.isArray(currentLock.sources)) return false;

  const policySources = new Map(policy.sources.map((source) => [source.id, source]));
  const currentSources = new Map(currentLock.sources.map((source) => [source.id, source]));
  for (const source of candidateLock.sources) {
    const policySource = policySources.get(source.id);
    if (!policySource) throw new Error(`Archive policy is missing source ${source.id}`);
    const archivePolicy = validateArchivePolicy(policySource.archive, source.id);
    const currentAssets = currentSources.get(source.id)?.assets;
    if (!Array.isArray(currentAssets)) return false;

    for (const asset of source.assets ?? []) {
      const key = byteObjectKey(source.id, asset);
      const matches = currentAssets.filter(
        (currentAsset) => byteObjectKey(source.id, currentAsset) === key,
      );
      if (matches.length === 0) return false;
      const descriptors = matches
        .filter(
          (currentAsset) =>
            currentAsset.archive?.repository === archivePolicy.repository,
        )
        .map((currentAsset) =>
          validateArchiveDescriptor(currentAsset.archive, {
            repository: archivePolicy.repository,
            size: asset.size,
            sha256: asset.sha256,
          }),
        );
      if (descriptors.length === 0) return false;
      if (
        new Set(descriptors.map((descriptor) => descriptorSignature(descriptor))).size !== 1
      ) {
        throw new Error(`Conflicting archive descriptors for ${source.id}`);
      }
    }
  }
  return true;
}

export const ARCHIVE_CONTRACT = Object.freeze({
  repository: ARCHIVE_REPOSITORY,
  assetNameTemplate: ASSET_NAME_TEMPLATE,
});
