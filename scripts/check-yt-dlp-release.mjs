import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_MANIFEST_PATH = "src-tauri/tools-manifest.json";
const LATEST_RELEASE_API_URL = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const TARGET_ASSETS = new Map([
  ["win-x64", "yt-dlp.exe"],
  ["macos-x64", "yt-dlp_macos"],
  ["macos-arm64", "yt-dlp_macos"],
]);

function normalizeSha256(value) {
  return value.trim().replace(/^sha256:/i, "").toLowerCase();
}

function releaseTag(release) {
  const tag = release?.tag_name ?? release?.tagName;
  if (typeof tag !== "string" || tag.trim() === "") {
    throw new Error("Latest yt-dlp release payload is missing tag_name.");
  }
  return tag.trim();
}

function releaseAssets(release) {
  if (!Array.isArray(release?.assets)) {
    throw new Error("Latest yt-dlp release payload is missing assets.");
  }
  return release.assets;
}

function assetByName(release, name) {
  return releaseAssets(release).find((asset) => asset?.name === name);
}

function expectedSourceUrl(version, assetName) {
  return `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${assetName}`;
}

export function evaluateYtDlpManifest(manifest, latestRelease) {
  const latestVersion = releaseTag(latestRelease);
  const problems = [];

  for (const target of manifest.targets ?? []) {
    const assetName = TARGET_ASSETS.get(target.target);
    if (!assetName) {
      continue;
    }

    const tool = target.tools?.find((item) => item.name === "yt-dlp");
    if (!tool) {
      problems.push(`${target.target} is missing yt-dlp.`);
      continue;
    }

    const asset = assetByName(latestRelease, assetName);
    if (!asset) {
      problems.push(`Latest yt-dlp release ${latestVersion} is missing ${assetName}.`);
      continue;
    }

    if (typeof asset.digest !== "string" || !asset.digest.toLowerCase().startsWith("sha256:")) {
      problems.push(`Latest yt-dlp release ${latestVersion} asset ${assetName} is missing a SHA-256 digest.`);
      continue;
    }

    const expectedUrl = asset.browser_download_url ?? expectedSourceUrl(latestVersion, assetName);
    const expectedSha256 = normalizeSha256(asset.digest);

    if (tool.version !== latestVersion) {
      problems.push(`${target.target} yt-dlp version is ${tool.version}, expected ${latestVersion}.`);
    }

    if (tool.sourceUrl !== expectedUrl) {
      problems.push(`${target.target} yt-dlp sourceUrl is stale. Expected ${expectedUrl}, got ${tool.sourceUrl}.`);
    }

    if (normalizeSha256(tool.sha256 ?? "") !== expectedSha256) {
      problems.push(`${target.target} yt-dlp sha256 is stale. Expected ${expectedSha256}, got ${tool.sha256}.`);
    }
  }

  return {
    ok: problems.length === 0,
    latestVersion,
    problems,
  };
}

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST_PATH,
    releaseJson: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${flag}`);
    }
    index += 1;

    if (flag === "--manifest") {
      args.manifest = value;
    } else if (flag === "--release-json") {
      args.releaseJson = value;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return args;
}

async function fetchLatestRelease() {
  const response = await fetch(LATEST_RELEASE_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "yt-dlp-tauri-toolchain-check",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch latest yt-dlp release. ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function readLatestRelease(releaseJsonPath) {
  if (releaseJsonPath) {
    return JSON.parse(readFileSync(releaseJsonPath, "utf8"));
  }

  return fetchLatestRelease();
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
  const latestRelease = await readLatestRelease(args.releaseJson);
  const result = evaluateYtDlpManifest(manifest, latestRelease);

  if (result.ok) {
    process.stdout.write(`yt-dlp tool manifest is current at ${result.latestVersion}.\n`);
    return;
  }

  process.stderr.write(`yt-dlp tool manifest is stale. Latest release: ${result.latestVersion}.\n`);
  for (const problem of result.problems) {
    process.stderr.write(`- ${problem}\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
