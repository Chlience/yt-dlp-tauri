import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  generateManifest,
  renderToolchainChangelog,
} from "./toolchain/generate-manifest.mjs";
import { readToolchainPolicy } from "./toolchain/policy.mjs";
import { resolveToolchainLock } from "./toolchain/resolve-lock.mjs";

const DEFAULTS = {
  policyPath: "toolchain-policy.json",
  lockPath: "toolchain-lock.json",
  manifestPath: "src-tauri/tools-manifest.json",
  changelogPath: "TOOLCHAIN_CHANGELOG.md",
  fixturePath: "",
  only: "",
  now: undefined,
  dryRun: false,
};

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function preserveEquivalentJson(previous, nextValue) {
  if (previous) {
    try {
      if (isDeepStrictEqual(JSON.parse(previous), nextValue)) return previous;
    } catch {
      // Replace invalid generated JSON with the resolved value below.
    }
  }
  return jsonText(nextValue);
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function parseJson(text, path) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${path}: ${error}`);
  }
}

function fixtureAdapters(fixture) {
  if (!fixture || fixture.schemaVersion !== 1) {
    throw new Error("Toolchain resolver fixture schemaVersion must be 1");
  }
  for (const field of ["githubReleases", "inspections", "provenance"]) {
    if (!fixture[field] || typeof fixture[field] !== "object" || Array.isArray(fixture[field])) {
      throw new Error(`Toolchain resolver fixture requires ${field}`);
    }
  }
  const fixtureValue = (collection, key, label) => {
    if (!Object.hasOwn(collection, key)) {
      throw new Error(`Toolchain resolver fixture has no ${label} for ${key}`);
    }
    return structuredClone(collection[key]);
  };
  return {
    githubAdapter: async (repository) =>
      fixtureValue(fixture.githubReleases, repository, "GitHub releases"),
    inspectAsset: async ({ url }) =>
      fixtureValue(fixture.inspections, String(url), "inspection"),
    provenanceResolver: async (source) =>
      fixtureValue(fixture.provenance, source.id, "provenance"),
  };
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sourceChanges(currentLock, nextLock) {
  const before = new Map((currentLock?.sources ?? []).map((source) => [source.id, source]));
  const after = new Map((nextLock.sources ?? []).map((source) => [source.id, source]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((id) => !isDeepStrictEqual(before.get(id), after.get(id)))
    .sort(compareStrings);
}

async function resolveRequestedLock({
  policy,
  currentLock,
  only,
  resolverOptions,
}) {
  if (!only) {
    return resolveToolchainLock({ policy, currentLock, ...resolverOptions });
  }
  const source = policy.sources.find((candidate) => candidate.id === only);
  if (!source) throw new Error(`Unknown toolchain source for --only: ${only}`);
  if (!currentLock) throw new Error("--only requires an existing toolchain lock");
  const currentSource = currentLock.sources?.find((candidate) => candidate.id === only);
  if (!currentSource) throw new Error(`Current toolchain lock is missing source ${only}`);

  const focusedPolicy = { ...policy, sources: [source] };
  const focusedCurrent = {
    schemaVersion: currentLock.schemaVersion,
    revision: currentLock.revision,
    generatedAtUtc: currentLock.generatedAtUtc,
    targets: currentLock.targets,
    sources: [currentSource],
  };
  const focused = await resolveToolchainLock({
    policy: focusedPolicy,
    currentLock: focusedCurrent,
    ...resolverOptions,
  });
  if (focused.sources.length !== 1 || focused.sources[0].id !== only) {
    throw new Error(`Focused resolver returned an invalid source set for ${only}`);
  }
  const sources = currentLock.sources
    .filter((candidate) => candidate.id !== only)
    .concat(focused.sources)
    .sort((left, right) => compareStrings(left.id, right.id));
  return {
    ...currentLock,
    schemaVersion: focused.schemaVersion,
    revision: focused.revision,
    generatedAtUtc: focused.generatedAtUtc,
    targets: focused.targets,
    sources,
  };
}

async function writeOutputSet(outputs) {
  const staged = [];
  try {
    for (const output of outputs) {
      await mkdir(dirname(output.path), { recursive: true });
      const temporaryPath = `${output.path}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temporaryPath, output.content, { flag: "wx" });
      staged.push({ ...output, temporaryPath });
    }
    for (const output of staged) {
      await rename(output.temporaryPath, output.path);
    }
  } finally {
    await Promise.all(staged.map((output) => unlink(output.temporaryPath).catch(() => {})));
  }
}

export async function runUpdateToolchain({
  policyPath = DEFAULTS.policyPath,
  lockPath = DEFAULTS.lockPath,
  manifestPath = DEFAULTS.manifestPath,
  changelogPath = DEFAULTS.changelogPath,
  fixturePath = DEFAULTS.fixturePath,
  only = DEFAULTS.only,
  now = new Date(),
  dryRun = DEFAULTS.dryRun,
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Toolchain update requires a valid --now date");
  }
  const policy = readToolchainPolicy(policyPath);
  const currentLockText = await readOptional(lockPath);
  const currentLock = currentLockText ? parseJson(currentLockText, lockPath) : null;
  const existingManifest = (await readOptional(manifestPath)) ?? "";
  const existingChangelog = (await readOptional(changelogPath)) ?? "";
  const resolverOptions = { now };
  if (fixturePath) {
    const fixture = parseJson(await readFile(fixturePath, "utf8"), fixturePath);
    Object.assign(resolverOptions, fixtureAdapters(fixture));
  }

  const nextLock = await resolveRequestedLock({
    policy,
    currentLock,
    only,
    resolverOptions,
  });
  const nextManifest = generateManifest(policy, nextLock);
  const updatedSources = sourceChanges(currentLock, nextLock);
  const nextChangelog = renderToolchainChangelog(
    updatedSources.length > 0 ? currentLock : null,
    nextLock,
    existingChangelog,
  );
  const outputs = [
    {
      path: lockPath,
      content: preserveEquivalentJson(currentLockText, nextLock),
      previous: currentLockText ?? "",
    },
    {
      path: manifestPath,
      content: preserveEquivalentJson(existingManifest, nextManifest),
      previous: existingManifest,
    },
    { path: changelogPath, content: nextChangelog, previous: existingChangelog },
  ];
  const changed = outputs.some((output) => output.content !== output.previous);
  if (changed && !dryRun) await writeOutputSet(outputs);

  return {
    changed,
    revision: nextLock.revision,
    updatedSources,
  };
}

export function parseUpdateToolchainArgs(argv) {
  const result = { ...DEFAULTS };
  const valueFlags = new Map([
    ["--policy", "policyPath"],
    ["--lock", "lockPath"],
    ["--manifest", "manifestPath"],
    ["--changelog", "changelogPath"],
    ["--fixture", "fixturePath"],
    ["--only", "only"],
    ["--now", "now"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    const property = valueFlags.get(flag);
    if (!property) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    index += 1;
    result[property] = value;
  }

  if (typeof result.now === "string") {
    result.now = new Date(result.now);
    if (!Number.isFinite(result.now.getTime())) {
      throw new Error("Invalid value for --now");
    }
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runUpdateToolchain(parseUpdateToolchainArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
