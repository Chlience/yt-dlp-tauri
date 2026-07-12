import assert from "node:assert/strict";
import test from "node:test";

import {
  compareToolchainRevisions,
  parseChannelRecord,
  renderChannelRecord,
  selectManifestAsset,
} from "../scripts/toolchain/channel.mjs";

function channelFixture(overrides = {}) {
  return {
    schemaVersion: 2,
    repository: "Chlience/yt-dlp-tauri-toolchain",
    revision: "20260711.1",
    releaseTag: "toolchain-20260711.1",
    manifest: "tools-manifest-20260711.1.json",
    sha256: "a".repeat(64),
    ...overrides,
  };
}

test("channel renderer preserves human release notes", () => {
  const body = "# Stable toolchain\n\nHuman notes\n";
  const next = renderChannelRecord(body, channelFixture());

  assert.match(next, /Human notes/u);
  assert.deepEqual(parseChannelRecord(next), channelFixture());
});

test("channel parser rejects duplicate records", () => {
  const marker = renderChannelRecord("", channelFixture());

  assert.throws(
    () => parseChannelRecord(`${marker}\n${marker}`),
    /multiple toolchain channel records/u,
  );
});

test("channel renderer replaces one record without changing human notes", () => {
  const original = renderChannelRecord("Before\n", channelFixture());
  const nextRecord = channelFixture({
    revision: "20260712.1",
    releaseTag: "toolchain-20260712.1",
    manifest: "tools-manifest-20260712.1.json",
    sha256: "b".repeat(64),
  });
  const replaced = renderChannelRecord(original, nextRecord);

  assert.match(replaced, /^Before$/mu);
  assert.doesNotMatch(replaced, /20260711\.1/u);
  assert.deepEqual(parseChannelRecord(replaced), nextRecord);
});

test("channel parser rejects unknown fields and mismatched manifest names", () => {
  const unknown = renderChannelRecord("", channelFixture()).replace(
    `"sha256":"${"a".repeat(64)}"`,
    `"sha256":"${"a".repeat(64)}","extra":true`,
  );
  assert.throws(() => parseChannelRecord(unknown), /unknown fields/u);

  const mismatched = `<!-- toolchain-channel\n${JSON.stringify({
    ...channelFixture(),
    manifest: "tools-manifest-20260710.1.json",
  })}\n-->\n`;
  assert.throws(() => parseChannelRecord(mismatched), /must match revision/u);

  const wrongRepository = `<!-- toolchain-channel\n${JSON.stringify({
    ...channelFixture(),
    repository: "someone/else",
  })}\n-->\n`;
  assert.throws(() => parseChannelRecord(wrongRepository), /archive repository/u);

  const wrongRelease = `<!-- toolchain-channel\n${JSON.stringify({
    ...channelFixture(),
    releaseTag: "toolchain-20260710.1",
  })}\n-->\n`;
  assert.throws(() => parseChannelRecord(wrongRelease), /release tag must match/u);
});

test("channel parser rejects unterminated markers and uppercase digests", () => {
  assert.throws(
    () => parseChannelRecord("<!-- toolchain-channel\n{}"),
    /not terminated/u,
  );
  const uppercase = `<!-- toolchain-channel\n${JSON.stringify({
    ...channelFixture(),
    sha256: "A".repeat(64),
  })}\n-->\n`;
  assert.throws(() => parseChannelRecord(uppercase), /lowercase SHA-256/u);

  for (const revision of ["20260229.1", "20260712.4294967296"]) {
    const invalidRevision = `<!-- toolchain-channel\n${JSON.stringify({
      ...channelFixture(),
      revision,
      releaseTag: `toolchain-${revision}`,
      manifest: `tools-manifest-${revision}.json`,
    })}\n-->\n`;
    assert.throws(() => parseChannelRecord(invalidRevision), /Invalid toolchain channel revision/u);
  }
  assert.equal(compareToolchainRevisions("20260712.4294967295", "20260712.1"), 1);
});

test("manifest asset selection requires one exact HTTPS asset", () => {
  const record = channelFixture();
  const asset = {
    id: 123,
    name: record.manifest,
    browser_download_url:
      "https://github.com/Chlience/yt-dlp-tauri-toolchain/releases/download/toolchain-20260711.1/tools-manifest-20260711.1.json",
    size: 1024,
  };
  const release = {
    tag_name: record.releaseTag,
    draft: false,
    immutable: true,
    assets: [asset],
  };

  assert.equal(selectManifestAsset(release, record), asset);
  assert.throws(
    () => selectManifestAsset({ ...release, assets: [asset, { ...asset, id: 456 }] }, record),
    /exactly one release asset/u,
  );
  assert.throws(
    () =>
      selectManifestAsset(
        {
          ...release,
          assets: [{ ...asset, browser_download_url: "http://example.test/manifest" }],
        },
        record,
      ),
    /HTTPS download URL/u,
  );
  assert.throws(
    () => selectManifestAsset({ ...release, immutable: false }, record),
    /immutable/u,
  );
});
