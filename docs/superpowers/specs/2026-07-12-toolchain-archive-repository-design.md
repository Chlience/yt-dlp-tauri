# Toolchain Archive Repository Design

**Status:** Approved for implementation

**Date:** 2026-07-12

## Summary

Move every published yt-dlp-tauri tool asset under project control without adding
large binaries to the application Git repository. The main repository remains the
control plane for discovery, review, validation, and publication authorization. A
new public repository, `Chlience/yt-dlp-tauri-toolchain`, becomes the archive and
stable-channel data plane.

Pull-request validation downloads each unique upstream asset once, verifies it,
and preserves the exact bytes as a short-lived Actions artifact. Validation on the
merged `main` commit consumes and revalidates the same bytes. The publisher then
uploads those bytes to a draft release in the archive repository, verifies every
uploaded asset, publishes the release as immutable, advances the
`toolchain-stable` channel record through editable release notes, and refreshes the
legacy compatibility manifest.

The runtime never depends on an upstream release URL after a toolchain revision is
published.

## Decisions

| Area | Decision |
| --- | --- |
| Archive scope | yt-dlp, Deno, FFmpeg, and FFprobe for Windows x64 |
| Storage | GitHub Release assets in a separate public repository |
| Immutable unit | One `toolchain-<revision>` release per toolchain revision |
| Stable pointer | One pre-existing immutable `toolchain-stable` prerelease with editable notes |
| Byte custody | Preserve PR-validated bytes through main validation and publication |
| Deduplication | Reuse archive descriptors for unchanged assets |
| Source repository | Store only policy, lock, manifest, hashes, and provenance metadata |
| Legacy clients | Continue updating the v0.1.11 application-release manifest |
| Authorization | GitHub App token installed on both repositories |

## Goals

- Make every published toolchain revision installable without contacting upstream
  release hosts.
- Ensure the bytes validated in the pull request are the bytes published to the
  archive repository.
- Keep application releases independent from routine toolchain revisions.
- Preserve complete upstream identity, checksums, extracted hashes, licenses, and
  source provenance.
- Publish only after human merge and native validation of the exact `main` commit.
- Keep historical revisions available for deterministic rollback.
- Avoid repeatedly uploading unchanged assets.

## Non-Goals

- Store binaries in the main Git repository, Git LFS, or a Git submodule.
- Build upstream tools from source in this pipeline.
- Automatically merge toolchain pull requests.
- Treat public video-site availability as a blocking publication signal.
- Add a second cloud storage provider in the initial implementation.

## Repository Boundaries

### Main Repository

`Chlience/yt-dlp-tauri` owns:

- Tool selection policy and source allowlists.
- The reviewed toolchain lock and generated runtime manifest.
- Upstream discovery and emergency update pull requests.
- Candidate acquisition and native compatibility validation.
- Publication plans and authorization decisions.
- Desktop client channel, installation, and rollback behavior.
- The v0.1.11 compatibility manifest on the latest application release.

The main repository does not retain tool binaries in Git history.

### Archive Repository

`Chlience/yt-dlp-tauri-toolchain` owns:

- The immutable `toolchain-stable` channel release and its editable notes.
- Immutable revision releases.
- Tool archives and standalone executables.
- Immutable manifests and validation reports.
- License, checksum, build, and source-provenance assets.

The archive repository contains only a small explanatory README in Git. Tool
binaries are release assets.

## Release Model

### Bootstrap Order

GitHub release immutability applies only to releases created after it is enabled.
Bootstrap the archive repository in this order:

1. Create the public archive repository.
2. Create the `toolchain-stable` prerelease with an uninitialized channel body.
3. Enable release immutability in the archive repository settings.
4. Install the publishing GitHub App on the archive repository.
5. Publish the first immutable toolchain revision.
6. Update the existing channel body to promote that revision.

GitHub may lock the bootstrap release when its notes are updated after repository
immutability is enabled. Its tag and assets remain immutable while its title and
release notes remain editable, so the channel record continues to advance safely.

### Immutable Revision Release

Each revision uses a tag such as `toolchain-20260712.1`. The publisher:

1. Creates a normal draft release with `latest=false`.
2. Uploads every newly archived tool asset.
3. Uploads the revision manifest, validation report, and compliance materials.
4. Downloads every draft asset through the authenticated API and verifies size and
   SHA-256.
