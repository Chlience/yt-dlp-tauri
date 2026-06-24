export type ToolStatus = {
  name: string;
  relative_path: string;
  full_path: string;
  availability: "available" | "missing" | "cannot_execute" | "outdated";
  version?: string;
  expected_version?: string;
  error?: string;
};

export type ToolAction = "install" | "update" | "reinstall";
export type ToolSummaryMode = "local" | "remote";

export type ToolSummary = {
  ready: boolean;
  action: ToolAction | null;
  settingsKey:
    | "settings.toolsAvailable"
    | "settings.toolsMissing"
    | "settings.toolsDamaged"
    | "settings.toolUpdatesAvailable";
  noticeKey: "notice.toolchainReady" | "notice.toolsMissing" | "notice.toolsDamaged" | "notice.toolsOutdated";
  eventKey: "event.toolsAvailable" | "event.toolsMissing" | "event.toolsDamaged" | "event.toolUpdatesAvailable";
  tone: "success" | "warning";
};

export type ToolManifestAsset = {
  name: string;
  downloadUrl: string;
};

const TOOL_MANIFEST_ASSET_NAME = "tools-manifest.json";

export function summarizeTools(tools: ToolStatus[], mode: ToolSummaryMode): ToolSummary {
  const hasMissing = tools.some((tool) => tool.availability === "missing");
  const hasAttention = tools.some((tool) => tool.availability === "outdated" || tool.availability === "cannot_execute");
  const ready = tools.length > 0 && tools.every((tool) => tool.availability === "available");

  if (ready) {
    return {
      ready: true,
      action: null,
      settingsKey: "settings.toolsAvailable",
      noticeKey: "notice.toolchainReady",
      eventKey: "event.toolsAvailable",
      tone: "success",
    };
  }

  if (hasMissing) {
    return {
      ready: false,
      action: "install",
      settingsKey: "settings.toolsMissing",
      noticeKey: "notice.toolsMissing",
      eventKey: "event.toolsMissing",
      tone: "warning",
    };
  }

  if (hasAttention && mode === "remote") {
    return {
      ready: false,
      action: "update",
      settingsKey: "settings.toolUpdatesAvailable",
      noticeKey: "notice.toolsOutdated",
      eventKey: "event.toolUpdatesAvailable",
      tone: "warning",
    };
  }

  if (hasAttention) {
    return {
      ready: false,
      action: "reinstall",
      settingsKey: "settings.toolsDamaged",
      noticeKey: "notice.toolsDamaged",
      eventKey: "event.toolsDamaged",
      tone: "warning",
    };
  }

  return {
    ready: false,
    action: "install",
    settingsKey: "settings.toolsMissing",
    noticeKey: "notice.toolsMissing",
    eventKey: "event.toolsMissing",
    tone: "warning",
  };
}

export function findToolManifestAsset(payload: unknown): ToolManifestAsset | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const assets = (payload as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) {
    return null;
  }

  for (const asset of assets) {
    if (!asset || typeof asset !== "object") {
      continue;
    }
    const record = asset as Record<string, unknown>;
    if (record.name === TOOL_MANIFEST_ASSET_NAME && typeof record.browser_download_url === "string") {
      return {
        name: TOOL_MANIFEST_ASSET_NAME,
        downloadUrl: record.browser_download_url,
      };
    }
  }

  return null;
}
