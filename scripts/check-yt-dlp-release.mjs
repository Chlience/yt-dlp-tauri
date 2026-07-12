import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { archiveDescriptorUrl } from "./toolchain/archive-contract.mjs";

const DEFAULT_LOCK_PATH = "toolchain-lock.json";
const DEFAULT_MANIFEST_PATH = "src-tauri/tools-manifest.json";

function normalizedVersion(value) {
  return typeof value === "string" && /^v[0-9]/.test(value) ? value.slice(1) : value;
}

function normalizedSha256(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function ytDlpExpectations(lock) {
  const sources = lock?.sources?.filter((source) => source.id === "yt-dlp") ?? [];
  if (sources.length !== 1) {
    throw new Error("toolchain-lock.json must contain exactly one yt-dlp source");
  }
  const source = sources[0];
  const expectations = new Map();
  for (const asset of source.assets ?? []) {
    const members = asset.members?.filter((member) => member.tool === "yt-dlp") ?? [];
    if (members.length !== 1) {
      throw new Error(`yt-dlp lock asset for ${asset.target} must contain one yt-dlp member`);
    }
    if (expectations.has(asset.target)) {
      throw new Error(`toolchain-lock.json contains duplicate yt-dlp target ${asset.target}`);
    }
    expectations.set(asset.target, {
      version: normalizedVersion(source.version),
      sourceUrl: archiveDescriptorUrl(asset.archive),
      sourceSize: asset.size,
      sourceSha256: normalizedSha256(asset.sha256),
      sha256: normalizedSha256(members[0].sha256),
    });
  }
  if (expectations.size === 0) throw new Error("yt-dlp lock source has no target assets");
  return { version: normalizedVersion(source.version), expectations };
}

export function evaluateYtDlpManifest(manifest, lock) {
  const { version, expectations } = ytDlpExpectations(lock);
  const problems = [];

  for (const [targetName, expected] of expectations) {
    const targets = manifest?.targets?.filter((target) => target.target === targetName) ?? [];
    if (targets.length !== 1) {
      problems.push(`${targetName} manifest target count is ${targets.length}, expected 1`);
      continue;
    }
    const tools = targets[0].tools?.filter((tool) => tool.name === "yt-dlp") ?? [];
    if (tools.length !== 1) {
      problems.push(`${targetName} yt-dlp tool count is ${tools.length}, expected 1`);
      continue;
    }
    const tool = tools[0];
    if (tool.version !== expected.version) {
      problems.push(`${targetName} yt-dlp version is ${tool.version}, expected ${expected.version}`);
    }
    if (tool.sourceUrl !== expected.sourceUrl) {
      problems.push(`${targetName} yt-dlp sourceUrl differs from toolchain-lock.json`);
    }
    if (tool.sourceSize !== expected.sourceSize) {
      problems.push(`${targetName} yt-dlp sourceSize differs from toolchain-lock.json`);
    }
    if (normalizedSha256(tool.sourceSha256) !== expected.sourceSha256) {
      problems.push(`${targetName} yt-dlp sourceSha256 differs from toolchain-lock.json`);
    }
    if (normalizedSha256(tool.sha256) !== expected.sha256) {
      problems.push(`${targetName} yt-dlp sha256 differs from toolchain-lock.json`);
    }
  }

  for (const target of manifest?.targets ?? []) {
    if (
      !expectations.has(target.target) &&
      target.tools?.some((tool) => tool.name === "yt-dlp")
    ) {
      problems.push(`${target.target} yt-dlp is not represented in toolchain-lock.json`);
    }
  }
  return {
    ok: problems.length === 0,
    lockedVersion: version,
    problems,
  };
}

function parseArgs(argv) {
  const args = { lock: DEFAULT_LOCK_PATH, manifest: DEFAULT_MANIFEST_PATH };
  const flags = new Map([
    ["--lock", "lock"],
    ["--manifest", "manifest"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const property = flags.get(flag);
    if (!property) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    args[property] = value;
    index += 1;
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const lock = JSON.parse(readFileSync(args.lock, "utf8"));
  const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
  const result = evaluateYtDlpManifest(manifest, lock);
  if (result.ok) {
    process.stdout.write(`yt-dlp manifest matches locked version ${result.lockedVersion}\n`);
    return;
  }
  process.stderr.write(`yt-dlp manifest differs from locked version ${result.lockedVersion}\n`);
  for (const problem of result.problems) process.stderr.write(`- ${problem}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