5. Publishes the draft, making its tag and assets immutable.
6. Verifies that GitHub reports the release as immutable.

The release notes record the source repository, merged commit SHA, pull request,
workflow run, lock digest, manifest digest, and changed source units.

### Stable Channel

The body of the existing `toolchain-stable` release contains one strict record:

```text
<!-- toolchain-channel
{"schemaVersion":2,"repository":"Chlience/yt-dlp-tauri-toolchain","revision":"20260712.1","releaseTag":"toolchain-20260712.1","manifest":"tools-manifest-20260712.1.json","sha256":"<64 lowercase hex>"}
-->
```

Updating this record is the final atomic promotion operation. An interrupted
publication leaves clients on the previous complete revision.

### Asset Naming

Asset names include source identity, upstream version, upstream asset stem, and a digest prefix.
Examples:

```text
yt-dlp-2026.07.04-yt-dlp-52fe3c26dcf71fbd.exe
deno-v2.9.2-deno-x86_64-pc-windows-msvc-5fe194d26ac5ef77.zip
ffmpeg-windows-autobuild-2026-06-30-16-38-ffmpeg-N-125365-g9a01c1cb6a-win64-gpl-99502f28cb80ab01.zip
```

Names are deterministic and must not be reused for different bytes. Full SHA-256
and size remain authoritative in the lock and publication report.

## Data Model

### Policy

Every source in `toolchain-policy.json` gains an archive and redistribution policy:

```json
{
  "archive": {
    "enabled": true,
    "repository": "Chlience/yt-dlp-tauri-toolchain",
    "assetNameTemplate": "{source}-{version}-{assetStem}-{sha256Prefix}{extension}"
  },
  "redistribution": {
    "licenseFiles": [],
    "requiredEvidence": [],
    "noticeFiles": []
  }
}
```

These fields are required for every source. Their array values are source-specific.
`requiredEvidence` uses reviewed identifiers such as `official-checksum`,
`binary-release`, `source-revision`, and `build-revision`. Publication is blocked
unless the resolver supplies every required item and every listed file exists.

### Lock

Each upstream asset keeps its current immutable upstream identity and adds a planned
or published archive descriptor:

```json
{
  "sourceUrl": "https://upstream.example/release/tool.zip",
  "size": 123,
  "sha256": "<upstream asset digest>",
  "archive": {
    "repository": "Chlience/yt-dlp-tauri-toolchain",
    "releaseTag": "toolchain-20260712.1",
    "assetName": "tool-target-version-digest.zip",
    "size": 123,
    "sha256": "<same asset digest>"
  }
}
```

For unchanged assets, the updater preserves the existing archive descriptor and its
historical release tag. For changed assets, it predicts the current revision tag and
deterministic asset name. Publication proves that every predicted URL exists before
promotion.

Archive identity follows the unique upstream byte object. References with the same
upstream URL, size, and SHA-256 receive the same archive descriptor and one release
asset. Target-specific upstream asset names remain distinguishable through
`assetStem`.

This provides incremental deduplication. Returning to an older digest may upload a
duplicate if that asset is no longer present in the active lock; global historical
deduplication is deferred.

### Runtime Manifest

Normal manifest generation uses archive URLs exclusively:

```text
https://github.com/Chlience/yt-dlp-tauri-toolchain/releases/download/
  toolchain-20260712.1/<asset-name>
```

Candidate validation uses verified local bundle bytes for descriptors assigned to
the proposed revision. Descriptors reused from historical revisions keep their
archive URLs during validation. Upstream URLs remain acquisition provenance in the
lock and candidate index, but native validation does not contact an upstream host
for a byte object that is already archived. The checked-in runtime manifest remains
byte-identical to the published revision manifest.

## Candidate Bundle

### Bundle Preparation

A new preparation job runs before the native validation matrix. It:

1. Reads the candidate lock.
2. Downloads every unique changed upstream asset.
3. Checks approved host, release identity, size, and full SHA-256.
4. Stores bytes under sanitized deterministic filenames.
5. Generates `candidate-assets.json` with source, target, upstream, archive, size,
   and digest descriptors.
6. Uploads the directory as `toolchain-candidate-<revision>` with short retention.

The bundle contains only files referenced by the lock. Archive extraction remains a
native validation responsibility.

### Native PR Validation

Every native job downloads the same candidate bundle and revalidates all bytes
against the lock before extraction. The installer accepts a verified local asset
directory as its source override.

