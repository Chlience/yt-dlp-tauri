import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createArtifactHandoff,
  resolveMergedPullRequest,
  selectCandidateArtifact,
  selectValidationRun,
} from "../scripts/toolchain/artifact-handoff.mjs";
import {
  parseArtifactHandoffArgs,
  resolveToolchainArtifact,
} from "../scripts/resolve-toolchain-artifact.mjs";

const repositoryId = 1250277749;
const commitSha = "a".repeat(40);
const headSha = "b".repeat(40);
const workflowId = 311325680;
const revision = "20260712.1";
const lockSha256 = "e".repeat(64);

function pull(overrides = {}) {
  return {
    id: 4036080348,
    number: 3,
    state: "closed",
    merged_at: "2026-07-12T05:00:00Z",
    merge_commit_sha: commitSha,
    base: {
      ref: "main",
      repo: { id: repositoryId },
    },
    head: {
      sha: headSha,
      repo: { id: repositoryId },
    },
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: 29175682626,
    workflow_id: workflowId,
    path: ".github/workflows/toolchain-validate.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: headSha,
    head_repository: { id: repositoryId },
    run_attempt: 2,
    created_at: "2026-07-12T04:00:00Z",
    html_url: "https://github.com/Chlience/yt-dlp-tauri/actions/runs/29175682626",
    pull_requests: [
      {
        number: 3,
        base: { repo: { id: repositoryId } },
        head: { sha: headSha, repo: { id: repositoryId } },
      },
    ],
    ...overrides,
  };
}

function artifact(name: string, id: number, overrides = {}) {
  return {
    id,
    name,
    size_in_bytes: 1234,
    expired: false,
    digest: `sha256:${"c".repeat(64)}`,
    archive_download_url: `https://api.github.com/repos/Chlience/yt-dlp-tauri/actions/artifacts/${id}/zip`,
    workflow_run: {
      id: 29175682626,
      head_sha: headSha,
      repository_id: repositoryId,
      head_repository_id: repositoryId,
    },
    ...overrides,
  };
}

test("merged commit resolves one same-repository pull request", () => {
  assert.equal(
    resolveMergedPullRequest({
      pulls: [pull()],
      commitSha,
      repositoryId,
      baseRef: "main",
    }).number,
    3,
  );
  assert.throws(
    () =>
      resolveMergedPullRequest({
        pulls: [pull({ head: { sha: headSha, repo: { id: 99 } } })],
        commitSha,
        repositoryId,
        baseRef: "main",
      }),
    /exactly one same-repository merged pull request/u,
  );
  assert.throws(
    () =>
      resolveMergedPullRequest({
        pulls: [pull(), pull({ number: 4 })],
        commitSha,
        repositoryId,
        baseRef: "main",
      }),
    /exactly one same-repository merged pull request/u,
  );
});

test("validation run selection requires exact workflow, head, repository, and PR", () => {
  const selected = selectValidationRun({
    runs: [
      run({ id: 10, conclusion: "failure" }),
      run({ id: 11, created_at: "2026-07-12T03:00:00Z" }),
      run({ id: 12, created_at: "2026-07-12T04:30:00Z" }),
    ],
    workflowId,
    workflowPath: ".github/workflows/toolchain-validate.yml",
    headSha,
    repositoryId,
    pullRequestNumber: 3,
  });

  assert.equal(selected.id, 12);
  assert.throws(
    () =>
      selectValidationRun({
        runs: [run({ head_repository: { id: 99 } })],
        workflowId,
        workflowPath: ".github/workflows/toolchain-validate.yml",
        headSha,
        repositoryId,
        pullRequestNumber: 3,
      }),
    /successful validation run/u,
  );
});

test("candidate artifact selection requires one live digest-bound artifact", () => {
  const selected = selectCandidateArtifact({
    artifacts: [
      artifact(`toolchain-candidate-${revision}`, 100),
      artifact("toolchain-validation-report", 101),
    ],
    revision,
    run: run(),
    repositoryId,
  });
  assert.equal(selected.digest, "c".repeat(64));

  assert.throws(
    () =>
      selectCandidateArtifact({
        artifacts: [
          artifact(`toolchain-candidate-${revision}`, 100),
          artifact(`toolchain-candidate-${revision}`, 102),
        ],
        revision,
        run: run(),
        repositoryId,
      }),
    /exactly one candidate artifact/u,
  );
  assert.throws(
    () =>
      selectCandidateArtifact({
        artifacts: [artifact(`toolchain-candidate-${revision}`, 100, { expired: true })],
        revision,
        run: run(),
        repositoryId,
      }),
    /expired/u,
  );
});

