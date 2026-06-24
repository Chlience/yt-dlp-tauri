export type ReleaseNotesLanguage = "en" | "zh";

export type ReleaseNotes = {
  version: string;
  items: string[];
};

export function shouldShowReleaseNotes(lastSeenVersion: string | null | undefined, currentVersion: string) {
  if (!lastSeenVersion?.trim() || !currentVersion.trim()) {
    return false;
  }
  return normalizeVersion(lastSeenVersion) !== normalizeVersion(currentVersion);
}

export function releaseNotesForVersion(markdown: string, version: string, language: ReleaseNotesLanguage): ReleaseNotes | null {
  const section = versionSection(markdown, version);
  if (!section) {
    return null;
  }

  const languageHeading = language === "zh" ? "中文" : "English";
  const lines = section.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === `### ${languageHeading}`);
  if (headingIndex < 0) {
    return null;
  }

  const items: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("### ") || trimmed.startsWith("## ")) {
      break;
    }
    if (trimmed.startsWith("- ")) {
      items.push(stripTerminalSentencePunctuation(trimmed.slice(2).trim()));
    }
  }

  return {
    version: normalizeVersion(version),
    items,
  };
}

export function stripTerminalSentencePunctuation(text: string) {
  const trailingWhitespace = text.match(/\s*$/)?.[0] ?? "";
  let body = text.slice(0, text.length - trailingWhitespace.length);

  while (body.endsWith("。") || body.endsWith("．")) {
    body = body.slice(0, -1);
  }

  if (body.endsWith(".") && !body.endsWith("...")) {
    body = body.slice(0, -1);
  }

  return `${body}${trailingWhitespace}`;
}

function versionSection(markdown: string, version: string) {
  const lines = markdown.split(/\r?\n/);
  const normalizedVersion = normalizeVersion(version);
  let start = -1;

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }

    const headingVersion = match[1].split(/\s+-\s+/)[0] ?? "";
    if (normalizeVersion(headingVersion) === normalizedVersion) {
      start = index;
      break;
    }
  }

  if (start < 0) {
    return null;
  }

  const rest = lines.slice(start + 1);
  const endOffset = rest.findIndex((line) => /^##\s+/.test(line));
  const sectionLines = endOffset < 0 ? lines.slice(start) : lines.slice(start, start + 1 + endOffset);
  return sectionLines.join("\n");
}

function normalizeVersion(version: string) {
  return version.trim().replace(/^v/i, "").split(/[+-]/)[0] || "0";
}