The candidate runs even when the baseline fails. Baseline failures remain diagnostic
evidence. Publication depends on the candidate's supply-chain, executable, DASH,
and project checks. If the candidate also fails, validation fails.

Each successful PR run records the bundle artifact ID, digest, workflow run ID, PR
number, PR head SHA, head repository ID, and revision in its canonical validation
report. A PR run cannot know its future merge commit. The main handoff report adds
the exact merged `main` SHA after resolving the associated pull request.

## Merge and Main Validation

Before invoking the reusable native workflow, the main publication workflow:

1. Resolves the single merged pull request for the exact main commit.
2. Finds the latest successful Toolchain Validation run for that PR head SHA.
3. Requires one candidate artifact with the expected revision.
4. Downloads it with `actions:read` permission.
5. Verifies `candidate-assets.json` and every file against the merged lock.

The selected run must have `event=pull_request`, the expected workflow identity, and
the same repository as the base repository. Artifacts from forks, unrelated workflow
runs, ambiguous pull-request associations, or a different head SHA are rejected.

The exact-main native matrix then runs against this local bundle. It does not fetch
candidate binaries from upstream. The workflow re-uploads the verified bundle in
the main run so the publisher can consume artifacts from its own run.

If the PR artifact expired or cannot be matched unambiguously, publication stops and
the PR validation must be rerun.

## Publication Authorization

The main publisher obtains a GitHub App installation token scoped to the archive
repository. Required archive permissions are:

- Contents: write.
- Metadata: read.
- Administration: read, solely to verify that immutable releases are enabled.

The main repository `GITHUB_TOKEN` remains read-only for validation. After
exact-main validation succeeds, the publisher performs local prerequisite checks,
creates the repository-scoped App token, and uses it for read-only remote gates.
No archive mutation begins until the repository, immutable channel, and immutable
release setting all pass those gates.

The publication plan lists every asset as one of:

- `reuse`: an unchanged archive descriptor already points to an immutable release.
- `upload`: the descriptor points to the new revision release and exact bytes exist
  in the verified bundle.
- `metadata`: manifest, validation, license, or provenance material.

Any descriptor that cannot be resolved to exactly one verified operation blocks the
release.

## Client Changes

The new client fetches the archive channel endpoint:

```text
GET /repos/Chlience/yt-dlp-tauri-toolchain/releases/tags/toolchain-stable
```

It then:

1. Parses the strict schema-v2 channel record.
2. Fetches the exact immutable revision release by tag.
3. Selects exactly one named manifest asset.
4. Verifies release identity, asset size, and channel-advertised SHA-256.
5. Parses the manifest and installs only archive-repository URLs.
6. Verifies archive and extracted-file hashes before activation.

The bundled manifest remains the offline fallback. Existing transactional staging,
activation, previous-revision retention, and rollback behavior remain unchanged.

## Legacy v0.1.11 Compatibility

After channel promotion, the publisher continues replacing `tools-manifest.json` on
the latest normal application release. That compatibility manifest contains archive
repository URLs, so v0.1.11 clients gain durable downloads without understanding the
new channel.

This compatibility copy remains until a later reviewed decision retires v0.1.11
support. Enabling release immutability on the main application repository is outside
this migration because it would prevent that asset replacement.

## Freshness and Discovery

- Stable freshness checks verify archive URLs, sizes, and hashes.
- Weekly and emergency discovery continue querying approved upstream APIs.
- An upstream asset disappearing after archival does not invalidate a published
  revision.
- New candidates still require upstream provenance and policy compliance.
- Archive failures are classified separately from upstream discovery failures.

## Rollback

Rollback loads the historical immutable revision release and validation report from
the archive repository. It verifies every referenced archive asset and digest, reruns
native compatibility unless a protected bypass is approved, and changes only the
channel record in the stable release notes.

Rollback never copies or overwrites historical assets.

## Redistribution and Provenance

Archive eligibility applies independently to each source unit. The initial policy
must account for:

- yt-dlp executable license and corresponding source identity.
- Deno license and bundled third-party notices.
- Windows FFmpeg binary checksum, FFmpeg source revision, build-repository revision,
  GPL materials, and corresponding-source availability.

Missing legal or provenance evidence blocks publication for that source. The
pipeline does not silently retain an upstream runtime URL because the approved
archive model requires every runtime asset to be project-controlled.

