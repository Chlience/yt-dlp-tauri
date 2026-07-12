const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[0-9]{8}\.[1-9][0-9]*$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value === "number") return String(requirePositiveInteger(value, label));
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) return value;
  throw new Error(`${label} must be a positive integer`);
}

function requireCommitSha(value, label) {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character commit SHA`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireRevision(value) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    throw new Error(`Invalid toolchain revision: ${value}`);
  }
  return value;
}

function requireRepository(value) {
  const repository = requireString(value, "GitHub repository");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return repository;
}

function identifierEquals(value, expected) {
  try {
    return requireIdentifier(value, "Identifier") === requireIdentifier(expected, "Identifier");
  } catch {
    return false;
  }
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function resolveMergedPullRequest({ pulls, commitSha, repositoryId, baseRef }) {
  const expectedCommit = requireCommitSha(commitSha, "Main commit SHA");
  const expectedRepositoryId = requireIdentifier(repositoryId, "Repository ID");
  const expectedBaseRef = requireString(baseRef, "Base ref");
  const matches = requireArray(pulls, "Associated pull requests").filter((pullValue) => {
    if (!pullValue || typeof pullValue !== "object" || Array.isArray(pullValue)) return false;
    return (
      pullValue.state === "closed" &&
      validTimestamp(pullValue.merged_at) &&
      pullValue.merge_commit_sha === expectedCommit &&
      pullValue.base?.ref === expectedBaseRef &&
      identifierEquals(pullValue.base?.repo?.id, expectedRepositoryId) &&
      identifierEquals(pullValue.head?.repo?.id, expectedRepositoryId) &&
      COMMIT_SHA_PATTERN.test(pullValue.head?.sha ?? "") &&
      Number.isSafeInteger(pullValue.number) &&
      pullValue.number > 0
    );
  });

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one same-repository merged pull request for ${expectedCommit}; found ${matches.length}`,
    );
  }
  return matches[0];
}

function runMatchesPullRequest(run, pullRequestNumber, headSha, repositoryId) {
  if (!Array.isArray(run.pull_requests)) return false;
  const matches = run.pull_requests.filter(
    (pull) =>
      pull?.number === pullRequestNumber &&
      pull?.head?.sha === headSha &&
      identifierEquals(pull?.head?.repo?.id, repositoryId) &&
      identifierEquals(pull?.base?.repo?.id, repositoryId),
  );
  return matches.length === 1 && run.pull_requests.length === 1;
}

function compareRunsNewestFirst(left, right) {
  const timestampDifference = Date.parse(right.created_at) - Date.parse(left.created_at);
  if (timestampDifference !== 0) return timestampDifference;
  return Number(right.id) - Number(left.id);
}

export function selectValidationRun({
  runs,
  workflowId,
  workflowPath,
  headSha,
  repositoryId,
  pullRequestNumber,
}) {
  const expectedWorkflowId = requireIdentifier(workflowId, "Validation workflow ID");
  const expectedWorkflowPath = requireString(workflowPath, "Validation workflow path");
  const expectedHeadSha = requireCommitSha(headSha, "Pull request head SHA");
  const expectedRepositoryId = requireIdentifier(repositoryId, "Repository ID");
  const expectedPullRequest = requirePositiveInteger(
    pullRequestNumber,
    "Pull request number",
  );
  const matches = requireArray(runs, "Validation workflow runs")
    .filter((run) => {
      if (!run || typeof run !== "object" || Array.isArray(run)) return false;
      return (
        identifierEquals(run.workflow_id, expectedWorkflowId) &&
        run.path === expectedWorkflowPath &&
        run.event === "pull_request" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.head_sha === expectedHeadSha &&
        identifierEquals(run.head_repository?.id, expectedRepositoryId) &&
        Number.isSafeInteger(run.id) &&
        run.id > 0 &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0 &&
        validTimestamp(run.created_at) &&
        runMatchesPullRequest(
          run,
          expectedPullRequest,
          expectedHeadSha,
          expectedRepositoryId,
        )
      );
    })
    .sort(compareRunsNewestFirst);

  if (matches.length === 0) {
    throw new Error(
      `No successful validation run matched pull request ${expectedPullRequest} at ${expectedHeadSha}`,
    );
  }
  return matches[0];
}

