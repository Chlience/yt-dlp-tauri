import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  checkToolSourceUrl,
  checkUrlWithRetries,
} from "./check-tool-source-urls.mjs";
import {
  ArchiveChannelError,
  fetchStableToolchainManifest,
} from "./toolchain/archive-channel.mjs";
import { compareToolchainRevisions } from "./toolchain/channel.mjs";

const DEFAULT_LOCK_PATH = "toolchain-lock.json";
const DEFAULT_MANIFEST_PATH = "src-tauri/tools-manifest.json";

function manifestTools(manifest) {
  const tools = new Map();
  for (const target of manifest?.targets ?? []) {
    for (const tool of target?.tools ?? []) {
      const key = `${target.target}/${tool.name}`;
      const entries = tools.get(key) ?? [];
      entries.push(tool);
      tools.set(key, entries);
    }
  }
  return tools;
}

function unavailableDescription(result, url) {
  const status = typeof result.status === "number" ? String(result.status) : "unknown status";
  const statusText =
    typeof result.statusText === "string" && result.statusText.trim()
      ? ` ${result.statusText.trim()}`
      : "";
  return `${status}${statusText} ${url}`;
}

function addUrl(urls, value, issue, label) {
  if (typeof value !== "string" || value.trim() === "") {
    issue(`${label} is missing a source URL`);
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    issue(`${label} has an invalid source URL: ${value}`);
    return;
  }
  if (parsed.protocol !== "https:") {
    issue(`${label} source URL must use HTTPS: ${value}`);
    return;
  }
  urls.add(parsed.toString());
}

function addArchiveUrl(urls, tool, manifest, issue, label) {
  const value = tool?.sourceUrl;
  if (typeof value !== "string" || value.trim() === "") {
    issue(`${label} is missing an archive URL`);
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    issue(`${label} has an invalid archive URL: ${value}`);
    return;
  }
  const prefix = "/Chlience/yt-dlp-tauri-toolchain/releases/download/";
  const sourcePath = parsed.pathname.startsWith(prefix)
    ? parsed.pathname.slice(prefix.length)
    : "";
  const separator = sourcePath.indexOf("/");
  const releaseTag = separator > 0 ? sourcePath.slice(0, separator) : "";
  const assetName = separator > 0 ? sourcePath.slice(separator + 1) : "";
  const sourceRevision = releaseTag.startsWith("toolchain-")
    ? releaseTag.slice("toolchain-".length)
    : "";
  let validSourceRevision = false;
  try {
    validSourceRevision =
      compareToolchainRevisions(sourceRevision, manifest.revision) <= 0;
  } catch {}
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !validSourceRevision ||
    !assetName ||
    assetName.includes("/")
  ) {
    issue(
      `${label} must use an immutable archive revision URL no newer than ${manifest.revision}: ${value}`,
    );
    return;
  }
  if (!Number.isSafeInteger(tool.sourceSize) || tool.sourceSize <= 0) {
    issue(`${label} is missing a positive sourceSize`);
  }
  if (!/^[a-f0-9]{64}$/u.test(tool.sourceSha256 ?? "")) {
    issue(`${label} is missing a lowercase sourceSha256`);
  }
  urls.add(parsed.toString());
}

function finding(failureClass, message, sourceId) {
  return {
    class: failureClass,
    message,
    ...(sourceId ? { sourceId } : {}),
  };
}

