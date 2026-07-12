const SCHEMA_VERSION = 1;
const REQUIRED_TARGETS = ["macos-arm64", "macos-x64", "win-x64"];
const REQUIRED_TOOLS = ["deno", "ffmpeg", "ffprobe", "yt-dlp"];
const TARGET_ARCHITECTURES = new Map([
  ["macos-arm64", "arm64"],
  ["macos-x64", "x64"],
  ["win-x64", "x64"],
]);
const REVISION_PATTERN = /^[0-9]{8}\.[1-9][0-9]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;

export function createTargetReport(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Target report input must be an object");
  }
  const target = requireEnum(input.target, REQUIRED_TARGETS, "Target report target");
  const architecture = requireString(input.architecture, `${target} architecture`);
  const expectedArchitecture = TARGET_ARCHITECTURES.get(target);
  if (architecture !== expectedArchitecture) {
    throw new Error(`${target} architecture must be ${expectedArchitecture}`);
  }
  const checks = normalizeChecks(input.checks, target);
  const computedSuccess = Object.values(checks).every(Boolean);
  const success = requireBoolean(input.success, `${target} success`);
  if (success !== computedSuccess) {
    throw new Error(`${target} success must match its blocking checks`);
  }

  const tools = normalizeTools(input.tools, target);
  const assets = normalizeAssets(input.assets, target);
  const extractedHashes = normalizeExtractedHashes(input.extractedHashes, target);
  ensureSameValues(
    tools.map((tool) => tool.name),
    extractedHashes.map((hash) => hash.tool),
    `${target} tool and extracted hash names`,
  );

  const report = {
    schemaVersion: SCHEMA_VERSION,
    target,
    success,
    runner: {
      image: requireString(input.runnerImage, `${target} runner image`),
      architecture,
    },
    checks,
    tools,
    assets,
    extractedHashes,
    diagnostics: normalizeDiagnostics(input.diagnostics ?? [], target),
  };
  if (input.canary !== undefined) report.canary = normalizeCanary(input.canary);
  return report;
}

export function mergeTargetReports(reports, context) {
  const normalizedReports = requireArray(reports, "Target reports").map((report) =>
    normalizeExistingTargetReport(report),
  );
  ensureUnique(normalizedReports, (report) => report.target, "target report");
  ensureSameValues(
    normalizedReports.map((report) => report.target),
    REQUIRED_TARGETS,
    "Native validation targets",
  );
  normalizedReports.sort((left, right) => left.target.localeCompare(right.target));

  const normalizedContext = normalizeContext(context);
  const merged = {
    schemaVersion: SCHEMA_VERSION,
    revision: normalizedContext.revision,
    commitSha: normalizedContext.commitSha,
    manifestSha256: normalizedContext.manifestSha256,
    lockSha256: normalizedContext.lockSha256,
    runId: normalizedContext.runId,
    runUrl: normalizedContext.runUrl,
  };
  if (normalizedContext.candidate) merged.candidate = normalizedContext.candidate;
  merged.targets = normalizedReports;
  if (normalizedContext.canary) merged.canary = normalizedContext.canary;
  return merged;
}

export function validatePublicationReport(report, expected) {
  if (!report || typeof report !== "object") {
    throw new Error("Publication report must be an object");
  }
  if (report.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported validation report schema: ${report.schemaVersion}`);
  }

  const normalized = mergeTargetReports(report.targets, {
    revision: report.revision,
    commitSha: report.commitSha,
    manifestSha256: report.manifestSha256,
    lockSha256: report.lockSha256,
    runId: report.runId,
    runUrl: report.runUrl,
    candidate: report.candidate,
    canary: report.canary,
  });
  if (JSON.stringify(normalized) !== JSON.stringify(report)) {
    throw new Error("Validation report is not in canonical schema order");
  }

  const expectedValues = normalizeExpected(expected);
  assertEqual(report.revision, expectedValues.revision, "toolchain revision");
  assertEqual(report.commitSha, expectedValues.commitSha, "commit SHA");
  assertEqual(report.manifestSha256, expectedValues.manifestSha256, "manifest SHA-256");
  assertEqual(report.lockSha256, expectedValues.lockSha256, "lock SHA-256");
  if (expectedValues.candidate) {
    assertEqual(
      JSON.stringify(report.candidate),
      JSON.stringify(expectedValues.candidate),
      "candidate artifact identity",
    );
  }

  for (const target of report.targets) {
    if (!target.success) {
      const failedChecks = Object.entries(target.checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name)
        .join(", ");
      throw new Error(`${target.target} validation failed: ${failedChecks}`);
    }
  }
}

export function canonicalValidationJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function normalizeExistingTargetReport(report) {
  if (!report || typeof report !== "object") {
    throw new Error("Target report must be an object");
  }
  if (report.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported target report schema: ${report.schemaVersion}`);
  }
  const normalized = createTargetReport({
    target: report.target,
    success: report.success,
    runnerImage: report.runner?.image,
    architecture: report.runner?.architecture,
    checks: report.checks,
    tools: report.tools,
    assets: report.assets,
    extractedHashes: report.extractedHashes,
    diagnostics: report.diagnostics,
    canary: report.canary,
  });
  if (JSON.stringify(normalized) !== JSON.stringify(report)) {
    throw new Error(`${report.target ?? "Unknown target"} report is not canonical`);
  }
  return normalized;
}

