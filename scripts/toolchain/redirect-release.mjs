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
  return {
    url: resolved.toString(),
    version,
    checksumUrl: checksumUrl.toString(),
  };
}