export async function evaluateToolchainFreshness(
  lock,
  manifest,
  checkUrl = checkToolSourceUrl,
  options = {},
) {
  if (!Array.isArray(lock?.sources)) {
    throw new Error("Toolchain lock must contain a sources array");
  }
  const manifestByTool = manifestTools(manifest);
  const knownManifestTools = new Set();
  const checkedUrls = new Map();
  const checkOnce = (url) => {
    if (!checkedUrls.has(url)) {
      checkedUrls.set(url, checkUrlWithRetries(url, checkUrl));
    }
    return checkedUrls.get(url);
  };
  const failedSourceIds = new Set();
  const problems = [];
  const archiveUrls = new Set();

  if (options.archiveObservation?.ok === false) {
    problems.push(
      finding(
        options.archiveObservation.class,
        options.archiveObservation.message,
      ),
    );
  }

  for (const source of [...lock.sources].sort((left, right) => left.id.localeCompare(right.id))) {
    const discoveryUrls = new Set();
    const discoveryProblems = [];
    const integrityProblems = [];
    const discoveryIssue = (problem) => discoveryProblems.push(problem);
    const integrityIssue = (problem) => integrityProblems.push(problem);
    if (!Array.isArray(source.assets)) {
      discoveryIssue("lock source has no assets array");
    }
    for (const asset of source.assets ?? []) {
      addUrl(
        discoveryUrls,
        asset.sourceUrl,
        discoveryIssue,
        `${asset.target} locked asset`,
      );
      for (const member of asset.members ?? []) {
        const key = `${asset.target}/${member.tool}`;
        knownManifestTools.add(key);
        const entries = manifestByTool.get(key) ?? [];
        if (entries.length === 0) {
          integrityIssue(`manifest is missing ${key}`);
        } else if (entries.length > 1) {
          integrityIssue(`manifest contains duplicate ${key} entries`);
        } else {
          addArchiveUrl(
            archiveUrls,
            entries[0],
            manifest,
            integrityIssue,
            `${key} manifest entry`,
          );
        }
      }
    }

    for (const url of [...discoveryUrls].sort()) {
      const result = await checkOnce(url);
      if (!result.ok) discoveryProblems.push(unavailableDescription(result, url));
    }
    if (discoveryProblems.length > 0) {
      failedSourceIds.add(source.id);
      problems.push(
        finding(
          "upstream-discovery",
          `${source.id}: ${discoveryProblems.join("; ")}`,
          source.id,
        ),
      );
    }
    if (integrityProblems.length > 0) {
      failedSourceIds.add(source.id);
      problems.push(
        finding(
          "archive-integrity",
          `${source.id}: ${integrityProblems.join("; ")}`,
          source.id,
        ),
      );
    }
  }

  for (const key of [...manifestByTool.keys()].sort()) {
    if (!knownManifestTools.has(key)) {
      problems.push(
        finding(
          "archive-integrity",
          `manifest tool ${key} is not represented in toolchain-lock.json`,
        ),
      );
    }
  }
  for (const url of [...archiveUrls].sort()) {
    const result = await checkOnce(url);
    if (!result.ok) {
      problems.push(
        finding(
          "archive-unavailable",
          unavailableDescription(result, url),
        ),
      );
    }
  }
  return {
    ok: problems.length === 0,
    failedSourceIds: [...failedSourceIds].sort(),
    problems,
  };
}

function parseArgs(argv) {
  const args = {
    lock: DEFAULT_LOCK_PATH,
    manifest: DEFAULT_MANIFEST_PATH,
    jsonOutput: "",
  };
  const flags = new Map([
    ["--lock", "lock"],
    ["--manifest", "manifest"],
    ["--json-output", "jsonOutput"],
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
  let archiveObservation = { ok: true };
  try {
    const stable = await fetchStableToolchainManifest({
      token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "",
      userAgent: "yt-dlp-tauri-toolchain-freshness",
    });
    if (stable.status === "missing") {
      archiveObservation = {
        ok: false,
        class: "archive-unavailable",
        message: "Stable archive channel has not been published",
      };
    }
  } catch (error) {
    archiveObservation = {
      ok: false,
      class:
        error instanceof ArchiveChannelError
          ? error.failureClass
          : "archive-unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const result = await evaluateToolchainFreshness(
    lock,
    manifest,
    checkToolSourceUrl,
    { archiveObservation },
  );
  if (args.jsonOutput) writeFileSync(args.jsonOutput, `${JSON.stringify(result, null, 2)}\n`);

  if (result.ok) {
    process.stdout.write("Toolchain source URLs are healthy\n");
    return;
  }
  process.stderr.write("Toolchain freshness check failed\n");
  for (const problem of result.problems) {
    process.stderr.write(`- [${problem.class}] ${problem.message}\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