function normalizeChecks(checks, target) {
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) {
    throw new Error(`${target} checks must be an object`);
  }
  return {
    supplyChain: requireBoolean(checks.supplyChain, `${target} supply-chain check`),
    executables: requireBoolean(checks.executables, `${target} executable check`),
    dash: requireBoolean(checks.dash, `${target} DASH check`),
    projectTests: requireBoolean(checks.projectTests, `${target} project test check`),
  };
}

function normalizeTools(tools, target) {
  const normalized = requireArray(tools, `${target} tools`).map((tool) => ({
    name: requireEnum(tool?.name, REQUIRED_TOOLS, `${target} tool name`),
    version: requireString(tool?.version, `${target} ${tool?.name ?? "tool"} version`),
  }));
  ensureUnique(normalized, (tool) => tool.name, `${target} tool`);
  ensureSameValues(
    normalized.map((tool) => tool.name),
    REQUIRED_TOOLS,
    `${target} tools`,
  );
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeAssets(assets, target) {
  const normalized = requireArray(assets, `${target} assets`).map((asset) => {
    if (!asset || typeof asset !== "object") {
      throw new Error(`${target} asset must be an object`);
    }
    if (!Object.hasOwn(asset, "releaseId") || !Object.hasOwn(asset, "assetId")) {
      throw new Error(`${target} asset must declare releaseId and assetId`);
    }
    const sourceUrl = requireHttpsUrl(asset.sourceUrl, `${target} asset source URL`);
    if (/\/latest(?:\/|$)/u.test(new URL(sourceUrl).pathname)) {
      throw new Error(`${target} asset source URL must be immutable`);
    }
    return {
      sourceId: requireString(asset.sourceId, `${target} asset source ID`),
      releaseId: normalizeIdentifier(asset.releaseId, `${target} release ID`),
      assetId: normalizeIdentifier(asset.assetId, `${target} asset ID`),
      assetName: requireString(asset.assetName, `${target} asset name`),
      sourceUrl,
      size: requirePositiveInteger(asset.size, `${target} asset size`),
      officialSha256: requireSha256(asset.officialSha256, `${target} official asset digest`),
    };
  });
  if (normalized.length === 0) throw new Error(`${target} assets must not be empty`);
  ensureUnique(
    normalized,
    (asset) => `${asset.sourceId}\0${asset.assetId ?? "none"}\0${asset.assetName}`,
    `${target} asset`,
  );
  return normalized.sort((left, right) =>
    [left.sourceId, left.assetName, left.assetId ?? ""].join("\0").localeCompare(
      [right.sourceId, right.assetName, right.assetId ?? ""].join("\0"),
    ),
  );
}

function normalizeExtractedHashes(hashes, target) {
  const prefix = `Tools/${target}/`;
  const normalized = requireArray(hashes, `${target} extracted hashes`).map((hash) => {
    const tool = requireEnum(hash?.tool, REQUIRED_TOOLS, `${target} extracted tool`);
    const path = requireString(hash?.path, `${target} ${tool} extracted path`).replaceAll(
      "\\",
      "/",
    );
    if (!path.startsWith(prefix) || path.includes("/../")) {
      throw new Error(`${target} extracted path is outside its target: ${path}`);
    }
    return {
      tool,
      path,
      sha256: requireSha256(hash?.sha256, `${target} ${tool} extracted SHA-256`),
    };
  });
  ensureUnique(normalized, (hash) => hash.tool, `${target} extracted hash`);
  return normalized.sort((left, right) => left.tool.localeCompare(right.tool));
}

function normalizeDiagnostics(diagnostics, target) {
  const normalized = requireArray(diagnostics, `${target} diagnostics`).map((diagnostic) => {
    const result = {
      sourceUnit: requireString(diagnostic?.sourceUnit, `${target} diagnostic source unit`),
      success: requireBoolean(diagnostic?.success, `${target} diagnostic success`),
    };
    if (diagnostic?.summary !== undefined) {
      result.summary = requireString(diagnostic.summary, `${target} diagnostic summary`);
    }
    return result;
  });
  ensureUnique(normalized, (diagnostic) => diagnostic.sourceUnit, `${target} diagnostic`);
  return normalized.sort((left, right) => left.sourceUnit.localeCompare(right.sourceUnit));
}

function normalizeContext(context) {
  if (!context || typeof context !== "object") {
    throw new Error("Validation report context must be an object");
  }
  const normalized = {
    revision: requireRevision(context.revision),
    commitSha: requireCommitSha(context.commitSha, "Validation commit SHA"),
    manifestSha256: requireSha256(context.manifestSha256, "Manifest SHA-256"),
    lockSha256: requireSha256(context.lockSha256, "Lock SHA-256"),
    runId: requireRunId(context.runId),
    runUrl: requireHttpsUrl(context.runUrl, "Validation run URL"),
  };
  if (context.candidate !== undefined) {
    normalized.candidate = normalizeCandidate(context.candidate, normalized.revision);
  }
  if (context.canary !== undefined) {
    normalized.canary = normalizeCanary(context.canary);
  }
  return normalized;
}

function normalizeCanary(canary) {
  if (!canary || typeof canary !== "object") {
    throw new Error("Canary status must be an object");
  }
  if (canary.blocking !== false) {
    throw new Error("Canary status must remain explicitly non-blocking");
  }
  return {
    status: requireString(canary.status, "Canary status"),
    blocking: false,
  };
}

function normalizeExpected(expected) {
  if (!expected || typeof expected !== "object") {
    throw new Error("Expected publication identity must be an object");
  }
  const normalized = {
    revision: requireRevision(expected.revision),
    commitSha: requireCommitSha(expected.commitSha, "Expected commit SHA"),
    manifestSha256: requireSha256(expected.manifestSha256, "Expected manifest SHA-256"),
    lockSha256: requireSha256(expected.lockSha256, "Expected lock SHA-256"),
  };
  if (expected.candidate !== undefined) {
    normalized.candidate = normalizeCandidate(expected.candidate, normalized.revision);
  }
  return normalized;
}

function normalizeCandidate(candidate, revision) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Candidate artifact identity must be an object");
  }
  const artifactName = requireString(candidate.artifactName, "Candidate artifact name");
  if (artifactName !== `toolchain-candidate-${revision}`) {
    throw new Error(`Candidate artifact name must match revision ${revision}`);
  }
  return {
    artifactName,
    artifactId: requirePositiveIdentifier(candidate.artifactId, "Candidate artifact ID"),
    artifactDigest: requireSha256(candidate.artifactDigest, "Candidate artifact digest"),
    repositoryId: requirePositiveIdentifier(
      candidate.repositoryId,
      "Candidate repository ID",
    ),
    pullRequestNumber: requirePositiveInteger(
      candidate.pullRequestNumber,
      "Candidate pull request number",
    ),
    headSha: requireCommitSha(candidate.headSha, "Candidate head SHA"),
  };
}

