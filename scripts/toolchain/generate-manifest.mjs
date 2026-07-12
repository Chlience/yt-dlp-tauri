import {
  archiveDescriptorUrl,
  archiveReleaseTag,
  validateArchiveDescriptor,
} from "./archive-contract.mjs";

const TARGET_ORDER = ["win-x64"];
const TOOL_ORDER = ["yt-dlp", "ffmpeg", "ffprobe", "deno"];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[0-9]{8}\.[1-9][0-9]*$/;

function compareByOrder(order, label) {
  const positions = new Map(order.map((value, index) => [value, index]));
  return (left, right) => {
    const leftPosition = positions.get(left[label]);
    const rightPosition = positions.get(right[label]);
    if (leftPosition === undefined) throw new Error(`Unsupported ${label}: ${left[label]}`);
    if (rightPosition === undefined) throw new Error(`Unsupported ${label}: ${right[label]}`);
    return leftPosition - rightPosition;
  };
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function runtimeVersion(version) {
  const value = requireString(version, "Toolchain source version");
  return /^v[0-9]/.test(value) ? value.slice(1) : value;
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

function manifestSourceUrl(asset, revision, sourceMode) {
  if (sourceMode === "upstream") return asset.sourceUrl;
  if (sourceMode !== "runtime" && sourceMode !== "candidate") {
    throw new Error(`Unsupported manifest source mode: ${sourceMode}`);
  }
  const archive = validateArchiveDescriptor(asset.archive, {
    repository: "Chlience/yt-dlp-tauri-toolchain",
    size: asset.size,
    sha256: asset.sha256,
  });
  if (
    sourceMode === "candidate" &&
    archive.releaseTag === archiveReleaseTag(revision)
  ) {
    return asset.sourceUrl;
  }
  return archiveDescriptorUrl(archive);
}

function ensureSameValues(left, right, label) {
  const leftValues = [...new Set(left)].sort();
  const rightValues = [...new Set(right)].sort();
  if (JSON.stringify(leftValues) !== JSON.stringify(rightValues)) {
    throw new Error(`${label} do not match: ${leftValues.join(", ")} != ${rightValues.join(", ")}`);
  }
}

export function generateManifest(policy, lock, { sourceMode = "runtime" } = {}) {
  if (!lock || typeof lock !== "object") throw new Error("Toolchain lock must be an object");
  if (!REVISION_PATTERN.test(lock.revision ?? "")) {
    throw new Error(`Invalid toolchain lock revision: ${lock.revision}`);
  }
  if (
    typeof lock.generatedAtUtc !== "string" ||
    !Number.isFinite(Date.parse(lock.generatedAtUtc))
  ) {
    throw new Error("Toolchain lock has an invalid generation time");
  }

  const policyTargets = requireArray(policy?.targets, "Toolchain policy targets");
  const lockTargets = requireArray(lock.targets, "Toolchain lock targets");
  ensureSameValues(policyTargets, lockTargets, "Toolchain targets");
  for (const target of lockTargets) {
    if (!TARGET_ORDER.includes(target)) throw new Error(`Unsupported target: ${target}`);
  }

  const policySourceIds = requireArray(policy?.sources, "Toolchain policy sources").map(
    (source) => source.id,
  );
  const lockSources = requireArray(lock.sources, "Toolchain lock sources");
  ensureSameValues(
    policySourceIds,
    lockSources.map((source) => source.id),
    "Toolchain source IDs",
  );

  const toolsByTarget = new Map(lockTargets.map((target) => [target, []]));
  const seenTools = new Set();
  for (const source of lockSources) {
    const version = runtimeVersion(source.version);
    for (const asset of requireArray(source.assets, `${source.id} assets`)) {
      const tools = toolsByTarget.get(asset.target);
      if (!tools) throw new Error(`${source.id} uses unknown target ${asset.target}`);
      const sourceUrl = requireString(
        manifestSourceUrl(asset, lock.revision, sourceMode),
        `${source.id} source URL`,
      );
      const sourceSize = requirePositiveInteger(
        asset.size,
        `${source.id} source size`,
      );
      const sourceSha256 = requireSha256(
        asset.sha256,
        `${source.id} source SHA-256`,
      );
      const parsedUrl = new URL(sourceUrl);
      if (parsedUrl.protocol !== "https:") {
        throw new Error(`${source.id} source URL must use HTTPS`);
      }
      if (parsedUrl.pathname.includes("/latest/")) {
        throw new Error(`${source.id} source URL is mutable: ${sourceUrl}`);
      }
      if (asset.kind !== "file" && asset.kind !== "zip") {
        throw new Error(`${source.id} has unsupported asset kind ${asset.kind}`);
      }

      for (const member of requireArray(asset.members, `${source.id} asset members`)) {
        if (!TOOL_ORDER.includes(member.tool)) {
          throw new Error(`Unsupported tool: ${member.tool}`);
        }
        const key = `${asset.target}/${member.tool}`;
        if (seenTools.has(key)) throw new Error(`Duplicate manifest tool: ${key}`);
        seenTools.add(key);
        if (!SHA256_PATTERN.test(member.sha256 ?? "")) {
          throw new Error(`${key} has an invalid executable SHA-256`);
        }
        const tool = {
          name: member.tool,
          path: requireString(member.path, `${key} path`),
          sourceUrl,
          sourceSize,
          sourceSha256,
          version,
          sha256: member.sha256,
          kind: asset.kind,
          licenseNotes: requireString(member.licenseNotes, `${key} license notes`),
        };
        if (asset.kind === "zip") {
          tool.archivePathSuffix = requireString(
            member.archivePathSuffix,
            `${key} archivePathSuffix`,
          );
        }
        tools.push(tool);
      }
    }
  }

  const targetComparator = compareByOrder(TARGET_ORDER, "target");
  const toolComparator = compareByOrder(TOOL_ORDER, "name");
  return {
    schemaVersion: 4,
    revision: lock.revision,
    retrievedAtUtc: lock.generatedAtUtc,
    targets: [...toolsByTarget.entries()]
      .map(([target, tools]) => {
        if (tools.length === 0) throw new Error(`Toolchain target ${target} has no tools`);
        return { target, tools: tools.sort(toolComparator) };
      })
      .sort(targetComparator),
  };
}

function sourceSignature(source) {
  if (!source) return "";
  return JSON.stringify(source);
}

function changedSourceLines(previous, current) {
  const previousById = new Map((previous?.sources ?? []).map((source) => [source.id, source]));
  const currentById = new Map((current.sources ?? []).map((source) => [source.id, source]));
  const lines = [];

  for (const id of [...currentById.keys()].sort()) {
    const before = previousById.get(id);
    const after = currentById.get(id);
    if (sourceSignature(before) === sourceSignature(after)) continue;
    if (!before) {
      lines.push(`- \`${id}\`: added \`${after.version}\``);
    } else if (before.version !== after.version) {
      lines.push(`- \`${id}\`: \`${before.version}\` -> \`${after.version}\``);
    } else {
      lines.push(`- \`${id}\`: \`${after.version}\` asset metadata updated`);
    }
  }
  for (const id of [...previousById.keys()].sort()) {
    if (!currentById.has(id)) {
      lines.push(`- \`${id}\`: removed \`${previousById.get(id).version}\``);
    }
  }
  return lines.length > 0 ? lines : ["- No source metadata changes"];
}

function changelogSection(previous, current) {
  if (!REVISION_PATTERN.test(current?.revision ?? "")) {
    throw new Error(`Invalid toolchain revision: ${current?.revision}`);
  }
  const generatedAt = requireString(current.generatedAtUtc, "Toolchain generation time");
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error(`Invalid toolchain generation time: ${generatedAt}`);
  }
  return [
    `## ${current.revision} - ${generatedAt.slice(0, 10)}`,
    "",
    ...changedSourceLines(previous, current),
    "",
  ].join("\n");
}

export function renderToolchainChangelog(previous, current, existing = "") {
  const headingPattern = new RegExp(`^## ${current.revision.replace(".", "\\.")} (?:-|$)`, "m");
  if (headingPattern.test(existing)) return existing.endsWith("\n") ? existing : `${existing}\n`;

  const section = changelogSection(previous, current);
  if (!existing.trim()) {
    return [
      "# Toolchain Changelog",
      "",
      "Tool updates are published independently from application releases",
      "",
      section,
    ].join("\n");
  }
  if (!existing.startsWith("# Toolchain Changelog")) {
    throw new Error("Existing toolchain changelog has an invalid heading");
  }

  const nextRevision = existing.search(/^## /m);
  if (nextRevision < 0) return `${existing.trimEnd()}\n\n${section}`;
  const preamble = existing.slice(0, nextRevision).trimEnd();
  const history = existing.slice(nextRevision).trimStart();
  return `${preamble}\n\n${section}\n${history.endsWith("\n") ? history : `${history}\n`}`;
}
