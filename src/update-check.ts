export type LatestRelease = {
  tagName: string;
  releaseUrl: string;
};

export type UpdateStatus =
  | {
      kind: "available";
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
    }
  | {
      kind: "current";
      currentVersion: string;
      latestVersion: string;
    };

export function compareVersions(firstVersion: string, secondVersion: string) {
  const firstParts = versionParts(firstVersion);
  const secondParts = versionParts(secondVersion);
  const partCount = Math.max(firstParts.length, secondParts.length);

  for (let index = 0; index < partCount; index += 1) {
    const first = firstParts[index] ?? 0;
    const second = secondParts[index] ?? 0;

    if (first < second) {
      return -1;
    }
    if (first > second) {
      return 1;
    }
  }

  return 0;
}

export function getUpdateStatus(currentVersion: string, latestRelease: LatestRelease): UpdateStatus {
  const normalizedCurrentVersion = normalizeVersion(currentVersion);
  const normalizedLatestVersion = normalizeVersion(latestRelease.tagName);

  if (compareVersions(normalizedCurrentVersion, normalizedLatestVersion) < 0) {
    return {
      kind: "available",
      currentVersion: normalizedCurrentVersion,
      latestVersion: normalizedLatestVersion,
      releaseUrl: latestRelease.releaseUrl,
    };
  }

  return {
    kind: "current",
    currentVersion: normalizedCurrentVersion,
    latestVersion: normalizedLatestVersion,
  };
}

export function parseLatestRelease(payload: unknown): LatestRelease | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const release = payload as Record<string, unknown>;
  if (typeof release.tag_name !== "string" || typeof release.html_url !== "string") {
    return null;
  }

  return {
    tagName: release.tag_name,
    releaseUrl: release.html_url,
  };
}

function normalizeVersion(version: string) {
  return version.trim().replace(/^v/i, "").split(/[+-]/)[0] || "0";
}

function versionParts(version: string) {
  return normalizeVersion(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}
