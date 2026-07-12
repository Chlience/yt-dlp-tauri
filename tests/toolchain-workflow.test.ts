import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const CHECKOUT_SHA = "93cb6efe18208431cddfb8368fd83d5badbf9bfd";
const SETUP_NODE_SHA = "a0853c24544627f65ddf259abe73b1d18a591444";
const APP_TOKEN_SHA = "fee1f7d63c2ff003460e3d139729b119787bc349";
const RUST_TOOLCHAIN_SHA = "4be7066ada62dd38de10e7b70166bc74ed198c30";
const RUST_CACHE_SHA = "42dc69e1aa15d09112580998cf2ef0119e2e91ae";
const UPLOAD_ARTIFACT_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ARTIFACT_SHA = "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";

test("weekly workflow uses a GitHub App and one managed branch", () => {
  const workflow = readFileSync(".github/workflows/toolchain-discover.yml", "utf8");

  assert.match(workflow, /^name: Toolchain Discovery$/m);
  assert.match(workflow, /cron: "17 3 \* \* 1"/);
  assert.match(workflow, new RegExp(`actions/checkout@${CHECKOUT_SHA}`));
  assert.match(workflow, new RegExp(`actions/setup-node@${SETUP_NODE_SHA}`));
  assert.match(
    workflow,
    new RegExp(`actions/create-github-app-token@${APP_TOKEN_SHA}`),
  );
  assert.match(workflow, /TOOLCHAIN_BOT_APP_ID/);
  assert.match(workflow, /TOOLCHAIN_BOT_PRIVATE_KEY/);
  assert.match(workflow, /bot\/toolchain-weekly/);
  assert.match(workflow, /node scripts\/update-toolchain\.mjs/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /check-tool-source-urls\.mjs --source-mode upstream/);
  assert.match(workflow, /gh pr (create|edit)/);
});

test("freshness workflow creates focused emergency pull requests", () => {
  const workflow = readFileSync(".github/workflows/toolchain-freshness.yml", "utf8");

  assert.match(workflow, /cron: "41 4 \* \* \*"/);
  assert.match(workflow, /tool:\s*\n\s*description:/);
  assert.match(workflow, /reason:\s*\n\s*description:/);
  assert.match(workflow, /check-toolchain-freshness\.mjs/);
  assert.match(workflow, /--json-output/);
  assert.match(workflow, /--only "\$\{\{ matrix\.source \}\}"/);
  assert.match(workflow, /bot\/toolchain-emergency-/);
  assert.match(workflow, new RegExp(`actions/create-github-app-token@${APP_TOKEN_SHA}`));
  assert.match(workflow, /gh pr (create|edit)/);
});

test("toolchain automation pins every third-party action to a commit", () => {
  const workflows = [
    readFileSync(".github/workflows/toolchain-discover.yml", "utf8"),
    readFileSync(".github/workflows/toolchain-freshness.yml", "utf8"),
    readFileSync(".github/workflows/toolchain-validate.yml", "utf8"),
    readFileSync(".github/workflows/toolchain-canary.yml", "utf8"),
    readFileSync(".github/workflows/toolchain-publish.yml", "utf8"),
  ];

  for (const workflow of workflows) {
    for (const line of workflow.split("\n").filter((item) => /uses:/.test(item))) {
      if (/uses:\s+\.\//u.test(line)) continue;
      assert.match(line, /uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}\s*$/);
    }
  }
});

test("publisher validates exact main before promoting immutable assets", () => {
  const path = ".github/workflows/toolchain-publish.yml";
  assert.equal(existsSync(path), true);
  const workflow = readFileSync(path, "utf8");

  assert.match(workflow, /^name: Toolchain Publish$/m);
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]/u);
  assert.match(workflow, /paths:\s*\n\s*- toolchain-lock\.json\s*\n\s*- src-tauri\/tools-manifest\.json/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /group: toolchain-publish/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /^permissions:\s*\n\s*contents: read$/mu);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/toolchain-validate\.yml/u);
  assert.match(workflow, /publish:\s*\n\s*name: Publish validated toolchain[\s\S]*?permissions:\s*\n\s*contents: write/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /node scripts\/resolve-toolchain-artifact\.mjs/u);
  assert.match(workflow, /git\/ref\/heads\/main/u);
  assert.match(workflow, /toolchain-validation-report/u);
  assert.match(workflow, /node scripts\/publish-toolchain\.mjs[\s\\]+--input/u);
  assert.match(workflow, /Chlience\/yt-dlp-tauri-toolchain/u);
  assert.match(workflow, /toolchain-stable/u);
  assert.match(workflow, /releases\/latest/u);
  assert.match(
    workflow,
    /compatibility\/tools-manifest\.json"[\s\S]*?--clobber/u,
  );
  assert.doesNotMatch(workflow, /#tools-manifest\.json/u);
  assert.doesNotMatch(workflow, /toolchain-mirror-candidates/u);

  const upload = workflow.indexOf("Upload planned draft assets");
  const verify = workflow.indexOf("Verify every draft asset");
  const immutable = workflow.indexOf("Verify immutable revision");
  const promote = workflow.indexOf("Promote stable channel");
  const compatibility = workflow.indexOf("Update v0.1.11 compatibility");
  assert.ok(
    upload >= 0 &&
      verify > upload &&
      immutable > verify &&
      promote > immutable &&
      compatibility > promote,
  );
});

