# FFmpeg Redistribution Procedure

This procedure applies when `yt-dlp-tauri` republishes the Windows GPL FFmpeg archive selected by `ffmpeg-windows` in `toolchain-lock.json`. Direct installation from the approved upstream URL does not create a project mirror and remains the default fallback.

## Required Evidence

A mirror candidate is eligible only when one provenance record ties all of the following to the exact locked binary:

1. The immutable FFmpeg-Builds release URL, release ID, asset ID, asset name, byte size, and SHA-256.
2. The release's `checksums.sha256` URL and the exact checksum entry for the locked asset.
3. The full 40-character FFmpeg source commit resolved from the revision encoded in the asset name.
4. The full 40-character FFmpeg-Builds commit resolved from the immutable release tag.
5. The applicable GPL license text, `THIRD-PARTY-NOTICES.md`, and the FFmpeg-Builds license notice.
6. Durable access to the corresponding FFmpeg source and the exact build scripts used for the binary.

Branch names, short commits, `latest` URLs, digest mismatches, missing license paths, and ambiguous checksum entries make the candidate ineligible.

## Validation

The Windows native validation job performs these steps:

1. Read the selected `ffmpeg-windows` source from `toolchain-lock.json`.
2. Query the authenticated GitHub API for the exact release, binary asset, checksum asset, and tag object.
3. Resolve annotated tags until they identify a build-repository commit.
4. Resolve the FFmpeg revision from the official `FFmpeg/FFmpeg` repository.
5. Verify the checksum file entry and downloaded binary against the lock.
6. Run the shared installer, executable probes, and deterministic DASH integration.
7. Emit `ffmpeg-provenance-<revision>.json` and a versioned mirror candidate only after every provenance check passes.

The provenance JSON records immutable commit and archive URLs. Before publishing a binary mirror, the release must also provide the corresponding FFmpeg source and build-script archives, or another durable method reviewed for the same GPL obligations. Source archives must be identified by the full commits in the provenance record.

## Publication And Fallback

Mirror filenames include the monotonic toolchain revision and are never overwritten. The publisher verifies every uploaded byte from its final GitHub Release URL before promotion.

When evidence or corresponding-source material is incomplete, the publisher skips the mirror and leaves the approved upstream FFmpeg URL in the manifest. A missing mirror must not block an otherwise compatible toolchain revision.

This automated gate preserves compliance evidence and prevents accidental redistribution without the required records. It does not replace legal review of a particular FFmpeg build, enabled codec set, or distribution method.
