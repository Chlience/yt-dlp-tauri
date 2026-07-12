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

export type RemoteToolManifest = {
  status: "available" | "no_release" | "no_manifest";
  manifestJson: string | null;
  revision: string | null;
  source: "archive" | "legacy" | null;
};

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

export function summarizeRemoteTools(
  tools: ToolStatus[],
  localRevision: string | null,
  remoteRevision: string | null,
): ToolSummary {
  if (remoteRevision) {
    compareToolchainRevisions(remoteRevision, remoteRevision);
  }
  if (localRevision) {
    compareToolchainRevisions(localRevision, localRevision);
  }
  const summary = summarizeTools(tools, "remote");
  if (summary.action || !remoteRevision) {
    return summary;
  }
  const newer = localRevision === null || compareToolchainRevisions(remoteRevision, localRevision) > 0;
  if (!newer) {
    return summary;
  }

  return {
    ready: false,
    action: "update",
    settingsKey: "settings.toolUpdatesAvailable",
    noticeKey: "notice.toolsOutdated",
    eventKey: "event.toolUpdatesAvailable",
    tone: "warning",
  };
}

export function compareToolchainRevisions(left: string, right: string): -1 | 0 | 1 {
  const leftParts = parseToolchainRevision(left);
  const rightParts = parseToolchainRevision(right);
  if (leftParts.date !== rightParts.date) {
    return leftParts.date < rightParts.date ? -1 : 1;
  }
  if (leftParts.sequence === rightParts.sequence) {
    return 0;
  }
  return leftParts.sequence < rightParts.sequence ? -1 : 1;
}

function parseToolchainRevision(value: string): { date: string; sequence: bigint } {
  const match = /^(\d{4})(\d{2})(\d{2})\.([1-9]\d*)$/u.exec(value);
  if (!match) {
    throw new Error(`Invalid toolchain revision: ${value}`);
  }
  const [, yearText, monthText, dayText, sequenceText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new Error(`Invalid toolchain revision: ${value}`);
  }

  return {
    date: `${yearText}${monthText}${dayText}`,
    sequence: parseRevisionSequence(sequenceText, value),
  };
}

function parseRevisionSequence(sequenceText: string, revision: string): bigint {
  const sequence = BigInt(sequenceText);
  if (sequence > 4_294_967_295n) {
    throw new Error(`Invalid toolchain revision: ${revision}`);
  }
  return sequence;
}
