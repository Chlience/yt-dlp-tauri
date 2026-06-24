import assert from "node:assert/strict";
import test from "node:test";

import { releaseNotesForVersion, shouldShowReleaseNotes, stripTerminalSentencePunctuation } from "../src/release-notes.ts";

const changelog = `
# Changelog

## Unreleased

## 0.2.0 - 2026-06-24

### 中文

- 下载完成。
- 粘贴，选择，下载。

### English

- Download completed.
- Keeps ellipsis...

## 0.1.9 - 2026-06-24

### 中文

- 旧版本。

### English

- Previous version.
`;

test("shouldShowReleaseNotes only opens after a stored version changes", () => {
  assert.equal(shouldShowReleaseNotes(null, "0.2.0"), false);
  assert.equal(shouldShowReleaseNotes("", "0.2.0"), false);
  assert.equal(shouldShowReleaseNotes("v0.2.0", "0.2.0"), false);
  assert.equal(shouldShowReleaseNotes("0.1.9", "0.2.0"), true);
});

test("releaseNotesForVersion extracts localized bullets for the current version", () => {
  assert.deepEqual(releaseNotesForVersion(changelog, "v0.2.0", "zh"), {
    version: "0.2.0",
    items: ["下载完成", "粘贴，选择，下载"],
  });
  assert.deepEqual(releaseNotesForVersion(changelog, "0.2.0", "en"), {
    version: "0.2.0",
    items: ["Download completed", "Keeps ellipsis..."],
  });
});

test("stripTerminalSentencePunctuation removes only sentence-ending full stops", () => {
  assert.equal(stripTerminalSentencePunctuation("下载完成。"), "下载完成");
  assert.equal(stripTerminalSentencePunctuation("Paste, choose, download."), "Paste, choose, download");
  assert.equal(stripTerminalSentencePunctuation("Reading metadata..."), "Reading metadata...");
  assert.equal(stripTerminalSentencePunctuation("Already clean"), "Already clean");
});
