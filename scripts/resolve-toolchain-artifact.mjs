import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalArtifactHandoffJson,
  createArtifactHandoff,
  resolveMergedPullRequest,
  selectValidationRun,
} from "./toolchain/artifact-handoff.mjs";

const DEFAULTS = {
  repository: "",
  repositoryId: "",
  commitSha: "",
  baseRef: "main",
  workflowPath: ".github/workflows/toolchain-validate.yml",
  lockPath: "toolchain-lock.json",
  outputPath: ".toolchain/handoff/handoff-report.json",
  githubOutputPath: "",
};

export function parseArtifactHandoffArgs(argv, env = {}) {
  const result = {
    ...DEFAULTS,
    repository: env.GITHUB_REPOSITORY ?? "",
    repositoryId: env.GITHUB_REPOSITORY_ID ?? "",
    commitSha: env.GITHUB_SHA ?? "",
    githubOutputPath: env.GITHUB_OUTPUT ?? "",
  };
  const flags = new Map([
    ["--repository", "repository"],
    ["--repository-id", "repositoryId"],
    ["--commit-sha", "commitSha"],
    ["--base-ref", "baseRef"],
    ["--workflow", "workflowPath"],
    ["--lock", "lockPath"],
    ["--output", "outputPath"],
    ["--github-output", "githubOutputPath"],
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

function githubHeaders(token) {
  const normalizedToken = String(token ?? "").trim();
  if (!normalizedToken) throw new Error("GITHUB_TOKEN or GH_TOKEN is required for artifact handoff");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${normalizedToken}`,
    "User-Agent": "yt-dlp-tauri-toolchain-handoff",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function githubErrorDetail(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.message === "string") return parsed.message.trim();
  } catch {
    // Use the bounded response body below.
  }
  return text.trim().slice(0, 300);
}

async function requestJson(path, { repository, headers, fetchImpl, apiBase }) {
  const url = new URL(`/repos/${repository}/${path}`, apiBase);
  const response = await fetchImpl(url, { headers });
  const body = await response.text();
  if (!response.ok) {
    const detail = githubErrorDetail(body);
    throw new Error(
      `GitHub API request failed for ${url.pathname}: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
    );
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`GitHub API response for ${url.pathname} is invalid JSON: ${error}`);
  }
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function workflowPathSegment(path) {
  return encodeURIComponent(path);
}

export async function resolveToolchainArtifact({
  repository,
  repositoryId,
  commitSha,
  baseRef = DEFAULTS.baseRef,
  workflowPath = DEFAULTS.workflowPath,
  lockPath = DEFAULTS.lockPath,
  outputPath = DEFAULTS.outputPath,
  githubOutputPath = DEFAULTS.githubOutputPath,
  token,
  fetchImpl = fetch,
  apiBase = "https://api.github.com",
}) {
  const headers = githubHeaders(token);
  const lockBytes = await readFile(lockPath);
  let lock;
  try {
    lock = JSON.parse(lockBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${lockPath}: ${error}`);
  }

  const pulls = await requestJson(`commits/${commitSha}/pulls`, {
    repository,
    headers,
    fetchImpl,
    apiBase,
  });
  const pullRequest = resolveMergedPullRequest({
    pulls,
    commitSha,
    repositoryId,
    baseRef,
  });
  const workflow = await requestJson(
    `actions/workflows/${workflowPathSegment(workflowPath)}`,
    { repository, headers, fetchImpl, apiBase },
  );
  if (workflow?.path !== workflowPath) {
    throw new Error(
      `Validation workflow path does not match: expected ${workflowPath}, got ${workflow?.path ?? "missing"}`,
    );
  }
  const runsPath = new URLSearchParams({
    event: "pull_request",
    head_sha: pullRequest.head.sha,
    status: "completed",
    per_page: "100",
  });
  const runResponse = await requestJson(
    `actions/workflows/${workflow.id}/runs?${runsPath}`,
    { repository, headers, fetchImpl, apiBase },
  );
  const run = selectValidationRun({
    runs: runResponse?.workflow_runs,
    workflowId: workflow.id,
    workflowPath,
    headSha: pullRequest.head.sha,
    repositoryId,
    pullRequestNumber: pullRequest.number,
  });
  const artifactResponse = await requestJson(`actions/runs/${run.id}/artifacts?per_page=100`, {
    repository,
    headers,
    fetchImpl,
    apiBase,
  });
  const report = createArtifactHandoff({
    repository,
    repositoryId,
    commitSha,
    revision: lock.revision,
    lockSha256: sha256(lockBytes),
    pullRequest,
    workflow: { id: workflow.id, path: workflow.path },
    run,
    artifacts: artifactResponse?.artifacts,
  });
  await writeAtomic(outputPath, canonicalArtifactHandoffJson(report));

  if (githubOutputPath) {
    const outputs = {
      run_id: report.runId,
      candidate_artifact_name: report.candidateArtifact.name,
      candidate_artifact_id: report.candidateArtifact.id,
      candidate_artifact_digest: report.candidateArtifact.digest,
      validation_artifact_name: report.validationArtifact.name,
      validation_artifact_id: report.validationArtifact.id,
      validation_artifact_digest: report.validationArtifact.digest,
      repository_id: report.repositoryId,
      pull_request: String(report.pullRequestNumber),
      head_sha: report.headSha,
      revision: report.revision,
      lock_sha256: report.lockSha256,
    };
    await appendFile(
      githubOutputPath,
      `${Object.entries(outputs)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
    );
  }
  return report;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArtifactHandoffArgs(argv, env);
  const report = await resolveToolchainArtifact({
    ...args,
    token: env.GITHUB_TOKEN || env.GH_TOKEN || "",
  });
  process.stdout.write(
    `${JSON.stringify({
      revision: report.revision,
      pullRequest: report.pullRequestNumber,
      runId: report.runId,
      candidateArtifactId: report.candidateArtifact.id,
    })}\n`,
  );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
