import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalComplianceJson,
  createComplianceReport,
} from "./toolchain/compliance-report.mjs";

const DEFAULTS = {
  policyPath: "toolchain-policy.json",
  lockPath: "toolchain-lock.json",
  outputPath: ".toolchain/publication/toolchain-compliance.json",
};

export function parseComplianceArgs(argv) {
  const result = { ...DEFAULTS };
  const flags = new Map([
    ["--policy", "policyPath"],
    ["--lock", "lockPath"],
    ["--output", "outputPath"],
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

function evidencePaths(policy) {
  const paths = new Set();
  for (const source of policy.sources ?? []) {
    for (const path of source.redistribution?.licenseFiles ?? []) paths.add(path);
    for (const path of source.redistribution?.noticeFiles ?? []) paths.add(path);
  }
  return [...paths].sort();
}

async function fileDescriptor(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) return null;
    const bytes = await readFile(path);
    return {
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function checkToolchainCompliance({
  policyPath = DEFAULTS.policyPath,
  lockPath = DEFAULTS.lockPath,
  outputPath = DEFAULTS.outputPath,
} = {}) {
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const files = {};
  for (const path of evidencePaths(policy)) {
    const descriptor = await fileDescriptor(path);
    if (descriptor) files[path] = descriptor;
  }
  const report = createComplianceReport({ policy, lock, files });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, canonicalComplianceJson(report), "utf8");
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const report = await checkToolchainCompliance(parseComplianceArgs(argv));
  process.stdout.write(
    `${JSON.stringify({
      revision: report.revision,
      passed: report.passed,
      failedSources: report.sources.filter((source) => !source.passed).map((source) => source.id),
    })}\n`,
  );
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