test("handoff report binds merge, PR run, candidate, and validation artifacts", () => {
  const report = createArtifactHandoff({
    repository: "Chlience/yt-dlp-tauri",
    repositoryId,
    commitSha,
    revision,
    lockSha256,
    pullRequest: pull(),
    workflow: {
      id: workflowId,
      path: ".github/workflows/toolchain-validate.yml",
    },
    run: run(),
    artifacts: [
      artifact(`toolchain-candidate-${revision}`, 100),
      artifact("toolchain-validation-report", 101, {
        digest: `sha256:${"d".repeat(64)}`,
      }),
    ],
  });

  assert.equal(report.mergeCommitSha, commitSha);
  assert.equal(report.lockSha256, lockSha256);
  assert.equal(report.pullRequestNumber, 3);
  assert.equal(report.headSha, headSha);
  assert.equal(report.candidateArtifact.id, "100");
  assert.equal(report.validationArtifact.digest, "d".repeat(64));
});

test("handoff CLI parses repository and exact main identity", () => {
  assert.deepEqual(
    parseArtifactHandoffArgs([
      "--repository",
      "Chlience/yt-dlp-tauri",
      "--repository-id",
      String(repositoryId),
      "--commit-sha",
      commitSha,
      "--lock",
      "lock.json",
      "--output",
      "handoff.json",
      "--github-output",
      "outputs.txt",
    ]),
    {
      repository: "Chlience/yt-dlp-tauri",
      repositoryId: String(repositoryId),
      commitSha,
      baseRef: "main",
      workflowPath: ".github/workflows/toolchain-validate.yml",
      lockPath: "lock.json",
      outputPath: "handoff.json",
      githubOutputPath: "outputs.txt",
    },
  );
});

test("handoff CLI resolves authenticated REST metadata and writes exact outputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "toolchain-handoff-"));
  const lockPath = join(directory, "lock.json");
  const outputPath = join(directory, "handoff.json");
  const githubOutputPath = join(directory, "github-output.txt");
  const lockBytes = Buffer.from(`${JSON.stringify({ revision }, null, 2)}\n`);
  await writeFile(lockPath, lockBytes);
  t.after(async () => {
    await Promise.all(
      [lockPath, outputPath, githubOutputPath].map((path) => unlink(path).catch(() => {})),
    );
    await rmdir(directory).catch(() => {});
  });

  const responses = new Map<string, unknown>([
    [`/repos/Chlience/yt-dlp-tauri/commits/${commitSha}/pulls`, [pull()]],
    [
      "/repos/Chlience/yt-dlp-tauri/actions/workflows/.github%2Fworkflows%2Ftoolchain-validate.yml",
      { id: workflowId, path: ".github/workflows/toolchain-validate.yml" },
    ],
    [
      `/repos/Chlience/yt-dlp-tauri/actions/workflows/${workflowId}/runs?event=pull_request&head_sha=${headSha}&status=completed&per_page=100`,
      { workflow_runs: [run()] },
    ],
    [
      "/repos/Chlience/yt-dlp-tauri/actions/runs/29175682626/artifacts?per_page=100",
      {
        artifacts: [
          artifact(`toolchain-candidate-${revision}`, 100),
          artifact("toolchain-validation-report", 101, {
            digest: `sha256:${"d".repeat(64)}`,
          }),
        ],
      },
    ],
  ]);
  const requests: string[] = [];
  const fetchImpl = async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    requests.push(key);
    assert.equal(init?.headers?.Authorization, "Bearer test-token");
    if (!responses.has(key)) return new Response("not found", { status: 404 });
    return Response.json(responses.get(key));
  };

  const report = await resolveToolchainArtifact({
    repository: "Chlience/yt-dlp-tauri",
    repositoryId,
    commitSha,
    lockPath,
    outputPath,
    githubOutputPath,
    token: "test-token",
    fetchImpl,
  });

  assert.equal(report.lockSha256, createHash("sha256").update(lockBytes).digest("hex"));
  assert.equal(report.candidateArtifact.id, "100");
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).runId, "29175682626");
  assert.match(await readFile(githubOutputPath, "utf8"), /candidate_artifact_id=100/u);
  assert.equal(requests.length, 4);
});
