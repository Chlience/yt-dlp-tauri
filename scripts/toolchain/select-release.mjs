function requireReleaseArray(releases) {
  if (!Array.isArray(releases)) {
    throw new Error("Release selection requires an array of releases");
  }
  return releases;
}

function stableReleases(releases) {
  return requireReleaseArray(releases).filter(
    (release) => release && release.draft !== true && release.prerelease !== true,
  );
}

function publishedTimestamp(release) {
  if (typeof release.publishedAt !== "string") {
    throw new Error(`Release ${release.tagName ?? "<unknown>"} is missing publishedAt`);
  }
  const timestamp = Date.parse(release.publishedAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error(
      `Release ${release.tagName ?? "<unknown>"} has invalid publishedAt ${release.publishedAt}`,
    );
  }
  return timestamp;
}

function byNewestPublication(left, right) {
  const timestampDifference = publishedTimestamp(right) - publishedTimestamp(left);
  if (timestampDifference !== 0) return timestampDifference;
  const leftTag = String(left.tagName ?? "");
  const rightTag = String(right.tagName ?? "");
  if (leftTag === rightTag) return 0;
  return leftTag < rightTag ? 1 : -1;
}

export function selectLatestStable(releases) {
  const candidates = stableReleases(releases).sort(byNewestPublication);
  if (candidates.length === 0) {
    throw new Error("No stable release candidate found");
  }
  return candidates[0];
}

export function selectPreviousCompleteMonth(releases, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Previous-month release selection requires a valid current date");
  }

  const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const previousMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const candidates = stableReleases(releases)
    .filter((release) => {
      const publishedAt = publishedTimestamp(release);
      return publishedAt >= previousMonthStart && publishedAt < currentMonthStart;
    })
    .sort(byNewestPublication);

  if (candidates.length === 0) {
    const month = new Date(previousMonthStart).toISOString().slice(0, 7);
    throw new Error(`No stable release candidate found for ${month}`);
  }
  return candidates[0];
}
