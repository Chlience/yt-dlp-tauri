import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ARCHIVE_REPOSITORY = "Chlience/yt-dlp-tauri-toolchain";
const SOURCE_REPOSITORY = "Chlience/yt-dlp-tauri";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const DEFAULTS = {
  policyPath: "toolchain-policy.json",
  lockPath: "toolchain-lock.json",
  manifestPath: "src-tauri/tools-manifest.json",
  candidateIndexPath: ".toolchain/candidate/candidate-assets.json",
  handoffPath: ".toolchain/handoff/handoff-report.json",
  validationPath: ".toolchain/validation/toolchain-validation.json",
  compliancePath: ".toolchain/publication/toolchain-compliance.json",
  stableReleasePath: ".toolchain/remote/stable-release.json",
  applicationReleasePath: ".toolchain/remote/application-release.json",
  revisionReleasePath: ".toolchain/remote/revision-release.json",
  historicalReleasesPath: ".toolchain/remote/historical-releases.json",
  outputDirectory: ".toolchain/publication",
  outputPath: ".toolchain/publication/publication-input.json",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

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

function metadataDescriptor(category, name, path, bytes, extra = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new Error(`${category} metadata bytes are invalid`);
  }
  const content = Buffer.from(bytes);
  if (content.length === 0) throw new Error(`${category} metadata must not be empty`);
  return {
    category,
    name,
    path,
    size: content.length,
    sha256: sha256(content),
    ...extra,
  };
}