test("publisher scopes App authentication and gates every archive mutation", () => {
  const workflow = readFileSync(".github/workflows/toolchain-publish.yml", "utf8");

  assert.match(workflow, new RegExp(`actions/create-github-app-token@${APP_TOKEN_SHA}`));
  assert.match(workflow, /owner:\s*Chlience/u);
  assert.match(workflow, /repositories:\s*yt-dlp-tauri-toolchain/u);
  assert.match(workflow, /TOOLCHAIN_BOT_APP_ID/u);
  assert.match(workflow, /TOOLCHAIN_BOT_PRIVATE_KEY/u);
  assert.match(workflow, /repos\/\$\{ARCHIVE_REPOSITORY\}\/immutable-releases/u);
  assert.match(workflow, /X-GitHub-Api-Version:\s*2026-03-10/u);
  assert.match(workflow, /\.enabled == true/u);
  assert.match(workflow, /\.visibility == "public"/u);
  assert.match(workflow, /\.immutable == true/u);

  const localGate = workflow.indexOf("Check local publication prerequisites");
  const token = workflow.indexOf("Create archive publisher token");
  const remoteGate = workflow.indexOf("Check archive publication prerequisites");
  const draft = workflow.indexOf("Create immutable revision draft");
  assert.ok(localGate >= 0 && token > localGate && remoteGate > token && draft > remoteGate);
});

