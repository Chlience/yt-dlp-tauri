import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { fetchGitHubReleases } from "../scripts/toolchain/github-releases.mjs";
import { resolveRedirectAsset } from "../scripts/toolchain/redirect-release.mjs";

const githubFixture = JSON.parse(
  readFileSync("tests/fixtures/toolchain/github-releases.json", "utf8"),
);
const redirectFixture = JSON.parse(
  readFileSync("tests/fixtures/toolchain/redirect-releases.json", "utf8"),
);
const redirectSha256 = "a".repeat(64);

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

test("redirect adapter returns the immutable location", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await resolveRedirectAsset(redirectFixture.sourceUrl, {
    approvedHosts: ["ffmpeg.martin-riedl.de"],
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith(".sha256")) {
        return new Response(`${redirectSha256}  ffmpeg.zip\n`);
      }
      return new Response(null, {
        status: 302,
        headers: { location: redirectFixture.location },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init?.method, "HEAD");
  assert.equal(calls[0].init?.redirect, "manual");
  assert.equal(calls[1].url, `${redirectFixture.location}.sha256`);
  assert.equal(calls[1].init?.method, "GET");
  assert.deepEqual(result, {
    url: redirectFixture.location,
    version: redirectFixture.version,
    checksumUrl: `${redirectFixture.location}.sha256`,
    sha256: redirectSha256,
  });
});

test("redirect adapter rejects a final URL on an unapproved host", async () => {
  await assert.rejects(
    () =>
      resolveRedirectAsset(redirectFixture.sourceUrl, {
        approvedHosts: ["ffmpeg.martin-riedl.de"],
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: {
              location: "https://downloads.example.test/macos/1783011502_8.1.2/ffmpeg.zip",
            },
          }),
      }),
    /unapproved host downloads\.example\.test/,
  );
});

test("redirect adapter falls back to GET when the server mishandles HEAD", async () => {
  const methods: string[] = [];
  const result = await resolveRedirectAsset(redirectFixture.sourceUrl, {
    approvedHosts: ["ffmpeg.martin-riedl.de"],
    fetchImpl: async (url, init) => {
      methods.push(init?.method ?? "GET");
      if (String(url).endsWith(".sha256")) {
        return new Response(`${redirectSha256}  ffmpeg.zip\n`);
      }
      return init?.method === "HEAD"
        ? new Response(null, { status: 404, statusText: "Not Found" })
        : new Response(null, {
            status: 307,
            headers: { location: redirectFixture.location },
          });
    },
  });

  assert.deepEqual(methods, ["HEAD", "GET", "GET"]);
  assert.equal(result.url, redirectFixture.location);
});

test("redirect adapter rejects a checksum for another asset", async () => {
  await assert.rejects(
    () =>
      resolveRedirectAsset(redirectFixture.sourceUrl, {
        approvedHosts: ["ffmpeg.martin-riedl.de"],
        fetchImpl: async (url) =>
          String(url).endsWith(".sha256")
            ? new Response(`${redirectSha256}  ffprobe.zip\n`)
            : new Response(null, {
                status: 307,
                headers: { location: redirectFixture.location },
              }),
      }),
    /checksum names ffprobe\.zip, expected ffmpeg\.zip/,
  );
});