function normalizeArtifactDigest(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is missing its SHA-256 digest`);
  const match = value.match(/^sha256:([a-f0-9]{64})$/u);
  if (!match) throw new Error(`${label} has an invalid SHA-256 digest`);
  return match[1];
}

function normalizeArtifactUrl(value, artifactId, repository) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Artifact archive download URL is invalid");
  }
  const expectedPath = repository
    ? `/repos/${repository}/actions/artifacts/${artifactId}/zip`
    : `/repos/[^/]+/[^/]+/actions/artifacts/${artifactId}/zip`;
  const pathMatches = repository
    ? url.pathname === expectedPath
    : new RegExp(`^${expectedPath}$`, "u").test(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !pathMatches
  ) {
    throw new Error("Artifact archive download URL does not match its repository and ID");
  }
  return url.href;
}

function selectArtifact({ artifacts, name, label, run, repositoryId, repository }) {
  const expectedName = requireString(name, `${label} name`);
  const expectedRepositoryId = requireIdentifier(repositoryId, "Repository ID");
  const expectedRunId = requireIdentifier(run?.id, "Validation run ID");
  const expectedHeadSha = requireCommitSha(run?.head_sha, "Validation run head SHA");
  const named = requireArray(artifacts, "Workflow artifacts").filter(
    (artifact) => artifact?.name === expectedName,
  );
  if (named.length !== 1) {
    throw new Error(`Expected exactly one ${label} named ${expectedName}; found ${named.length}`);
  }
  const artifact = requireObject(named[0], label);
  if (artifact.expired === true) throw new Error(`${label} ${expectedName} has expired`);
  if (artifact.expired !== false) throw new Error(`${label} ${expectedName} has invalid expiry state`);
  const id = requireIdentifier(artifact.id, `${label} ID`);
  const size = requirePositiveInteger(artifact.size_in_bytes, `${label} size`);
  if (
    !identifierEquals(artifact.workflow_run?.id, expectedRunId) ||
    artifact.workflow_run?.head_sha !== expectedHeadSha ||
    !identifierEquals(artifact.workflow_run?.repository_id, expectedRepositoryId) ||
    !identifierEquals(artifact.workflow_run?.head_repository_id, expectedRepositoryId)
  ) {
    throw new Error(`${label} workflow identity does not match the selected validation run`);
  }
  return {
    id,
    name: expectedName,
    size,
    digest: normalizeArtifactDigest(artifact.digest, label),
    archiveDownloadUrl: normalizeArtifactUrl(
      artifact.archive_download_url,
      id,
      repository,
    ),
  };
}

export function selectCandidateArtifact({
  artifacts,
  revision,
  run,
  repositoryId,
  repository,
}) {
  return selectArtifact({
    artifacts,
    name: `toolchain-candidate-${requireRevision(revision)}`,
    label: "candidate artifact",
    run,
    repositoryId,
    repository,
  });
}

export function createArtifactHandoff({
  repository,
  repositoryId,
  commitSha,
  revision,
  lockSha256,
  pullRequest,
  workflow,
  run,
  artifacts,
}) {
  const normalizedRepository = requireRepository(repository);
  const normalizedRepositoryId = requireIdentifier(repositoryId, "Repository ID");
  const normalizedCommit = requireCommitSha(commitSha, "Main commit SHA");
  const normalizedRevision = requireRevision(revision);
  const normalizedLockSha256 = requireSha256(lockSha256, "Toolchain lock SHA-256");
  const normalizedPull = requireObject(pullRequest, "Merged pull request");
  const pullRequestNumber = requirePositiveInteger(
    normalizedPull.number,
    "Pull request number",
  );
  if (normalizedPull.merge_commit_sha !== normalizedCommit) {
    throw new Error("Merged pull request does not match the main commit");
  }
  const headSha = requireCommitSha(normalizedPull.head?.sha, "Pull request head SHA");
  const headRepositoryId = requireIdentifier(
    normalizedPull.head?.repo?.id,
    "Pull request head repository ID",
  );
  if (headRepositoryId !== normalizedRepositoryId) {
    throw new Error("Pull request head repository does not match the base repository");
  }
  const workflowValue = requireObject(workflow, "Validation workflow");
  const workflowId = requireIdentifier(workflowValue.id, "Validation workflow ID");
  const workflowPath = requireString(workflowValue.path, "Validation workflow path");
  const runId = requireIdentifier(run?.id, "Validation run ID");
  const runAttempt = requirePositiveInteger(run?.run_attempt, "Validation run attempt");
  const runUrl = requireString(run?.html_url, "Validation run URL");
  const candidateArtifact = selectCandidateArtifact({
    artifacts,
    revision: normalizedRevision,
    run,
    repositoryId: normalizedRepositoryId,
    repository: normalizedRepository,
  });
  const validationArtifact = selectArtifact({
    artifacts,
    name: "toolchain-validation-report",
    label: "validation artifact",
    run,
    repositoryId: normalizedRepositoryId,
    repository: normalizedRepository,
  });

  return {
    schemaVersion: 1,
    repository: normalizedRepository,
    repositoryId: normalizedRepositoryId,
    mergeCommitSha: normalizedCommit,
    revision: normalizedRevision,
    lockSha256: normalizedLockSha256,
    pullRequestNumber,
    headSha,
    headRepositoryId,
    workflowId,
    workflowPath,
    runId,
    runAttempt,
    runUrl,
    candidateArtifact,
    validationArtifact,
  };
}

export function canonicalArtifactHandoffJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