function requirePositiveIdentifier(value, label) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) return value;
  throw new Error(`${label} must be a positive integer string`);
}

function normalizeIdentifier(value, label) {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) return value;
  throw new Error(`${label} must be a positive integer string or null`);
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireEnum(value, allowed, label) {
  const normalized = requireString(value, label);
  if (!allowed.includes(normalized)) throw new Error(`${label} is unsupported: ${normalized}`);
  return normalized;
}

function requireRevision(value) {
  if (!REVISION_PATTERN.test(value ?? "")) {
    throw new Error(`Invalid toolchain revision: ${value}`);
  }
  return value;
}

function requireCommitSha(value, label) {
  if (!COMMIT_SHA_PATTERN.test(value ?? "")) throw new Error(`${label} is invalid`);
  return value;
}

function requireSha256(value, label) {
  if (!SHA256_PATTERN.test(value ?? "")) throw new Error(`${label} is invalid`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireRunId(value) {
  const runId = requireString(value, "Validation run ID");
  if (!/^[1-9][0-9]*$/u.test(runId)) throw new Error("Validation run ID is invalid");
  return runId;
}

function requireHttpsUrl(value, label) {
  const url = requireString(value, label);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} must use HTTPS without credentials`);
  }
  return parsed.href;
}

function ensureUnique(values, keyFor, label) {
  const seen = new Set();
  for (const value of values) {
    const key = keyFor(value);
    if (seen.has(key)) throw new Error(`Duplicate ${label}: ${key}`);
    seen.add(key);
  }
}

function ensureSameValues(actual, expected, label) {
  const actualValues = [...new Set(actual)].sort();
  const expectedValues = [...new Set(expected)].sort();
  if (JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) {
    throw new Error(`${label} do not match: ${actualValues.join(", ")}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Validation report ${label} does not match the expected value`);
  }
}
