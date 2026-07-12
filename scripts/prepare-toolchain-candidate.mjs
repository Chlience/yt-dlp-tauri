import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { prepareCandidateBundle } from "./toolchain/candidate-bundle.mjs";

const DEFAULTS = {
  policyPath: "toolchain-policy.json",
  lockPath: "toolchain-lock.json",
  outputDirectory: ".toolchain/candidate",
  repositoryId: "",
  pullRequestNumber: "",
  headSha: "",
  createdAtUtc: "",
};

export function parsePrepareCandidateArgs(argv, env = {}) {
  const result = {
    ...DEFAULTS,
    repositoryId: env.GITHUB_REPOSITORY_ID ?? "",
    pullRequestNumber: env.TOOLCHAIN_PULL_REQUEST ?? "",
    headSha: env.TOOLCHAIN_HEAD_SHA ?? env.GITHUB_SHA ?? "",
  };
  const flags = new Map([
    ["--policy", "policyPath"],
    ["--lock", "lockPath"],
    ["--output", "outputDirectory"],
    ["--repository-id", "repositoryId"],
    ["--pull-request", "pullRequestNumber"],
    ["--head-sha", "headSha"],
    ["--created-at", "createdAtUtc"],
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

function githubFetch(token) {
  return async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const hostname = new URL(url).hostname;
    if (token && (hostname === "github.com" || hostname === "api.github.com")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(url, { ...init, headers });
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parsePrepareCandidateArgs(argv, env);
  const policyBytes = await readFile(args.policyPath);
  const lockBytes = await readFile(args.lockPath);
  const policy = JSON.parse(policyBytes.toString("utf8"));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const now = args.createdAtUtc ? new Date(args.createdAtUtc) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error(`Invalid candidate creation time: ${args.createdAtUtc}`);
  }
  const index = await prepareCandidateBundle({
    policy,
    lock,
    lockBytes,
    outputDirectory: args.outputDirectory,
    fetchImpl: githubFetch(env.GITHUB_TOKEN || env.GH_TOKEN || ""),
    context: {
      repositoryId: args.repositoryId,
      pullRequestNumber: args.pullRequestNumber,
      headSha: args.headSha,
    },
    now,
  });
  process.stdout.write(
    `${JSON.stringify({ revision: index.revision, assetCount: index.assets.length })}\n`,
  );
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
