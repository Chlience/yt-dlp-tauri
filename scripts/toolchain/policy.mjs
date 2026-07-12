import { readFileSync } from "node:fs";

import { validateArchivePolicy } from "./archive-contract.mjs";

const SOURCE_ADAPTERS = new Set(["github-release"]);
const SOURCE_SELECTIONS = new Set([
  "latest-stable",
  "previous-complete-month",
]);
const ASSET_KINDS = new Set(["file", "zip"]);
const REDISTRIBUTION_FIELDS = [
  "licenseFiles",
  "requiredEvidence",
  "noticeFiles",
];
const REDISTRIBUTION_EVIDENCE = new Set([
  "official-checksum",
  "binary-release",
  "source-revision",
  "build-revision",
  "source-license",
  "third-party-notices",
]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const normalized = values.map((value, index) =>
    requireNonEmptyString(value, `${label}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate values`);
  }
  return normalized;
}

function requireSafeRelativePaths(values, label) {
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array`);
  }
  const normalized = values.map((value, index) => {
    const path = requireNonEmptyString(value, `${label}[${index}]`);
    const segments = path.replaceAll("\\", "/").split("/");
    if (
      path.startsWith("/") ||
      /^[A-Za-z]:/u.test(path) ||
      path.includes("\\") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`${label}[${index}] must be a safe relative path`);
    }
    return path;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate values`);
  }
  return normalized;
}

function validateMember(memberValue, sourceId, assetIndex, memberIndex, target, kind) {
  const member = requireObject(
    memberValue,
    `source ${sourceId} asset ${assetIndex} member ${memberIndex}`,
  );
  member.tool = requireNonEmptyString(member.tool, `source ${sourceId} member tool`);
  member.path = requireNonEmptyString(member.path, `source ${sourceId} member path`);
  const expectedPrefix = `Tools/${target}/`;
  if (!member.path.replaceAll("\\", "/").startsWith(expectedPrefix)) {
    throw new Error(`source ${sourceId} member path must start with ${expectedPrefix}`);
  }
  if (kind === "zip") {
    member.archivePathSuffix = requireNonEmptyString(
      member.archivePathSuffix,
      `source ${sourceId} member archivePathSuffix`,
    );
  } else if (member.archivePathSuffix !== undefined) {
    throw new Error(`source ${sourceId} file member cannot define archivePathSuffix`);
  }
  member.licenseNotes = requireNonEmptyString(
    member.licenseNotes,
    `source ${sourceId} member licenseNotes`,
  );
  return member;
}

function validateAsset(assetValue, source, assetIndex, targets) {
  const asset = requireObject(assetValue, `source ${source.id} asset ${assetIndex}`);
  asset.target = requireNonEmptyString(asset.target, `source ${source.id} asset target`);
  if (!targets.has(asset.target)) {
    throw new Error(`source ${source.id} uses unknown target ${asset.target}`);
  }
  asset.kind = requireNonEmptyString(asset.kind, `source ${source.id} asset kind`);
  if (!ASSET_KINDS.has(asset.kind)) {
    throw new Error(`source ${source.id} uses unsupported asset kind ${asset.kind}`);
  }

  const hasName = typeof asset.assetName === "string" && asset.assetName.trim() !== "";
  const hasPattern = typeof asset.assetPattern === "string" && asset.assetPattern.trim() !== "";
  if (hasName === hasPattern) {
    throw new Error(`source ${source.id} asset must define exactly one assetName or assetPattern`);
  }
  if (hasName) asset.assetName = asset.assetName.trim();
  if (hasPattern) {
    asset.assetPattern = asset.assetPattern.trim();
    try {
      new RegExp(asset.assetPattern);
    } catch (error) {
      throw new Error(`source ${source.id} has invalid assetPattern: ${error}`);
    }
  }

  if (!Array.isArray(asset.members) || asset.members.length === 0) {
    throw new Error(`source ${source.id} asset members must be a non-empty array`);
  }
  asset.members = asset.members.map((member, memberIndex) =>
    validateMember(member, source.id, assetIndex, memberIndex, asset.target, asset.kind),
  );
  return asset;
}

