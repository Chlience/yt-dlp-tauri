const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[0-9]{8}\.[1-9][0-9]*$/u;
const SUPPORTED_EVIDENCE = [
  "binary-release",
  "build-revision",
  "official-checksum",
  "source-license",
  "source-revision",
  "third-party-notices",
];

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

function sortedUnique(values, label) {
  const normalized = values.map((value) => requireString(value, label)).sort();
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1] === normalized[index]) {
      throw new Error(`Duplicate ${label}: ${normalized[index]}`);
    }
  }
  return normalized;
}

function sameStrings(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validAssetIdentity(asset) {
  return (
    asset &&
    typeof asset === "object" &&
    validHttpsUrl(asset.sourceUrl) &&
    Number.isSafeInteger(asset.size) &&
    asset.size > 0 &&
    SHA256_PATTERN.test(asset.sha256 ?? "")
  );
}

function validChecksumEvidence(source) {
  const provenance = source.redistribution?.provenance;
  return source.assets.every(
    (asset) =>
      validHttpsUrl(asset.checksumUrl) ||
      (validHttpsUrl(provenance?.checksumUrl) &&
        SHA256_PATTERN.test(provenance?.checksumSha256 ?? "")),
  );
}

function revisionValue(source, kind) {
  const provenance = source.redistribution?.provenance ?? {};
  if (kind === "source-revision") {
    return provenance.sourceRevision ?? provenance.ffmpegSourceRevision ?? null;
  }
  return provenance.buildRevision ?? provenance.buildRepositoryRevision ?? null;
}

function validRevisionEvidence(source, kind) {
  const explicit = revisionValue(source, kind);
  if (typeof explicit === "string" && explicit.trim() !== "") return true;
  if (kind === "source-revision" && source.adapter === "github-release") {
    return (
      typeof source.version === "string" &&
      source.version.trim() !== "" &&
      source.assets.every(
        (asset) =>
          typeof asset.releaseTag === "string" &&
          asset.releaseTag.trim() !== "" &&
          validHttpsUrl(asset.releaseUrl),
      )
    );
  }
  return false;
}

function fileEvidence(paths, files) {
  if (paths.length === 0) return { satisfied: false, files: [] };
  const evidence = paths.map((path) => {
    const file = files[path];
    const valid =
      file &&
      Number.isSafeInteger(file.size) &&
      file.size > 0 &&
      SHA256_PATTERN.test(file.sha256 ?? "");
    return {
      path,
      size: valid ? file.size : null,
      sha256: valid ? file.sha256 : null,
      present: Boolean(valid),
    };
  });
  return { satisfied: evidence.every((item) => item.present), files: evidence };
}

function evidenceResult(id, policySource, lockSource, files) {
  if (id === "binary-release") {
    return {
      id,
      satisfied:
        Array.isArray(lockSource.assets) &&
        lockSource.assets.length > 0 &&
        lockSource.assets.every(validAssetIdentity),
    };
  }
  if (id === "official-checksum") {
    return {
      id,
      satisfied:
        Array.isArray(lockSource.assets) &&
        lockSource.assets.length > 0 &&
        validChecksumEvidence(lockSource),
    };
  }
  if (id === "source-revision" || id === "build-revision") {
    const value = revisionValue(lockSource, id);
    return {
      id,
      satisfied: validRevisionEvidence(lockSource, id),
      ...(typeof value === "string" && value.trim() !== "" ? { value } : {}),
    };
  }
  const paths = sortedUnique(
    id === "source-license"
      ? requireArray(policySource.redistribution.licenseFiles, `${policySource.id} license files`)
      : requireArray(policySource.redistribution.noticeFiles, `${policySource.id} notice files`),
    `${policySource.id} redistribution path`,
  );
  return { id, ...fileEvidence(paths, files) };
}

export function createComplianceReport({ policy: policyValue, lock: lockValue, files = {} }) {
  const policy = requireObject(policyValue, "Toolchain policy");
  const lock = requireObject(lockValue, "Toolchain lock");
  const revision = requireString(lock.revision, "Toolchain lock revision");
  if (!REVISION_PATTERN.test(revision)) throw new Error(`Invalid toolchain revision: ${revision}`);
  const policySources = requireArray(policy.sources, "Toolchain policy sources");
  const lockSources = requireArray(lock.sources, "Toolchain lock sources");
  const policyIds = sortedUnique(
    policySources.map((source) => source?.id),
    "policy source ID",
  );
  const lockIds = sortedUnique(
    lockSources.map((source) => source?.id),
    "lock source ID",
  );
  if (!sameStrings(policyIds, lockIds)) {
    throw new Error("Toolchain policy and lock source IDs do not match");
  }
  const policyById = new Map(policySources.map((source) => [source.id, source]));
  const lockById = new Map(lockSources.map((source) => [source.id, source]));
  const normalizedFiles = requireObject(files, "Compliance file evidence");
  const sources = policyIds.map((id) => {
    const policySource = requireObject(policyById.get(id), `Policy source ${id}`);
    const lockSource = requireObject(lockById.get(id), `Lock source ${id}`);
    const redistribution = requireObject(
      policySource.redistribution,
      `Policy source ${id} redistribution`,
    );
    const required = sortedUnique(
      requireArray(redistribution.requiredEvidence, `${id} required evidence`),
      `${id} required evidence`,
    );
    for (const evidence of required) {
      if (!SUPPORTED_EVIDENCE.includes(evidence)) {
        throw new Error(`Unsupported ${id} required evidence: ${evidence}`);
      }
    }
    const evidence = required.map((item) =>
      evidenceResult(item, policySource, lockSource, normalizedFiles),
    );
    return {
      id,
      passed: evidence.every((item) => item.satisfied),
      evidence,
    };
  });
  return {
    schemaVersion: 1,
    revision,
    passed: sources.every((source) => source.passed),
    sources,
  };
}

export function canonicalComplianceJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
