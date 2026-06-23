import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_MANIFEST_PATH = "src-tauri/tools-manifest.json";
const DEFAULT_MAX_ATTEMPTS = 3;

function toolReferencesBySourceUrl(manifest) {
  const referencesByUrl = new Map();

  for (const target of manifest.targets ?? []) {
    for (const tool of target.tools ?? []) {
      if (typeof tool.sourceUrl !== "string" || tool.sourceUrl.trim() === "") {
        continue;
      }

      const sourceUrl = tool.sourceUrl.trim();
      const references = referencesByUrl.get(sourceUrl) ?? [];
      references.push({
        target: target.target,
        tool: tool.name,
      });
      referencesByUrl.set(sourceUrl, references);
    }
  }

  return referencesByUrl;
}

function problemForReference(reference, result, url) {
  const status = typeof result.status === "number" ? `${result.status}` : "unknown status";
  const statusText = typeof result.statusText === "string" && result.statusText.trim() !== ""
    ? ` ${result.statusText.trim()}`
    : "";
  return `${reference.target} ${reference.tool} sourceUrl is unavailable. ${status}${statusText}. ${url}`;
}

export async function evaluateToolSourceUrls(manifest, checkUrl = checkToolSourceUrl) {
  const problems = [];
  const referencesByUrl = toolReferencesBySourceUrl(manifest);

  for (const [url, references] of referencesByUrl) {
    const result = await checkUrlWithRetries(url, checkUrl);

    if (result.ok) {
      continue;
    }

    for (const reference of references) {
      problems.push(problemForReference(reference, result, url));
    }
  }

  return {
    ok: problems.length === 0,
    checkedUrlCount: referencesByUrl.size,
    problems,
  };
}

async function checkUrlWithRetries(url, checkUrl) {
  let lastResult = {
    ok: false,
    status: undefined,
    statusText: "not checked",
  };

  for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt += 1) {
    try {
      lastResult = await checkUrl(url);
    } catch (error) {
      lastResult = {
        ok: false,
        status: undefined,
        statusText: error instanceof Error ? error.message : String(error),
      };
    }

    if (lastResult.ok || !isRetryableCheckResult(lastResult) || attempt === DEFAULT_MAX_ATTEMPTS) {
      return lastResult;
    }
  }

  return lastResult;
}

function isRetryableCheckResult(result) {
  if (typeof result.status !== "number") {
    return true;
  }
  return result.status === 408 || result.status === 429 || result.status >= 500;
}

async function checkToolSourceUrl(url) {
  const response = await fetch(url, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: {
      "User-Agent": "yt-dlp-tauri-toolchain-check",
    },
  });

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
  };
}

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST_PATH,
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
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
  const result = await evaluateToolSourceUrls(manifest);

  if (result.ok) {
    process.stdout.write(`Checked ${result.checkedUrlCount} tool source URLs.\n`);
    return;
  }

  process.stderr.write("Tool manifest contains unavailable source URLs.\n");
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
