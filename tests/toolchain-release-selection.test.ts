import assert from "node:assert/strict";
import test from "node:test";

import {
  selectLatestStable,
  selectPreviousCompleteMonth,
} from "../scripts/toolchain/select-release.mjs";

test("latest stable ignores draft and prerelease releases", () => {
  const releases = [
    {
      tagName: "v2.8.0",
      draft: false,
      prerelease: false,
      publishedAt: "2026-07-08T00:00:00Z",
    },
    {
      tagName: "v3.0.0-rc.1",
      draft: false,
      prerelease: true,
      publishedAt: "2026-07-10T00:00:00Z",
    },
    {
      tagName: "v2.9.0",
      draft: false,
      prerelease: false,
      publishedAt: "2026-07-09T00:00:00Z",
    },
    {
      tagName: "v3.0.0",
      draft: true,
      prerelease: false,
      publishedAt: "2026-07-11T00:00:00Z",
    },
  ];

  assert.equal(selectLatestStable(releases).tagName, "v2.9.0");
  assert.equal(releases[0].tagName, "v2.8.0");
});

test("previous month selector chooses the final June autobuild in July", () => {
  const selected = selectPreviousCompleteMonth(
    [
      {
        tagName: "autobuild-2026-06-29-17-10",
        draft: false,
        prerelease: false,
        publishedAt: "2026-06-29T17:10:58Z",
      },
      {
        tagName: "autobuild-2026-06-30-16-38",
        draft: false,
        prerelease: false,
        publishedAt: "2026-06-30T16:38:32Z",
      },
      {
        tagName: "autobuild-2026-07-01-16-32",
        draft: false,
        prerelease: false,
        publishedAt: "2026-07-01T16:32:48Z",
      },
    ],
    new Date("2026-07-11T00:00:00Z"),
  );

  assert.equal(selected.tagName, "autobuild-2026-06-30-16-38");
});

test("previous month selector handles the January year boundary", () => {
  const selected = selectPreviousCompleteMonth(
    [
      {
        tagName: "autobuild-2025-12-31-16-38",
        draft: false,
        prerelease: false,
        publishedAt: "2025-12-31T16:38:32Z",
      },
      {
        tagName: "autobuild-2026-01-01-16-38",
        draft: false,
        prerelease: false,
        publishedAt: "2026-01-01T16:38:32Z",
      },
    ],
    new Date("2026-01-05T00:00:00Z"),
  );

  assert.equal(selected.tagName, "autobuild-2025-12-31-16-38");
});

test("selectors report when policy has no eligible release", () => {
  assert.throws(
    () =>
      selectLatestStable([
        {
          tagName: "v3.0.0-rc.1",
          draft: false,
          prerelease: true,
          publishedAt: "2026-07-10T00:00:00Z",
        },
      ]),
    /No stable release candidate found/,
  );
  assert.throws(
    () => selectPreviousCompleteMonth([], new Date("2026-07-11T00:00:00Z")),
    /No stable release candidate found for 2026-06/,
  );
});