test("publisher verifies draft bytes and immutable release attestation before promotion", () => {
  const workflow = readFileSync(".github/workflows/toolchain-publish.yml", "utf8");

  assert.match(workflow, /--draft/u);
  const createDraft = workflow.slice(
    workflow.indexOf("Create immutable revision draft"),
    workflow.indexOf("Upload planned draft assets"),
  );
  assert.doesNotMatch(createDraft, /--prerelease/u);
  assert.match(workflow, /--latest=false/u);
  assert.match(workflow, /verifyUploadedAsset/u);
  assert.match(workflow, /id: revision_draft/u);
  assert.match(workflow, /prepare-toolchain-draft-uploads\.mjs/u);
  assert.match(
    workflow,
    /RELEASE_ID: \$\{\{ steps\.revision_draft\.outputs\.release_id \}\}/u,
  );
  assert.match(workflow, /releases\/\$\{RELEASE_ID\}/u);
  assert.match(workflow, /revision_state/u);
  assert.match(
    workflow,
    /steps\.publication_plan\.outputs\.revision_state != 'published'/u,
  );
  assert.match(workflow, /draft:\s*false/u);
  assert.match(workflow, /release\.prerelease !== false/u);
  assert.match(workflow, /\.immutable !== true/u);
  assert.match(
    workflow,
    /gh release verify "\$RELEASE_TAG" --repo "\$ARCHIVE_REPOSITORY"/u,
  );
  const draftUploads = workflow.slice(
    workflow.indexOf("Upload planned draft assets"),
    workflow.indexOf("Verify every draft asset"),
  );
  assert.doesNotMatch(draftUploads, /--clobber/u);
  assert.doesNotMatch(draftUploads, /\$path#\$name/u);
});

test("main handoff revalidates one exact pull request candidate artifact", () => {
  const workflow = readFileSync(".github/workflows/toolchain-publish.yml", "utf8");

  assert.match(
    workflow,
    /handoff:\s*\n[\s\S]*?permissions:\s*\n\s*actions: read\s*\n\s*contents: read\s*\n\s*pull-requests: read/u,
  );
  assert.match(workflow, /node scripts\/resolve-toolchain-artifact\.mjs/u);
  assert.match(workflow, /run-id: \$\{\{ steps\.resolve\.outputs\.run_id \}\}/u);
  assert.match(workflow, /github-token: \$\{\{ github\.token \}\}/u);
  assert.match(workflow, /node scripts\/verify-toolchain-candidate\.mjs/u);
  assert.match(workflow, /validatePublicationReport/u);
  assert.match(workflow, /name: \$\{\{ steps\.resolve\.outputs\.candidate_artifact_name \}\}/u);
  assert.match(workflow, /retention-days:\s*7/u);
  assert.match(workflow, /validation:\s*\n[\s\S]*?needs: handoff/u);
  assert.match(
    workflow,
    /candidate_artifact_id: \$\{\{ needs\.handoff\.outputs\.candidate_artifact_id \}\}/u,
  );
  assert.match(
    workflow,
    /candidate_artifact_digest: \$\{\{ needs\.handoff\.outputs\.candidate_artifact_digest \}\}/u,
  );
  assert.doesNotMatch(workflow, /pull_request_target|secrets: inherit/u);
});

test("rollback revalidates historical revisions unless a protected environment approves a skip", () => {
  const publisher = readFileSync(".github/workflows/toolchain-publish.yml", "utf8");
  const validation = readFileSync(".github/workflows/toolchain-validate.yml", "utf8");

  assert.match(publisher, /rollback_revision:\s*\n\s*description:/u);
  assert.match(publisher, /reason:\s*\n\s*description:/u);
  assert.match(publisher, /dry_run:\s*\n[\s\S]*?type: boolean/u);
  assert.match(publisher, /skip_revalidation:\s*\n[\s\S]*?type: boolean/u);
  assert.match(publisher, /with:\s*\n\s*rollback_revision: \$\{\{ inputs\.rollback_revision/u);
  assert.match(publisher, /environment: toolchain-rollback/u);
  assert.match(publisher, /protection_rules[\s\S]*?required_reviewers/u);
  assert.match(publisher, /archiveRepository/u);
  assert.match(publisher, /Promote rollback channel/u);
  assert.match(publisher, /Promoted rollback channel differs from the validated plan/u);
  assert.match(publisher, /Record rollback decision/u);
  assert.match(publisher, /application-release-after-upload\.json/u);
  assert.match(publisher, /steps\.publication_plan\.outputs\.dry_run != 'true'/u);

  assert.match(validation, /workflow_call:\s*\n\s*inputs:\s*\n\s*rollback_revision:/u);
  assert.match(validation, /ROLLBACK_REVISION/u);
  assert.match(validation, /tools-manifest-\$\{rollbackRevision\}\.json/u);
  assert.match(validation, /toolchain-validation-\$\{rollbackRevision\}\.json/u);
  assert.match(validation, /historical-validation\.json/u);
});

test("validation workflow uses native targets with read-only permissions", () => {
  const workflow = readFileSync(".github/workflows/toolchain-validate.yml", "utf8");

  assert.match(workflow, /contents: read/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /windows-latest/);
  assert.doesNotMatch(workflow, /macos|darwin|apple/iu);
  assert.match(workflow, /name: toolchain-validation/);
  assert.match(workflow, /toolchain-validation-report/);
  assert.match(workflow, /toolchain-candidate-/u);
  assert.match(workflow, new RegExp(`dtolnay/rust-toolchain@${RUST_TOOLCHAIN_SHA}`));
  assert.match(workflow, new RegExp(`Swatinem/rust-cache@${RUST_CACHE_SHA}`));
  assert.match(workflow, new RegExp(`actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`));
  assert.match(workflow, new RegExp(`actions/download-artifact@${DOWNLOAD_ARTIFACT_SHA}`));
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|secrets: inherit/);
});

test("validation prepares one candidate bundle and reuses it on native runners", () => {
  const workflow = readFileSync(".github/workflows/toolchain-validate.yml", "utf8");

  assert.match(workflow, /prepare-candidate:/u);
  assert.match(workflow, /node scripts\/prepare-toolchain-candidate\.mjs/u);
  assert.match(workflow, /node scripts\/verify-toolchain-candidate\.mjs/u);
  assert.match(workflow, /retention-days:\s*7/u);
  assert.match(workflow, /compression-level:\s*0/u);
  assert.match(workflow, /artifact-id/u);
  assert.match(workflow, /artifact-digest/u);
  assert.match(
    workflow,
    /elif \[\[ -n "\$PROVIDED_ARTIFACT" \|\| -n "\$PROVIDED_ARTIFACT_ID"/u,
  );
  assert.equal(
    workflow.match(
      /if: \$\{\{ inputs\.rollback_revision == '' && inputs\.candidate_artifact_name == '' \}\}/gu,
    )?.length,
    3,
  );
  assert.doesNotMatch(workflow, /github\.event_name != 'workflow_call'/u);
  assert.match(workflow, /needs:\s*prepare-candidate/u);
  assert.match(workflow, /sourceMode:\s*"candidate"/u);
  assert.match(workflow, /--asset-root\s+\.toolchain\/candidate/u);
  assert.match(
    workflow,
    /Merge and validate native reports[\s\S]*?env:\s*\n\s*COMMIT_SHA: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u,
  );
});

test("validation workflow runs baseline first and diagnoses source units", () => {
  const workflow = readFileSync(".github/workflows/toolchain-validate.yml", "utf8");
  const baseline = workflow.indexOf("Baseline smoke");
  const candidate = workflow.indexOf("Candidate smoke");

  assert.ok(baseline >= 0 && candidate > baseline);
  assert.match(workflow, /Diagnostic yt-dlp/);
  assert.match(workflow, /Diagnostic Deno/);
  assert.match(workflow, /Diagnostic FFmpeg/);
  assert.match(workflow, /candidate_smoke\.outcome != 'success'/);
  assert.match(workflow, /Infrastructure baseline failed/);
  assert.match(workflow, /Candidate public-site Canary/);
  assert.match(workflow, /toolchain-canary\.json/);
  assert.match(workflow, /blocking: false/);
  const candidateBlock = workflow.slice(candidate, workflow.indexOf("Candidate deterministic compatibility"));
  assert.doesNotMatch(candidateBlock, /baseline_smoke|baseline_compatibility/u);
  assert.doesNotMatch(workflow, /Upload toolchain mirror candidates/u);
});

test("validation accepts a legacy baseline without a toolchain lock", () => {
  const workflow = readFileSync(".github/workflows/toolchain-validate.yml", "utf8");

  assert.match(workflow, /const tryShowBaseline = \(path\) =>/u);
  assert.match(
    workflow,
    /const baselineManifestJson = showBaseline\("src-tauri\/tools-manifest\.json"\)/u,
  );
  assert.match(
    workflow,
    /const baselineLockJson = tryShowBaseline\("toolchain-lock\.json"\)/u,
  );
  assert.match(workflow, /baselineLockJson \?\? "null\\n"/u);
  assert.match(workflow, /candidateManifest\.targets\.map\(\(candidateTarget\)/u);
  assert.doesNotMatch(workflow, /Candidate is missing \$\{baselineTarget\.target\}/u);
});

test("repository has one toolchain updater", () => {
  assert.equal(existsSync(".github/workflows/update-yt-dlp.yml"), false);
  assert.equal(existsSync("scripts/update-yt-dlp-manifest.mjs"), false);
  assert.equal(existsSync("scripts/update-toolchain.mjs"), true);
});

test("stable Canary is daily, stateful, deduplicated, and non-blocking", () => {
  const workflow = readFileSync(".github/workflows/toolchain-canary.yml", "utf8");

  assert.match(workflow, /cron: "53 5 \* \* \*"/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /toolchain-stable/);
  assert.match(workflow, /scripts\/toolchain\/archive-channel\.mjs/);
  assert.match(workflow, /scripts\/toolchain\/canary\.mjs/);
  assert.match(workflow, /canary-state/);
  assert.match(workflow, /actions\/artifacts\?name=canary-state/);
  assert.match(workflow, /\[Toolchain Canary\]/);
  assert.match(workflow, /state: "open"/);
  assert.match(workflow, /state: "closed"/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets: inherit/);
});

test("stable consumers resolve the archive channel and revision release", () => {
  for (const path of [
    ".github/workflows/toolchain-canary.yml",
    ".github/workflows/toolchain-validate.yml",
  ]) {
    const workflow = readFileSync(path, "utf8");
    assert.match(workflow, /Chlience\/yt-dlp-tauri-toolchain/u);
    assert.match(workflow, /releaseTag/u);
    assert.match(workflow, /immutable/u);
  }
});
