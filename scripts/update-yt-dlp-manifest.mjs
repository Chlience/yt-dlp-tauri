import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { githubApiHeaders } from "./check-yt-dlp-release.mjs";

const DEFAULT_MANIFEST_PATH = "src-tauri/tools-manifest.json";
const LATEST_RELEASE_API_URL = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const TARGET_ASSETS = new Map([
  ["win-x64", "yt-dlp.exe"],
  ["macos-x64", "yt-dlp_macos"],
  ["macos-arm64", "yt-dlp_macos"],
]);
const TARGET_ASSET_NAMES = new Set(TARGET_ASSETS.values());

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

function normalizeSha256(value) {
  return value.trim().replace(/^sha256:/i, "").toLowerCase();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function updateYtDlpManifest(manifest, latestRelease, options = {}) {
  const latestVersion = releaseTag(latestRelease);
  const updatedManifest = cloneJson(manifest);
  const updatedTargets = [];

  for (const target of updatedManifest.targets ?? []) {
    const assetName = TARGET_ASSETS.get(target.target);
    if (!assetName) {
      continue;
    }

    const tool = target.tools?.find((item) => item.name === "yt-dlp");
    if (!tool) {
      throw new Error(`${target.target} is missing yt-dlp.`);
    }

    const asset = assetByName(latestRelease, assetName);
    if (!asset) {
      throw new Error(`Latest yt-dlp release ${latestVersion} is missing ${assetName}.`);
    }

    if (typeof asset.digest !== "string" || !asset.digest.toLowerCase().startsWith("sha256:")) {
      throw new Error(`Latest yt-dlp release ${latestVersion} asset ${assetName} is missing a SHA-256 digest.`);
    }

    const nextSourceUrl =
      asset.browser_download_url ?? `https://github.com/yt-dlp/yt-dlp/releases/download/${latestVersion}/${assetName}`;
    const nextSha256 = normalizeSha256(asset.digest);
    const targetChanged =
      tool.version !== latestVersion ||
      tool.sourceUrl !== nextSourceUrl ||
      normalizeSha256(tool.sha256 ?? "") !== nextSha256;

    if (!targetChanged) {
      continue;
    }

    tool.version = latestVersion;
    tool.sourceUrl = nextSourceUrl;
    tool.sha256 = nextSha256;
    updatedTargets.push(target.target);
  }

  if (updatedTargets.length > 0) {
    updatedManifest.retrievedAtUtc = options.retrievedAtUtc ?? new Date().toISOString();
  }

  return {
    changed: updatedTargets.length > 0,
    latestVersion,
    manifest: updatedManifest,
    updatedTargets,
  };
}

export function ytDlpReleaseFixture(latestRelease) {
  return {
    tag_name: releaseTag(latestRelease),
    html_url: latestRelease.html_url,
    assets: releaseAssets(latestRelease)
      .filter((asset) => TARGET_ASSET_NAMES.has(asset?.name))
      .map((asset) => ({
        name: asset.name,
        browser_download_url: asset.browser_download_url,
        digest: asset.digest,
      })),
  };
}

export function updateYtDlpChangelog(changelog, latestVersion) {
  const zhBullet = `- 将应用管理的 \`yt-dlp\` 更新到 \`${latestVersion}\`，减少站点 extractor 过期导致的解析失败。`;
  const enBullet = `- Updated the app-managed \`yt-dlp\` to \`${latestVersion}\` to reduce parsing failures caused by stale site extractors.`;
  let nextChangelog = changelog;

  if (!nextChangelog.includes(zhBullet)) {
    nextChangelog = nextChangelog.replace("### 中文\n\n", `### 中文\n\n${zhBullet}\n`);
  }

  if (!nextChangelog.includes(enBullet)) {
    nextChangelog = nextChangelog.replace("### English\n\n", `### English\n\n${enBullet}\n`);
  }

  return {
    changed: nextChangelog !== changelog,
    changelog: nextChangelog,
  };
}

export function updateWindowsDownloadScript(script, latestRelease) {
  const latestVersion = releaseTag(latestRelease);
  const asset = assetByName(latestRelease, "yt-dlp.exe");
  if (!asset) {
    throw new Error(`Latest yt-dlp release ${latestVersion} is missing yt-dlp.exe.`);
  }

  if (typeof asset.digest !== "string" || !asset.digest.toLowerCase().startsWith("sha256:")) {
    throw new Error(`Latest yt-dlp release ${latestVersion} asset yt-dlp.exe is missing a SHA-256 digest.`);
  }

  const nextSourceUrl =
    asset.browser_download_url ?? `https://github.com/yt-dlp/yt-dlp/releases/download/${latestVersion}/yt-dlp.exe`;
  const nextSha256 = normalizeSha256(asset.digest);
  let nextScript = script.replace(
    /Download-File 'https:\/\/github\.com\/yt-dlp\/yt-dlp\/releases\/download\/[^']+\/yt-dlp\.exe' \$ytDlp/,
    `Download-File '${nextSourceUrl}' $ytDlp`,
  );
  nextScript = nextScript.replace(
    /Assert-Hash \$ytDlp '[a-fA-F0-9]{64}'/,
    `Assert-Hash $ytDlp '${nextSha256}'`,
  );

  return {
    changed: nextScript !== script,
    script: nextScript,
  };
}

function parseArgs(argv) {
  const args = {
    changelog: "",
    manifest: DEFAULT_MANIFEST_PATH,
    releaseFixture: "",
    releaseJson: "",
    windowsDownloadScript: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${flag}`);
    }
    index += 1;

    if (flag === "--changelog") {
      args.changelog = value;
    } else if (flag === "--manifest") {
      args.manifest = value;
    } else if (flag === "--release-fixture") {
      args.releaseFixture = value;
    } else if (flag === "--release-json") {
      args.releaseJson = value;
    } else if (flag === "--windows-download-script") {
      args.windowsDownloadScript = value;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return args;
}

async function fetchLatestRelease() {
  const response = await fetch(LATEST_RELEASE_API_URL, {
    headers: githubApiHeaders(),
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
  const result = updateYtDlpManifest(manifest, latestRelease);
  let wroteFile = false;

  if (result.changed) {
    writeFileSync(args.manifest, `${JSON.stringify(result.manifest, null, 2)}\n`);
    wroteFile = true;
  }

  if (args.releaseFixture) {
    const fixtureJson = `${JSON.stringify(ytDlpReleaseFixture(latestRelease), null, 2)}\n`;
    const existingFixture = readFileSync(args.releaseFixture, "utf8");
    if (existingFixture !== fixtureJson) {
      writeFileSync(args.releaseFixture, fixtureJson);
      wroteFile = true;
    }
  }

  if (args.changelog && result.changed) {
    const changelogResult = updateYtDlpChangelog(readFileSync(args.changelog, "utf8"), result.latestVersion);
    if (changelogResult.changed) {
      writeFileSync(args.changelog, changelogResult.changelog);
      wroteFile = true;
    }
  }

  if (args.windowsDownloadScript) {
    const scriptResult = updateWindowsDownloadScript(readFileSync(args.windowsDownloadScript, "utf8"), latestRelease);
    if (scriptResult.changed) {
      writeFileSync(args.windowsDownloadScript, scriptResult.script);
      wroteFile = true;
    }
  }

  if (!wroteFile) {
    process.stdout.write(`yt-dlp tool manifest is already current at ${result.latestVersion}.\n`);
    return;
  }

  const targets = result.updatedTargets.length > 0 ? ` for ${result.updatedTargets.join(", ")}` : "";
  process.stdout.write(`Updated yt-dlp tool metadata to ${result.latestVersion}${targets}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
