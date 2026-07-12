import {
  archiveReleaseTag,
  validateArchiveDescriptor,
} from "./archive-contract.mjs";
import {
  compareToolchainRevisions,
  parseChannelRecord,
  renderChannelRecord,
} from "./channel.mjs";
import { validatePublicationReport } from "./validation-report.mjs";

const ARCHIVE_REPOSITORY = "Chlience/yt-dlp-tauri-toolchain";
const SOURCE_REPOSITORY = "Chlience/yt-dlp-tauri";
const REVISION_PATTERN = /^[0-9]{8}\.[1-9][0-9]*$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REQUIRED_METADATA_CATEGORIES = [
  "manifest",
  "validation",
  "compliance",
  "provenance",
  "checksums",
];
const OPTIONAL_METADATA_CATEGORIES = ["license", "notice", "evidence"];

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireIdentifier(value, label) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) return value;
  throw new Error(`${label} must be a positive integer`);
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireRevision(value, label = "Toolchain revision") {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    throw new Error(`${label} is invalid: ${value}`);
  }
  return value;
}

function requireCommit(value, label) {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character commit SHA`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireRepository(value, expected, label) {
  const repository = requireString(value, label);
  if (repository !== expected) throw new Error(`${label} must be ${expected}`);
  return repository;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function compareStrings(left, right) {
  return String(left).localeCompare(String(right));
}

function safeRelativePath(value, label) {
  const path = requireString(value, label).replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:\//u.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return path;
}

function normalizeFileDescriptor(value, label) {
  const file = requireObject(value, label);
  return {
    name: requireString(file.name, `${label} name`),
    path: safeRelativePath(file.path, `${label} path`),
    size: requirePositiveInteger(file.size, `${label} size`),
    sha256: requireSha256(file.sha256, `${label} SHA-256`),
  };
}

function publicDescriptor(value) {
  return { name: value.name, size: value.size, sha256: value.sha256 };
}

function descriptorKey(descriptor) {
  return `${descriptor.releaseTag}\0${descriptor.assetName}`;
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

function lockDescriptors(lockValue) {
  const lock = requireObject(lockValue, "Toolchain lock");
  if (!Array.isArray(lock.sources)) throw new Error("Toolchain lock sources must be an array");
  const descriptors = new Map();
  for (const source of lock.sources) {
    const sourceId = requireString(source?.id, "Toolchain lock source ID");
    if (!Array.isArray(source.assets)) {
      throw new Error(`Toolchain lock source ${sourceId} assets must be an array`);
    }
    for (const asset of source.assets) {
      const sourceSize = requirePositiveInteger(
        asset?.size,
        `${sourceId} source asset size`,
      );
      const sourceSha256 = requireSha256(
        asset?.sha256,
        `${sourceId} source asset SHA-256`,
      );
      const descriptor = validateArchiveDescriptor(asset?.archive, {
        repository: ARCHIVE_REPOSITORY,
        size: sourceSize,
        sha256: sourceSha256,
      });
      const key = descriptorKey(descriptor);
      const existing = descriptors.get(key);
      if (existing && descriptorSignature(existing) !== descriptorSignature(descriptor)) {
        throw new Error(`Conflicting archive descriptor for ${descriptor.releaseTag}/${descriptor.assetName}`);
      }
      descriptors.set(key, descriptor);
    }
  }
  if (descriptors.size === 0) throw new Error("Toolchain lock has no archive descriptors");
  return [...descriptors.values()].sort(
    (left, right) =>
      compareStrings(left.releaseTag, right.releaseTag) ||
      compareStrings(left.assetName, right.assetName),
  );
}

function candidateFilesByDigest(values) {
  const files = requireArray(values, "Candidate files").map((value) => {
    const file = requireObject(value, "Candidate byte object");
    const sha256 = requireSha256(file.sha256, "Candidate byte object SHA-256");
    const path = safeRelativePath(file.path, "Candidate byte object path");
    if (path !== `assets/${sha256}`) {
      throw new Error(`Candidate byte object path must be assets/${sha256}`);
    }
    return {
      path,
      size: requirePositiveInteger(file.size, "Candidate byte object size"),
      sha256,
    };
  });
  const byDigest = new Map();
  for (const file of files) {
    const matches = byDigest.get(file.sha256) ?? [];
    matches.push(file);
    byDigest.set(file.sha256, matches);
  }
  return byDigest;
}

function normalizeReleaseAsset(value, releaseTag, repository, label) {
  const asset = requireObject(value, label);
  const id = requireIdentifier(asset.id, `${label} ID`);
  const name = requireString(asset.name, `${label} name`);
  const size = requirePositiveInteger(asset.size, `${label} size`);
  const digestMatch = String(asset.digest ?? "").match(/^sha256:([a-f0-9]{64})$/u);
  if (!digestMatch) throw new Error(`${label} digest must be a lowercase SHA-256`);
  let url;
  try {
    url = new URL(asset.browser_download_url);
  } catch {
    throw new Error(`${label} download URL is invalid`);
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
    throw new Error(`${label} download URL does not match its immutable release`);
  }
  return { id, name, size, sha256: digestMatch[1], url: url.href };
}

function normalizeImmutableRelease(value, expectedTag, label) {
  const release = requireObject(value, label);
  requireRepository(release.repository, ARCHIVE_REPOSITORY, `${label} repository`);
  if (
    release.tag_name !== expectedTag ||
    release.draft !== false ||
    typeof release.prerelease !== "boolean" ||
    release.immutable !== true
  ) {
    throw new Error(`${label} must be the exact published immutable historical release ${expectedTag}`);
  }
  const id = requireIdentifier(release.id, `${label} ID`);
  const assets = requireArray(release.assets, `${label} assets`).map((asset) =>
    normalizeReleaseAsset(asset, expectedTag, ARCHIVE_REPOSITORY, `${label} asset`),
  );
  const names = new Set();
  for (const asset of assets) {
    if (names.has(asset.name)) throw new Error(`${label} has duplicate asset ${asset.name}`);
    names.add(asset.name);
  }
  return { ...release, id, assets };
}

function normalizeRevisionRelease(value, expectedTag) {
  const release = requireObject(value, "Archive revision release");
  requireRepository(
    release.repository,
    ARCHIVE_REPOSITORY,
    "Archive revision release repository",
  );
  if (release.tag_name !== expectedTag) {
    throw new Error(`Archive revision release must use ${expectedTag}`);
  }
  const state =
    release.draft === true &&
    release.prerelease === false &&
    release.immutable === false
      ? "draft"
      : release.draft === false &&
          release.prerelease === false &&
          release.immutable === true
        ? "published"
        : null;
  if (!state) {
    throw new Error(
      `Archive revision release ${expectedTag} must be a resumable draft or normal immutable publication`,
    );
  }
  const assets =
    state === "published"
      ? requireArray(release.assets, "Archive revision release assets").map((asset) =>
          normalizeReleaseAsset(
            asset,
            expectedTag,
            ARCHIVE_REPOSITORY,
            "Archive revision release asset",
          ),
        )
      : [];
  return {
    state,
    id: requireIdentifier(release.id, "Archive revision release ID"),
    tag_name: expectedTag,
    name: requireString(release.name, "Archive revision release name"),
    body: typeof release.body === "string" ? release.body : "",
    assets,
  };
}

function immutableReleaseMap(values) {
  const releases = new Map();
  for (const value of requireArray(values, "Historical releases")) {
    const tag = requireString(value?.tag_name, "Historical release tag");
    if (releases.has(tag)) throw new Error(`Duplicate historical release ${tag}`);
    releases.set(tag, normalizeImmutableRelease(value, tag, "Archive descriptor immutable historical release"));
  }
  return releases;
}

function exactReleaseAsset(release, expected, label) {
  const matches = release.assets.filter((asset) => asset.name === expected.name);
  if (matches.length !== 1) {
    throw new Error(`${label} must exist exactly once on ${release.tag_name}`);
  }
  const asset = matches[0];
  if (asset.size !== expected.size) throw new Error(`${label} size does not match`);
  if (asset.sha256 !== expected.sha256) throw new Error(`${label} digest does not match`);
  return asset;
}

function requireStableRelease(value) {
  const release = requireObject(value, "Archive stable release");
  requireRepository(
    release.repository,
    ARCHIVE_REPOSITORY,
    "Archive stable release repository",
  );
  if (
    release.tag_name !== "toolchain-stable" ||
    release.draft !== false ||
    release.prerelease !== true ||
    release.immutable !== true
  ) {
    throw new Error("Archive stable release must be the published immutable channel");
  }
  return {
    ...release,
    id: requireIdentifier(release.id, "Archive stable release ID"),
    body: typeof release.body === "string" ? release.body : "",
  };
}

function requireApplicationRelease(value, sourceRepository) {
  const release = requireObject(value, "Application release");
  requireRepository(release.repository, sourceRepository, "Application release repository");
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error("Application release must be a published normal release");
  }
  return {
    ...release,
    id: requireIdentifier(release.id, "Application release ID"),
    tag_name: requireString(release.tag_name, "Application release tag"),
  };
}

function currentChannel(stableRelease) {
  if (!stableRelease.body.includes("<!-- toolchain-channel")) return null;
  const channel = parseChannelRecord(stableRelease.body);
  if (channel.schemaVersion !== 2) {
    throw new Error("Archive stable release must use channel schema 2");
  }
  return channel;
}

function normalizeHandoff(value, expected) {
  const handoff = requireObject(value, "Artifact handoff");
  if (
    handoff.schemaVersion !== 1 ||
    handoff.repository !== expected.sourceRepository ||
    handoff.revision !== expected.revision ||
    handoff.mergeCommitSha !== expected.commitSha ||
    handoff.lockSha256 !== expected.lockSha256
  ) {
    throw new Error("Artifact handoff does not match exact-main publication identity");
  }
  return {
    ...handoff,
    repositoryId: requireIdentifier(handoff.repositoryId, "Handoff repository ID"),
    pullRequestNumber: requirePositiveInteger(
      handoff.pullRequestNumber,
      "Handoff pull request number",
    ),
    headSha: requireCommit(handoff.headSha, "Handoff head SHA"),
    candidateArtifact: requireObject(handoff.candidateArtifact, "Handoff candidate artifact"),
  };
}

function candidateIdentity(handoff) {
  return {
    artifactName: requireString(
      handoff.candidateArtifact.name,
      "Handoff candidate artifact name",
    ),
    artifactId: requireIdentifier(
      handoff.candidateArtifact.id,
      "Handoff candidate artifact ID",
    ),
    artifactDigest: requireSha256(
      handoff.candidateArtifact.digest,
      "Handoff candidate artifact digest",
    ),
    repositoryId: handoff.repositoryId,
    pullRequestNumber: handoff.pullRequestNumber,
    headSha: handoff.headSha,
  };
}

function normalizeMetadata(values, revision) {
  const allowed = new Set([...REQUIRED_METADATA_CATEGORIES, ...OPTIONAL_METADATA_CATEGORIES]);
  const metadata = requireArray(values, "Publication metadata").map((value) => {
    const item = requireObject(value, "Publication metadata item");
    const category = requireString(item.category, "Publication metadata category");
    if (!allowed.has(category)) throw new Error(`Unsupported publication metadata category: ${category}`);
    return { ...item, category, ...normalizeFileDescriptor(item, `${category} metadata`) };
  });
  const names = new Set();
  const paths = new Set();
  for (const item of metadata) {
    if (names.has(item.name)) throw new Error(`Duplicate publication metadata name: ${item.name}`);
    if (paths.has(item.path)) throw new Error(`Duplicate publication metadata path: ${item.path}`);
    names.add(item.name);
    paths.add(item.path);
  }
  for (const category of REQUIRED_METADATA_CATEGORIES) {
    if (metadata.filter((item) => item.category === category).length !== 1) {
      throw new Error(
        `Publication metadata categories must include exactly one ${REQUIRED_METADATA_CATEGORIES.join(", ")}`,
      );
    }
  }
  const expectedNames = new Map([
    ["manifest", `tools-manifest-${revision}.json`],
    ["validation", `toolchain-validation-${revision}.json`],
    ["compliance", `toolchain-compliance-${revision}.json`],
    ["provenance", `toolchain-provenance-${revision}.json`],
    ["checksums", `toolchain-checksums-${revision}.txt`],
  ]);
  for (const item of metadata) {
    const expectedName = expectedNames.get(item.category);
    if (expectedName && item.name !== expectedName) {
      throw new Error(`${item.category} metadata name must be ${expectedName}`);
    }
  }
  const categoryOrder = new Map(
    [...REQUIRED_METADATA_CATEGORIES, ...OPTIONAL_METADATA_CATEGORIES].map((name, index) => [
      name,
      index,
    ]),
  );
  return metadata.sort(
    (left, right) =>
      categoryOrder.get(left.category) - categoryOrder.get(right.category) ||
      compareStrings(left.name, right.name),
  );
}

function metadataByCategory(metadata, category) {
  return metadata.find((item) => item.category === category);
}

function validatePublicationMetadata(metadata, context) {
  const manifest = metadataByCategory(metadata, "manifest");
  if (manifest.value?.revision !== context.revision) {
    throw new Error("Publication manifest revision does not match");
  }
  const validation = metadataByCategory(metadata, "validation");
  validatePublicationReport(validation.report, {
    revision: context.revision,
    commitSha: context.commitSha,
    manifestSha256: manifest.sha256,
    lockSha256: context.lockSha256,
    candidate: context.candidate,
  });
  const compliance = metadataByCategory(metadata, "compliance");
  if (
    compliance.value?.schemaVersion !== 1 ||
    compliance.value.revision !== context.revision ||
    compliance.value.passed !== true ||
    !Array.isArray(compliance.value.sources) ||
    compliance.value.sources.some(
      (source) =>
        typeof source?.id !== "string" ||
        source.passed !== true ||
        !Array.isArray(source.evidence) ||
        source.evidence.some((evidence) => evidence?.satisfied !== true),
    )
  ) {
    throw new Error("Publication compliance metadata must record a passing revision");
  }
  const complianceSourceIds = compliance.value.sources.map((source) => source.id).sort();
  if (JSON.stringify(complianceSourceIds) !== JSON.stringify([...context.sourceIds].sort())) {
    throw new Error("Publication compliance metadata source IDs do not match the lock");
  }
  const provenance = metadataByCategory(metadata, "provenance");
  if (
    provenance.value?.schemaVersion !== 1 ||
    provenance.value.revision !== context.revision
  ) {
    throw new Error("Publication provenance metadata must match the revision");
  }
  return { manifest, validation };
}

function releaseNotes({ revision, commitSha, handoff, lockSha256, manifestSha256, changedSources }) {
  const sources = requireArray(changedSources, "Changed sources").map((source) =>
    requireString(source, "Changed source"),
  );
  return [
    `# Toolchain ${revision}`,
    "",
    `- Source repository: ${SOURCE_REPOSITORY}`,
    `- Merged commit: ${commitSha}`,
    `- Pull request: #${handoff.pullRequestNumber}`,
    `- Pull request validation run: ${handoff.runId}`,
    `- Lock SHA-256: ${lockSha256}`,
    `- Manifest SHA-256: ${manifestSha256}`,
    `- Changed sources: ${sources.length > 0 ? sources.join(", ") : "none"}`,
    "",
  ].join("\n");
}