## Failure Handling

| Failure | Result |
| --- | --- |
| Upstream unavailable before PR capture | Candidate generation or bundle preparation fails |
| Baseline unavailable but candidate passes | Record baseline diagnostic and continue candidate validation |
| Candidate bundle digest mismatch | Fail native validation |
| Candidate artifact expired before merge | Block publication and rerun PR validation |
| GitHub App token unavailable | Fail before archive mutation |
| Draft upload interrupted | Leave an unpromoted draft for inspection |
| Draft asset verification mismatch | Do not publish the revision |
| Immutable release publication fails | Keep prior channel active |
| Channel update fails | New immutable revision remains unpromoted |
| v0.1.11 compatibility update fails | Report publication failure; immutable revision and channel remain auditable |
| Client archive download fails | Keep the current active revision |

Automated cleanup does not delete failed drafts or orphaned assets. Maintainers
inspect and remove them through a separate, explicitly approved operation.

## Testing Strategy

### Unit Tests

- Archive descriptor parsing and validation.
- Deterministic asset naming.
- Preservation of unchanged archive descriptors.
- Runtime archive URL generation and upstream validation URL generation.
- Candidate bundle index canonicalization and digest checks.
- Schema-v2 channel parsing and rendering.
- Publication plan reuse, upload, and metadata operations.
- Rollback resolution across historical release tags.

### Workflow Contract Tests

- PR validation uses read-only permissions and uploads one candidate bundle.
- Candidate validation runs after a failed baseline.
- Main validation resolves an exact successful PR artifact.
- Publisher uses a GitHub App token for the archive repository.
- Revision release is draft until all assets verify.
- Channel promotion occurs after immutable publication.
- v0.1.11 compatibility update remains last.

### Integration Tests

- Bundle preparation from fixture upstream assets.
- Native installation from local bundle bytes without network access.
- Full archive and extracted-file hash verification.
- Publication dry run with reused and changed assets.
- Channel fetch, revision release lookup, and transactional install.
- Historical rollback with assets spread across multiple immutable releases.

### Native Acceptance

The first archive revision must pass on Windows x64:

- Candidate acquisition and hash verification.
- Executable version probes.
- Deterministic DASH generation, download, merge, and FFprobe checks.
- Archive upload and post-upload download verification.
- Client clean install from archive URLs.
- Client update failure preserving the previous active revision.

## Migration Sequence

1. Fix candidate validation so a dead baseline cannot block a repair candidate.
2. Add archive descriptors, deterministic naming, and policy validation.
3. Add candidate bundle preparation and local-asset native validation.
4. Add exact PR artifact resolution for main validation.
5. Create and bootstrap the archive repository and stable channel.
6. Enable archive-repository release immutability and install the GitHub App.
7. Add verified draft publication to a normal immutable release for every source unit.
8. Change the client channel and manifest source to the archive repository.
9. Retain and verify the v0.1.11 compatibility publication path.
10. Publish and exercise the first archived revision before releasing the migrated
    application client.

## Acceptance Criteria

- The runtime manifest contains no upstream tool download URLs.
- The first revision archives all 3 current unique assets, approximately 218 MiB.
- Later unchanged assets retain their historical immutable URLs and are not uploaded
  again.
- PR validation, exact-main validation, and publication use byte-identical candidate
  files.
- Every published revision has an immutable release, manifest, validation report,
  and complete compliance evidence.
- The channel never points to a draft, mutable revision asset, missing asset, or
  digest mismatch.
- A deleted upstream release cannot break installation or baseline validation of a
  published revision.
- v0.1.11 can install the archived toolchain through its compatibility manifest.
- Historical rollback succeeds without contacting upstream release hosts.
- No tool binary is committed to either repository's Git history.

## Operational Prerequisites

- Create `Chlience/yt-dlp-tauri-toolchain` as a public repository.
- Bootstrap `toolchain-stable` before enabling release immutability; treat it as
  immutable after its first post-enable update.
- Enable release immutability for future archive releases.
- Install the toolchain GitHub App on both repositories.
- Configure `TOOLCHAIN_BOT_CLIENT_ID` and `TOOLCHAIN_BOT_PRIVATE_KEY` in the main
  repository.
- Review and check in redistribution evidence requirements for every source unit.

Implementation must stop before the first real archive publication if any of these
prerequisites are incomplete.
