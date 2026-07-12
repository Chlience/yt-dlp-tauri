import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ArchiveChannelError,
  fetchStableToolchainManifest,
  verifyArchiveManifestBytes,
} from "../scripts/toolchain/archive-channel.mjs";

function fixture(sourceRevision = "20260712.1") {
  const revision = "20260712.2";
  const releaseTag = `toolchain-${revision}`;
  const sourceReleaseTag = `toolchain-${sourceRevision}`;
  const manifestName = `tools-manifest-${revision}.json`;
  const manifestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 4,
      revision,
      targets: [
        {
          target: "win-x64",
          tools: [
            {
              name: "yt-dlp",
              sourceUrl: `https://github.com/Chlience/yt-dlp-tauri-toolchain/releases/download/${sourceReleaseTag}/yt-dlp.exe`,
              sourceSize: 4,
              sourceSha256: "b".repeat(64),
              sha256: "c".repeat(64),
            },
          ],
        },
      ],
    }),
  );
  const digest = createHash("sha256").update(manifestBytes).digest("hex");
  const channel = {
    schemaVersion: 2,
    repository: "Chlience/yt-dlp-tauri-toolchain",
    revision,
    releaseTag,
    manifest: manifestName,
    sha256: digest,
  };
  const asset = {
    id: 41,
    name: manifestName,
    size: manifestBytes.length,
    digest: `sha256:${digest}`,
    browser_download_url: `https://github.com/Chlience/yt-dlp-tauri-toolchain/releases/download/${releaseTag}/${manifestName}`,
  };
  return { revision, releaseTag, manifestName, manifestBytes, channel, asset };
}

function jsonResponse(value: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

test("archive channel resolves one immutable revision and exact manifest bytes", async () => {
  const value = fixture();
  const requests: string[] = [];
  const fetchImpl = async (url: string) => {
    requests.push(url);
    if (url.endsWith("/releases/tags/toolchain-stable")) {
      return jsonResponse({
        body: `<!-- toolchain-channel\n${JSON.stringify(value.channel)}\n-->`,
      });
    }
    if (url.endsWith(`/releases/tags/${value.releaseTag}`)) {
      return jsonResponse({
        tag_name: value.releaseTag,
        draft: false,
        prerelease: false,
        immutable: true,
        assets: [value.asset],
      });
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => value.manifestBytes,
    };
  };

  const result = await fetchStableToolchainManifest({ fetchImpl });

  assert.equal(result.status, "available");
  assert.equal(result.channel.releaseTag, value.releaseTag);
  assert.equal(result.manifest.revision, value.revision);
  assert.equal(requests.length, 3);
});

test("archive channel rejects a mutable revision release", async () => {
  const value = fixture();
  const fetchImpl = async (url: string) => {
    if (url.endsWith("/releases/tags/toolchain-stable")) {
      return jsonResponse({
        body: `<!-- toolchain-channel\n${JSON.stringify(value.channel)}\n-->`,
      });
    }
    return jsonResponse({
      tag_name: value.releaseTag,
      draft: false,
      prerelease: false,
      immutable: false,
      assets: [value.asset],
    });
  };

  await assert.rejects(
    fetchStableToolchainManifest({ fetchImpl }),
    (error: unknown) =>
      error instanceof ArchiveChannelError &&
      error.failureClass === "archive-integrity",
  );
});

test("archive channel rejects source releases newer than the channel", () => {
  const value = fixture("20260713.1");

  assert.throws(
    () => verifyArchiveManifestBytes(value.channel, value.manifestBytes),
    /invalid runtime bytes/iu,
  );
});
