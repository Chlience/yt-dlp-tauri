import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { fetchGitHubReleases } from "../scripts/toolchain/github-releases.mjs";

const githubFixture = JSON.parse(
  readFileSync("tests/fixtures/toolchain/github-releases.json", "utf8"),
);

test("GitHub adapter authenticates, paginates, and normalizes releases", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await fetchGitHubReleases("yt-dlp/yt-dlp", {
    token: "test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const page = calls.length;
      return new Response(JSON.stringify([githubFixture[page - 1]]), {
        headers:
          page === 1
            ? {
                link: '<https://api.github.com/repositories/1039520/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1039520/releases?per_page=100&page=2>; rel="last"',
              }
            : undefined,
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /repos\/yt-dlp\/yt-dlp\/releases\?per_page=100&page=1$/);
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Bearer test-token",
  );
  assert.equal(
    (calls[0].init?.headers as Record<string, string>)["X-GitHub-Api-Version"],
    "2022-11-28",
  );
  assert.deepEqual(result[0], {
    id: 7,
    tagName: "2026.07.04",
    name: "yt-dlp 2026.07.04",
    draft: false,
    prerelease: false,
    createdAt: "2026-07-04T10:00:00Z",
    publishedAt: "2026-07-04T10:05:00Z",
    htmlUrl: "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.04",
    assets: [
      {
        id: 70,
        name: "yt-dlp.exe",
        url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe",
        size: 19283746,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        contentType: "application/vnd.microsoft.portable-executable",
        updatedAt: "2026-07-04T10:04:00Z",
      },
    ],
  });
  assert.equal(result[1].tagName, "2026.07.10-rc.1");
});

test("GitHub adapter reports API failures with the repository", async () => {
  await assert.rejects(
    () =>
      fetchGitHubReleases("owner/repository", {
        fetchImpl: async () =>
          new Response(JSON.stringify({ message: "rate limit exceeded" }), {
            status: 403,
            statusText: "Forbidden",
          }),
      }),
    /owner\/repository.*403 Forbidden.*rate limit exceeded/,
  );
});

test("GitHub adapter accepts an empty optional release name", async () => {
  const release = structuredClone(githubFixture[0]);
  release.name = "";
  const result = await fetchGitHubReleases("denoland/deno", {
    fetchImpl: async () => new Response(JSON.stringify([release])),
  });

  assert.equal(result[0].name, null);
});