export function createArchivePublicationPlan(inputValue) {
  const input = requireObject(inputValue, "Archive publication input");
  const sourceRepository = requireRepository(
    input.sourceRepository,
    SOURCE_REPOSITORY,
    "Source repository",
  );
  const archiveRepository = requireRepository(
    input.archiveRepository,
    ARCHIVE_REPOSITORY,
    "Archive repository",
  );
  const revision = requireRevision(input.revision);
  const commitSha = requireCommit(input.commitSha, "Publication commit");
  const proposedTag = archiveReleaseTag(revision);
  const revisionRelease =
    input.revisionRelease === null || input.revisionRelease === undefined
      ? null
      : normalizeRevisionRelease(input.revisionRelease, proposedTag);
  const lockDescriptor = requireObject(input.lock, "Toolchain lock descriptor");
  const lockSha256 = requireSha256(lockDescriptor.sha256, "Toolchain lock SHA-256");
  const lock = requireObject(lockDescriptor.value, "Toolchain lock content");
  if (lock.revision !== revision) throw new Error("Toolchain lock revision does not match");
  const handoff = normalizeHandoff(input.handoff, {
    sourceRepository,
    revision,
    commitSha,
    lockSha256,
  });
  const descriptors = lockDescriptors(lock);
  const historicalReleases = immutableReleaseMap(input.historicalReleases);
  const candidateFiles = candidateFilesByDigest(input.candidateFiles);
  const reuse = [];
  const upload = [];
  const usedCandidateDigests = new Set();

  for (const descriptor of descriptors) {
    if (descriptor.releaseTag === proposedTag) {
      const matches = candidateFiles.get(descriptor.sha256) ?? [];
      if (
        matches.length !== 1 ||
        matches[0].size !== descriptor.size ||
        matches[0].path !== `assets/${descriptor.sha256}`
      ) {
        throw new Error(
          `Archive upload ${descriptor.assetName} requires exactly one matching candidate byte object`,
        );
      }
      usedCandidateDigests.add(descriptor.sha256);
      upload.push({
        kind: "upload",
        descriptor,
        path: matches[0].path,
      });
      continue;
    }
    const descriptorRevision = requireRevision(
      descriptor.releaseTag.slice("toolchain-".length),
      "Archive descriptor revision",
    );
    if (compareToolchainRevisions(descriptorRevision, revision) >= 0) {
      throw new Error(`Archive descriptor ${descriptor.assetName} does not precede ${revision}`);
    }
    const release = historicalReleases.get(descriptor.releaseTag);
    if (!release) {
      throw new Error(
        `Archive descriptor ${descriptor.assetName} requires one immutable historical release`,
      );
    }
    const asset = exactReleaseAsset(
      release,
      { name: descriptor.assetName, size: descriptor.size, sha256: descriptor.sha256 },
      `Historical archive asset ${descriptor.assetName}`,
    );
    reuse.push({
      kind: "reuse",
      descriptor,
      releaseId: release.id,
      assetId: asset.id,
    });
  }
  for (const digest of candidateFiles.keys()) {
    if (!usedCandidateDigests.has(digest)) {
      throw new Error(`Unexpected candidate byte object ${digest}`);
    }
  }

  reuse.sort((left, right) => compareStrings(descriptorKey(left.descriptor), descriptorKey(right.descriptor)));
  upload.sort((left, right) => compareStrings(left.descriptor.assetName, right.descriptor.assetName));
  const metadata = normalizeMetadata(input.metadata, revision);
  const { manifest } = validatePublicationMetadata(metadata, {
    revision,
    commitSha,
    lockSha256,
    candidate: candidateIdentity(handoff),
    sourceIds: lock.sources.map((source) => source.id),
  });
  const stableRelease = requireStableRelease(input.stableRelease);
  const promoted = currentChannel(stableRelease);
  if (promoted && compareToolchainRevisions(revision, promoted.revision) < 0) {
    throw new Error(
      `Toolchain revision ${revision} must be newer than the promoted revision ${promoted.revision}`,
    );
  }
  const applicationRelease = requireApplicationRelease(input.applicationRelease, sourceRepository);
  const channel = {
    schemaVersion: 2,
    repository: archiveRepository,
    revision,
    releaseTag: proposedTag,
    manifest: manifest.name,
    sha256: manifest.sha256,
  };
  if (
    promoted &&
    compareToolchainRevisions(revision, promoted.revision) === 0 &&
    JSON.stringify(promoted) !== JSON.stringify(channel)
  ) {
    throw new Error(`Toolchain revision ${revision} is already promoted with another channel`);
  }
  const metadataOperations = metadata.map((item) => ({
    kind: "metadata",
    category: item.category,
    asset: publicDescriptor(item),
    path: item.path,
  }));
  const requiredDraftAssets = [
    ...upload.map((operation) => ({
      name: operation.descriptor.assetName,
      size: operation.descriptor.size,
      sha256: operation.descriptor.sha256,
    })),
    ...metadata.map(publicDescriptor),
  ].sort((left, right) => compareStrings(left.name, right.name));
  for (let index = 1; index < requiredDraftAssets.length; index += 1) {
    if (requiredDraftAssets[index - 1].name === requiredDraftAssets[index].name) {
      throw new Error(`Duplicate draft release asset name: ${requiredDraftAssets[index].name}`);
    }
  }
  const draftRelease = {
    tag: proposedTag,
    name: `Toolchain ${revision}`,
    prerelease: false,
    makeLatest: false,
    body: releaseNotes({
      revision,
      commitSha,
      handoff,
      lockSha256,
      manifestSha256: manifest.sha256,
      changedSources: input.changedSources,
    }),
    existingId: revisionRelease?.state === "draft" ? revisionRelease.id : null,
  };
  if (
    revisionRelease &&
    (revisionRelease.name !== draftRelease.name || revisionRelease.body !== draftRelease.body)
  ) {
    throw new Error(`Archive revision release ${proposedTag} does not match this publication`);
  }
  if (revisionRelease?.state === "published") {
    if (revisionRelease.assets.length !== requiredDraftAssets.length) {
      throw new Error(`Archive revision release ${proposedTag} has unexpected assets`);
    }
    for (const descriptor of requiredDraftAssets) {
      exactReleaseAsset(
        revisionRelease,
        descriptor,
        `Archive revision asset ${descriptor.name}`,
      );
    }
  }

  return {
    schemaVersion: 1,
    mode: "publish",
    sourceRepository,
    archiveRepository,
    revision,
    releaseTag: proposedTag,
    commitSha,
    pullRequestNumber: handoff.pullRequestNumber,
    revisionState: revisionRelease?.state ?? "missing",
    draftRelease,
    operations: [
      ...reuse,
      ...upload,
      ...metadataOperations,
      { kind: "publish-release", releaseTag: proposedTag, requiredDraftAssets },
      {
        kind: "promote-channel",
        releaseId: stableRelease.id,
        channel,
        releaseBody: renderChannelRecord(stableRelease.body, channel),
      },
      {
        kind: "legacy-manifest",
        applicationReleaseId: applicationRelease.id,
        applicationReleaseTag: applicationRelease.tag_name,
        manifestSource: publicDescriptor(manifest),
        path: manifest.path,
        assetName: "tools-manifest.json",
      },
    ],
  };
}