function evidencePaths(policy) {
  const categories = new Map();
  for (const source of policy.sources ?? []) {
    for (const path of source.redistribution?.licenseFiles ?? []) {
      categories.set(path, "license");
    }
    for (const path of source.redistribution?.noticeFiles ?? []) {
      if (!categories.has(path)) categories.set(path, "notice");
    }
  }
  return [...categories.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function proposedAssets(lock) {
  const releaseTag = `toolchain-${lock.revision}`;
  const assets = new Map();
  const changedSources = new Set();
  for (const source of lock.sources ?? []) {
    for (const asset of source.assets ?? []) {
      if (asset.archive?.releaseTag !== releaseTag) continue;
      changedSources.add(source.id);
      const descriptor = asset.archive;
      const existing = assets.get(descriptor.assetName);
      const normalized = {
        name: descriptor.assetName,
        size: descriptor.size,
        sha256: descriptor.sha256,
      };
      if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) {
        throw new Error(`Conflicting proposed archive asset ${descriptor.assetName}`);
      }
      assets.set(descriptor.assetName, normalized);
    }
  }
  return {
    assets: [...assets.values()].sort((left, right) => left.name.localeCompare(right.name)),
    changedSources: [...changedSources].sort(),
  };
}

function provenanceRecord({ lock, handoff, lockSha256 }) {
  return {
    schemaVersion: 1,
    revision: lock.revision,
    sourceRepository: SOURCE_REPOSITORY,
    mergeCommitSha: handoff.mergeCommitSha,
    pullRequestNumber: handoff.pullRequestNumber,
    pullRequestHeadSha: handoff.headSha,
    validationRunId: handoff.runId,
    lockSha256,
    sources: (lock.sources ?? []).map((source) => ({
      id: source.id,
      adapter: source.adapter,
      version: source.version,
      repository: source.repository ?? null,
      redistribution: source.redistribution ?? null,
      assets: (source.assets ?? []).map((asset) => ({
        target: asset.target,
        sourceUrl: asset.sourceUrl,
        size: asset.size,
        sha256: asset.sha256,
        releaseId: asset.releaseId,
        assetId: asset.assetId,
        releaseTag: asset.releaseTag,
        checksumUrl: asset.checksumUrl ?? null,
        archive: asset.archive,
      })),
    })),
  };
}

function normalizeCandidateFiles(index, revision) {
  if (index.revision !== revision) throw new Error("Candidate index revision does not match");
  return requireArray(index.assets, "Candidate index assets").map((asset) => {
    if (
      asset.path !== `assets/${asset.sha256}` ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !SHA256_PATTERN.test(asset.sha256 ?? "")
    ) {
      throw new Error("Candidate index contains an invalid byte object");
    }
    return { path: asset.path, size: asset.size, sha256: asset.sha256 };
  });
}

export function buildPublicationMetadata({
  policy,
  lock,
  manifestBytes,
  validationBytes,
  compliance,
  handoff,
  evidenceFiles,
  outputDirectory,
}) {
  requireObject(policy, "Toolchain policy");
  requireObject(lock, "Toolchain lock");
  requireObject(compliance, "Toolchain compliance report");
  requireObject(handoff, "Artifact handoff");
  if (compliance.revision !== lock.revision || compliance.passed !== true) {
    throw new Error("Toolchain compliance report does not approve publication");
  }
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  const validation = JSON.parse(Buffer.from(validationBytes).toString("utf8"));
  const files = new Map();
  const metadata = [];
  const add = (category, name, bytes, extra = {}) => {
    if (files.has(name)) throw new Error(`Duplicate publication metadata asset ${name}`);
    const path = join(outputDirectory, name).replaceAll("\\", "/");
    const content = Buffer.from(bytes);
    files.set(name, content);
    metadata.push(metadataDescriptor(category, name, path, content, extra));
  };

  add("manifest", `tools-manifest-${lock.revision}.json`, manifestBytes, { value: manifest });
  add("validation", `toolchain-validation-${lock.revision}.json`, validationBytes, {
    report: validation,
  });
  add(
    "compliance",
    `toolchain-compliance-${lock.revision}.json`,
    jsonBytes(compliance),
    { value: compliance },
  );
  const lockSha256 = handoff.lockSha256;
  if (!SHA256_PATTERN.test(lockSha256 ?? "")) {
    throw new Error("Artifact handoff lock SHA-256 is invalid");
  }
  const provenance = provenanceRecord({ lock, handoff, lockSha256 });
  add(
    "provenance",
    `toolchain-provenance-${lock.revision}.json`,
    jsonBytes(provenance),
    { value: provenance },
  );
  const usedEvidenceNames = new Map();
  for (const [sourcePath, category] of evidencePaths(policy)) {
    const bytes = evidenceFiles.get(sourcePath);
    if (!bytes) throw new Error(`Missing publication evidence file ${sourcePath}`);
    const name = basename(sourcePath);
    const previous = usedEvidenceNames.get(name);
    if (previous && previous !== sourcePath) {
      throw new Error(`Publication evidence assets share the name ${name}`);
    }
    usedEvidenceNames.set(name, sourcePath);
    if (!files.has(name)) add(category, name, bytes);
  }
  const proposed = proposedAssets(lock);
  const checksumEntries = [
    ...proposed.assets.map((asset) => ({ name: asset.name, sha256: asset.sha256 })),
    ...metadata.map((asset) => ({ name: asset.name, sha256: asset.sha256 })),
  ].sort((left, right) => left.name.localeCompare(right.name));
  for (let index = 1; index < checksumEntries.length; index += 1) {
    if (checksumEntries[index - 1].name === checksumEntries[index].name) {
      throw new Error(`Duplicate checksum entry ${checksumEntries[index].name}`);
    }
  }
  const checksums = Buffer.from(
    checksumEntries.map((entry) => `${entry.sha256}  ${entry.name}\n`).join(""),
    "utf8",
  );
  add("checksums", `toolchain-checksums-${lock.revision}.txt`, checksums);
  return { files, metadata, changedSources: proposed.changedSources };
}

export function parsePreparePublicationArgs(argv) {
  const result = { ...DEFAULTS };
  const flags = new Map([
    ["--policy", "policyPath"],
    ["--lock", "lockPath"],
    ["--manifest", "manifestPath"],
    ["--candidate-index", "candidateIndexPath"],
    ["--handoff", "handoffPath"],
    ["--validation", "validationPath"],
    ["--compliance", "compliancePath"],
    ["--stable-release", "stableReleasePath"],
    ["--application-release", "applicationReleasePath"],
    ["--revision-release", "revisionReleasePath"],
    ["--historical-releases", "historicalReleasesPath"],
    ["--directory", "outputDirectory"],
    ["--output", "outputPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const property = flags.get(flag);
    if (!property) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    result[property] = value;
    index += 1;
  }
  return result;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read ${label} from ${path}: ${error}`);
  }
}

export async function prepareToolchainPublication(options = {}) {
  const args = { ...DEFAULTS, ...options };
  const [policy, lock, candidateIndex, handoff, compliance, stableRelease, applicationRelease, revisionRelease, historicalReleases] =
    await Promise.all([
      readJson(args.policyPath, "toolchain policy"),
      readJson(args.lockPath, "toolchain lock"),
      readJson(args.candidateIndexPath, "candidate index"),
      readJson(args.handoffPath, "artifact handoff"),
      readJson(args.compliancePath, "compliance report"),
      readJson(args.stableReleasePath, "stable release"),
      readJson(args.applicationReleasePath, "application release"),
      readJson(args.revisionReleasePath, "revision release"),
      readJson(args.historicalReleasesPath, "historical releases"),
    ]);
  const [lockBytes, manifestBytes, validationBytes] = await Promise.all([
    readFile(args.lockPath),
    readFile(args.manifestPath),
    readFile(args.validationPath),
  ]);
  const evidenceFiles = new Map();
  for (const [path] of evidencePaths(policy)) evidenceFiles.set(path, await readFile(path));
  const generated = buildPublicationMetadata({
    policy,
    lock,
    manifestBytes,
    validationBytes,
    compliance,
    handoff,
    evidenceFiles,
    outputDirectory: args.outputDirectory,
  });
  await mkdir(args.outputDirectory, { recursive: true });
  await Promise.all(
    [...generated.files.entries()].map(([name, bytes]) =>
      writeFile(join(args.outputDirectory, name), bytes),
    ),
  );
  const input = {
    mode: "publish",
    sourceRepository: SOURCE_REPOSITORY,
    archiveRepository: ARCHIVE_REPOSITORY,
    revision: lock.revision,
    commitSha: handoff.mergeCommitSha,
    handoff,
    lock: { sha256: sha256(lockBytes), value: lock },
    candidateFiles: normalizeCandidateFiles(candidateIndex, lock.revision),
    historicalReleases: requireArray(historicalReleases, "Historical releases").map(
      (release) => ({ ...release, repository: ARCHIVE_REPOSITORY }),
    ),
    revisionRelease:
      revisionRelease === null
        ? null
        : { ...revisionRelease, repository: ARCHIVE_REPOSITORY },
    stableRelease: { ...stableRelease, repository: ARCHIVE_REPOSITORY },
    applicationRelease: { ...applicationRelease, repository: SOURCE_REPOSITORY },
    metadata: generated.metadata,
    changedSources: generated.changedSources,
  };
  await mkdir(dirname(args.outputPath), { recursive: true });
  await writeFile(args.outputPath, jsonBytes(input));
  return input;
}

export async function main(argv = process.argv.slice(2)) {
  const input = await prepareToolchainPublication(parsePreparePublicationArgs(argv));
  process.stdout.write(
    `${JSON.stringify({ revision: input.revision, metadata: input.metadata.length })}\n`,
  );
  return input;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
