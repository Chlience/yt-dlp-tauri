import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { verifyCandidateBundle } from "./toolchain/candidate-bundle.mjs";

const DEFAULTS = {
  lockPath: "toolchain-lock.json",
  directory: ".toolchain/candidate",
  repositoryId: "",
  pullRequestNumber: "",
  headSha: "",
};

export function parseVerifyCandidateArgs(argv, env = {}) {
  const result = {
    ...DEFAULTS,
    repositoryId: env.GITHUB_REPOSITORY_ID ?? "",
    pullRequestNumber: env.TOOLCHAIN_PULL_REQUEST ?? "",
    headSha: env.TOOLCHAIN_HEAD_SHA ?? "",
  };
  const flags = new Map([
    ["--lock", "lockPath"],
    ["--directory", "directory"],
    ["--repository-id", "repositoryId"],
    ["--pull-request", "pullRequestNumber"],
    ["--head-sha", "headSha"],
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

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseVerifyCandidateArgs(argv, env);
  const lockBytes = await readFile(args.lockPath);
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const index = await verifyCandidateBundle({
    lock,
    lockBytes,
    directory: args.directory,
    expectedContext: {
      repositoryId: args.repositoryId,
      pullRequestNumber: args.pullRequestNumber,
      headSha: args.headSha,
    },
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