function descriptorFromManifestTool(toolValue) {
  const tool = requireObject(toolValue, "Historical manifest tool");
  const size = requirePositiveInteger(tool.sourceSize, "Historical source size");
  const sha256 = requireSha256(tool.sourceSha256, "Historical source SHA-256");
  let url;
  try {
    url = new URL(tool.sourceUrl);
  } catch {
    throw new Error("Historical manifest source URL is invalid");
  }
  const prefix = `/${ARCHIVE_REPOSITORY}/releases/download/`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix)
  ) {
    throw new Error("Historical manifest source URL must use the archive repository");
  }
  const remainder = url.pathname.slice(prefix.length).split("/");
  if (remainder.length !== 2) throw new Error("Historical manifest source URL is invalid");
  let assetName;
  try {
    assetName = decodeURIComponent(remainder[1]);
  } catch {
    throw new Error("Historical manifest source asset name is invalid");
  }
  return validateArchiveDescriptor(
    {
      repository: ARCHIVE_REPOSITORY,
      releaseTag: remainder[0],
      assetName,
      size,
      sha256,
    },
    { repository: ARCHIVE_REPOSITORY, size, sha256 },
  );
}

function manifestDescriptors(manifestValue) {
  const manifest = requireObject(manifestValue, "Historical manifest");
  const descriptors = new Map();
  for (const target of requireArray(manifest.targets, "Historical manifest targets")) {
    for (const tool of requireArray(target?.tools, "Historical manifest target tools")) {
      const descriptor = descriptorFromManifestTool(tool);
      const key = descriptorKey(descriptor);
      const existing = descriptors.get(key);
      if (existing && descriptorSignature(existing) !== descriptorSignature(descriptor)) {
        throw new Error(`Historical manifest has conflicting descriptor ${key}`);
      }
      descriptors.set(key, descriptor);
    }
  }
  if (descriptors.size === 0) throw new Error("Historical manifest has no archive descriptors");
  return [...descriptors.values()];
}

