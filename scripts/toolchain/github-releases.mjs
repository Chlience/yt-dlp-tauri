const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_USER_AGENT = "yt-dlp-tauri-toolchain-discovery";
const MAX_RELEASE_PAGES = 100;

function requireString(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`GitHub release payload is missing ${label}`);
  }
  return value.trim();
}

function requireNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`GitHub release payload has invalid ${label}`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return requireString(value, label);
}

function normalizeSha256(digest, assetName) {
  if (digest === null || digest === undefined) return null;
  if (typeof digest !== "string") {
    throw new Error(`GitHub release asset ${assetName} has an invalid digest`);
  }
  const match = digest.trim().match(/^sha256:([a-f0-9]{64})$/i);
  if (!match) {
    throw new Error(`GitHub release asset ${assetName} does not provide a SHA-256 digest`);
  }
  return match[1].toLowerCase();
}

function normalizeAsset(assetValue) {
  if (!assetValue || typeof assetValue !== "object" || Array.isArray(assetValue)) {
    throw new Error("GitHub release payload contains an invalid asset");
  }
  const name = requireString(assetValue.name, "asset name");
  return {
    id: requireNumber(assetValue.id, `asset ${name} id`),
    name,
    url: requireString(assetValue.browser_download_url, `asset ${name} download URL`),
    size: requireNumber(assetValue.size, `asset ${name} size`),
    sha256: normalizeSha256(assetValue.digest, name),
    contentType: requireString(assetValue.content_type, `asset ${name} content type`),
    updatedAt: requireString(assetValue.updated_at, `asset ${name} update time`),
  };
}

function normalizeRelease(releaseValue) {
  if (!releaseValue || typeof releaseValue !== "object" || Array.isArray(releaseValue)) {
    throw new Error("GitHub releases response contains an invalid release");
  }
  if (!Array.isArray(releaseValue.assets)) {
    throw new Error("GitHub release payload is missing assets");
  }
  return {
    id: requireNumber(releaseValue.id, "release id"),
    tagName: requireString(releaseValue.tag_name, "tag_name"),
    name: optionalString(releaseValue.name, "release name"),
    draft: Boolean(releaseValue.draft),
    prerelease: Boolean(releaseValue.prerelease),
    createdAt: requireString(releaseValue.created_at, "created_at"),
    publishedAt: requireString(releaseValue.published_at, "published_at", {
      nullable: true,
    }),
    htmlUrl: requireString(releaseValue.html_url, "html_url"),
    assets: releaseValue.assets.map(normalizeAsset),
  };
}

function hasNextPage(linkHeader) {
  return (
    typeof linkHeader === "string" &&
    /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:\s*;|\s*,|\s*$)/.test(linkHeader)
  );
}

function errorMessage(body) {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Fall through to the bounded response body.
  }
  return body.trim().slice(0, 300);
}

export function githubReleaseHeaders(
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  userAgent = DEFAULT_USER_AGENT,
) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": userAgent,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const normalizedToken = token.trim();
  if (normalizedToken) headers.Authorization = `Bearer ${normalizedToken}`;
  return headers;
}

export async function fetchGitHubReleases(
  repository,
  {
    token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
    fetchImpl = fetch,
    apiBase = DEFAULT_API_BASE,
  } = {},
) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }

  const releases = [];
  const headers = githubReleaseHeaders(token);
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const url = new URL(`/repos/${repository}/releases`, apiBase);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetchImpl(url, { headers });
    const body = await response.text();

    if (!response.ok) {
      const detail = errorMessage(body);
      throw new Error(
        `Failed to fetch GitHub releases for ${repository}: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
      );
    }

    let pageReleases;
    try {
      pageReleases = JSON.parse(body);
    } catch (error) {
      throw new Error(`GitHub releases response for ${repository} is not valid JSON: ${error}`);
    }
    if (!Array.isArray(pageReleases)) {
      throw new Error(`GitHub releases response for ${repository} must be an array`);
    }
    releases.push(...pageReleases.map(normalizeRelease));

    if (!hasNextPage(response.headers.get("link"))) return releases;
  }

  throw new Error(`GitHub releases response for ${repository} exceeded ${MAX_RELEASE_PAGES} pages`);
}
