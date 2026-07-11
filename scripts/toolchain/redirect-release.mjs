const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function approvedHostSet(sourceUrl, approvedHosts) {
  const hosts = approvedHosts ?? [sourceUrl.hostname];
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error("Redirect release adapter requires at least one approved host");
  }
  return new Set(hosts);
}

function requireApprovedHttpsUrl(value, approvedHosts, label) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  if (!approvedHosts.has(parsed.hostname)) {
    throw new Error(`${label} uses unapproved host ${parsed.hostname}`);
  }
  return parsed;
}

function parseChecksum(text, expectedName, checksumUrl) {
  const match = text.trim().match(/^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)$/i);
  if (!match) {
    throw new Error(`Invalid SHA-256 checksum response from ${checksumUrl}`);
  }
  const checksumName = match[2].trim();
  if (checksumName !== expectedName) {
    throw new Error(`SHA-256 checksum names ${checksumName}, expected ${expectedName}`);
  }
  return match[1].toLowerCase();
}

export async function resolveRedirectAsset(
  url,
  { fetchImpl = fetch, approvedHosts } = {},
) {
  const sourceUrl = new URL(url);
  const hosts = approvedHostSet(sourceUrl, approvedHosts);
  requireApprovedHttpsUrl(sourceUrl.toString(), hosts, "Release redirect URL");

  let response;
  try {
    response = await fetchImpl(sourceUrl, {
      method: "HEAD",
      redirect: "manual",
    });
  } catch {
    response = null;
  }
  if (!response || !REDIRECT_STATUSES.has(response.status)) {
    response = await fetchImpl(sourceUrl, {
      method: "GET",
      redirect: "manual",
    });
    await response.body?.cancel().catch(() => {});
  }
  if (!REDIRECT_STATUSES.has(response.status)) {
    throw new Error(`Expected release redirect for ${url}, received ${response.status}`);
  }

  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`Release redirect for ${url} is missing Location`);
  }
  const resolved = requireApprovedHttpsUrl(
    new URL(location, sourceUrl).toString(),
    hosts,
    "Resolved release URL",
  );
  const version = resolved.pathname.match(/_[v]?([0-9]+\.[0-9]+\.[0-9]+)\//)?.[1];
  if (!version) {
    throw new Error(`Unable to read release version from ${resolved}`);
  }

  const checksumUrl = new URL(resolved);
  checksumUrl.pathname = `${checksumUrl.pathname}.sha256`;
  const checksumResponse = await fetchImpl(checksumUrl, {
    method: "GET",
    redirect: "error",
    headers: {
      Accept: "text/plain",
      "User-Agent": "yt-dlp-tauri-toolchain-discovery",
    },
  });
  if (!checksumResponse.ok) {
    throw new Error(
      `Failed to fetch SHA-256 checksum ${checksumUrl}: ${checksumResponse.status} ${checksumResponse.statusText}`,
    );
  }
  if (checksumResponse.url) {
    requireApprovedHttpsUrl(checksumResponse.url, hosts, "Resolved checksum URL");
  }
  const contentLength = Number(checksumResponse.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 4096) {
    throw new Error(`SHA-256 checksum response is too large: ${checksumUrl}`);
  }
  const expectedName = resolved.pathname.split("/").at(-1);
  const sha256 = parseChecksum(await checksumResponse.text(), expectedName, checksumUrl);
  return {
    url: resolved.toString(),
    version,
    checksumUrl: checksumUrl.toString(),
    sha256,
  };
}