function validateRedistribution(value, sourceId) {
  const redistribution = requireObject(value, `source ${sourceId} redistribution`);
  const unknown = Object.keys(redistribution).filter(
    (field) => !REDISTRIBUTION_FIELDS.includes(field),
  );
  if (unknown.length > 0) {
    throw new Error(
      `source ${sourceId} redistribution has unknown fields: ${unknown.join(", ")}`,
    );
  }
  const licenseFiles = requireSafeRelativePaths(
    redistribution.licenseFiles,
    `source ${sourceId} redistribution licenseFiles`,
  );
  const noticeFiles = requireSafeRelativePaths(
    redistribution.noticeFiles,
    `source ${sourceId} redistribution noticeFiles`,
  );
  const requiredEvidence = requireUniqueStrings(
    redistribution.requiredEvidence,
    `source ${sourceId} redistribution requiredEvidence`,
  );
  for (const evidence of requiredEvidence) {
    if (!REDISTRIBUTION_EVIDENCE.has(evidence)) {
      throw new Error(
        `source ${sourceId} uses unknown redistribution evidence ${evidence}`,
      );
    }
  }
  return { licenseFiles, requiredEvidence, noticeFiles };
}

export function validateToolchainPolicy(value) {
  const policy = requireObject(value, "toolchain policy");
  if (policy.schemaVersion !== 2) {
    throw new Error("toolchain-policy.json schemaVersion must be 2");
  }

  policy.targets = requireUniqueStrings(policy.targets, "toolchain policy targets");
  policy.approvedHosts = requireUniqueStrings(
    policy.approvedHosts,
    "toolchain policy approvedHosts",
  );
  const targets = new Set(policy.targets);

  if (!Array.isArray(policy.sources) || policy.sources.length === 0) {
    throw new Error("toolchain policy sources must be a non-empty array");
  }

  const sourceIds = new Set();
  policy.sources = policy.sources.map((sourceValue, sourceIndex) => {
    const source = requireObject(sourceValue, `toolchain source ${sourceIndex}`);
    source.id = requireNonEmptyString(source.id, `toolchain source ${sourceIndex} id`);
    if (sourceIds.has(source.id)) {
      throw new Error(`duplicate source id ${source.id}`);
    }
    sourceIds.add(source.id);

    source.adapter = requireNonEmptyString(source.adapter, `source ${source.id} adapter`);
    if (!SOURCE_ADAPTERS.has(source.adapter)) {
      throw new Error(`source ${source.id} uses unsupported adapter ${source.adapter}`);
    }
    source.selection = requireNonEmptyString(source.selection, `source ${source.id} selection`);
    if (!SOURCE_SELECTIONS.has(source.selection)) {
      throw new Error(`source ${source.id} uses unsupported selection ${source.selection}`);
    }

    source.repository = requireNonEmptyString(
      source.repository,
      `source ${source.id} repository`,
    );
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository)) {
      throw new Error(`source ${source.id} has invalid GitHub repository`);
    }
    source.archive = validateArchivePolicy(source.archive, source.id);
    source.redistribution = validateRedistribution(source.redistribution, source.id);
    if (!Array.isArray(source.assets) || source.assets.length === 0) {
      throw new Error(`source ${source.id} assets must be a non-empty array`);
    }
    source.assets = source.assets.map((asset, assetIndex) =>
      validateAsset(asset, source, assetIndex, targets),
    );
    return source;
  });

  return policy;
}

export function readToolchainPolicy(path) {
  return validateToolchainPolicy(JSON.parse(readFileSync(path, "utf8")));
}

export function sourceById(policy, id) {
  const source = policy.sources.find((candidate) => candidate.id === id);
  if (!source) {
    throw new Error(`Unknown toolchain source: ${id}`);
  }
  return source;
}