function rollbackArtifactDescriptor(value, label, expectedName) {
  const descriptor = requireObject(value, label);
  const name = requireString(descriptor.name, `${label} name`);
  if (name !== expectedName) throw new Error(`${label} name must be ${expectedName}`);
  return {
    ...descriptor,
    name,
    size: requirePositiveInteger(descriptor.size, `${label} size`),
    sha256: requireSha256(descriptor.sha256, `${label} SHA-256`),
  };
}

export function createArchiveRollbackPlan(inputValue) {
  const input = requireObject(inputValue, "Archive rollback input");
  const sourceRepository = requireRepository(
    input.sourceRepository,
    SOURCE_REPOSITORY,
    "Source repository",
  );
  const archiveRepository = requireRepository(
    input.archiveRepository,
    ARCHIVE_REPOSITORY,
    "Archive repository",
  );
  const rollbackRevision = requireRevision(input.rollbackRevision, "Rollback revision");
  const currentCommitSha = requireCommit(input.currentCommitSha, "Rollback commit");
  const reason = requireString(input.reason, "Rollback reason");
  const actor = requireString(input.actor, "Rollback actor");
  const dryRun = requireBoolean(input.dryRun, "Rollback dry-run flag");
  const stableRelease = requireStableRelease(input.stableRelease);
  const promoted = currentChannel(stableRelease);
  if (!promoted) throw new Error("Rollback requires an initialized schema-2 channel");
  if (rollbackRevision === promoted.revision) {
    throw new Error(`Toolchain revision ${rollbackRevision} is already promoted`);
  }
  if (compareToolchainRevisions(rollbackRevision, promoted.revision) >= 0) {
    throw new Error("Rollback revision must be older than the promoted revision");
  }

  const expectedReleaseTag = archiveReleaseTag(rollbackRevision);
  let revisionRelease;
  try {
    revisionRelease = normalizeImmutableRelease(
      input.revisionRelease,
      expectedReleaseTag,
      "Rollback immutable revision release",
    );
  } catch (error) {
    throw new Error(`Rollback requires the exact immutable revision release: ${error.message}`);
  }
  const releases = immutableReleaseMap(input.historicalReleases);
  releases.set(expectedReleaseTag, revisionRelease);
  const manifest = rollbackArtifactDescriptor(
    input.manifest,
    "Historical manifest",
    `tools-manifest-${rollbackRevision}.json`,
  );
  if (manifest.value?.revision !== rollbackRevision) {
    throw new Error("Historical manifest revision does not match rollback revision");
  }
  exactReleaseAsset(revisionRelease, manifest, "Historical manifest");
  const validation = rollbackArtifactDescriptor(
    input.validation,
    "Historical validation",
    `toolchain-validation-${rollbackRevision}.json`,
  );
  exactReleaseAsset(revisionRelease, validation, "Historical validation");
  validatePublicationReport(validation.report, {
    revision: rollbackRevision,
    commitSha: validation.report?.commitSha,
    manifestSha256: manifest.sha256,
    lockSha256: validation.report?.lockSha256,
  });
  for (const descriptor of manifestDescriptors(manifest.value)) {
    const release = releases.get(descriptor.releaseTag);
    if (!release) {
      throw new Error(`Historical descriptor ${descriptor.assetName} has no immutable release`);
    }
    exactReleaseAsset(
      release,
      { name: descriptor.assetName, size: descriptor.size, sha256: descriptor.sha256 },
      `Historical archive asset ${descriptor.assetName}`,
    );
  }

  const skipRevalidation = input.skipRevalidation === true;
  if (skipRevalidation) {
    if (
      input.approval?.approved !== true ||
      input.approval?.environment !== "toolchain-rollback"
    ) {
      throw new Error("Skipping revalidation requires the protected rollback environment");
    }
  } else {
    const report = input.revalidation?.report;
    if (!report) throw new Error("Rollback native revalidation report is required");
    validatePublicationReport(report, {
      revision: rollbackRevision,
      commitSha: currentCommitSha,
      manifestSha256: manifest.sha256,
      lockSha256: validation.report.lockSha256,
    });
  }
  const applicationRelease = requireApplicationRelease(input.applicationRelease, sourceRepository);
  const channel = {
    schemaVersion: 2,
    repository: archiveRepository,
    revision: rollbackRevision,
    releaseTag: expectedReleaseTag,
    manifest: manifest.name,
    sha256: manifest.sha256,
  };
  return {
    schemaVersion: 1,
    mode: "rollback",
    sourceRepository,
    archiveRepository,
    revision: rollbackRevision,
    currentCommitSha,
    reason,
    actor,
    dryRun,
    revalidated: !skipRevalidation,
    operations: [
      {
        kind: "promote-channel",
        releaseId: stableRelease.id,
        channel,
        releaseBody: renderChannelRecord(stableRelease.body, channel),
      },
      {
        kind: "legacy-manifest",
        applicationReleaseId: applicationRelease.id,
        applicationReleaseTag: applicationRelease.tag_name,
        manifestSource: publicDescriptor(manifest),
        assetName: "tools-manifest.json",
      },
    ],
  };
}
