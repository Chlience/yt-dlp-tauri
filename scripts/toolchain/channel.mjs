const MARKER_OPEN = "<!-- toolchain-channel";
const MARKER_CLOSE = "-->";
const ARCHIVE_REPOSITORY = "Chlience/yt-dlp-tauri-toolchain";
const LEGACY_RECORD_FIELDS = ["schemaVersion", "revision", "manifest", "sha256"];
const ARCHIVE_RECORD_FIELDS = [
  "schemaVersion",
  "repository",
  "revision",
  "releaseTag",
  "manifest",
  "sha256",
];
const ALL_RECORD_FIELDS = [...new Set([...LEGACY_RECORD_FIELDS, ...ARCHIVE_RECORD_FIELDS])];
const REVISION_PATTERN = /^[0-9]{8}\.[1-9][0-9]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function parseChannelRecord(releaseBody) {
  const body = requireBody(releaseBody);
  const marker = locateChannelMarker(body);
  const match = marker.text.match(
    /^<!-- toolchain-channel[ \t]*\r?\n([^\r\n]+)\r?\n-->$/u,
  );
  if (!match) throw new Error("toolchain channel record has invalid marker formatting");
  const json = match[1];
  let value;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`toolchain channel record contains invalid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("toolchain channel record must contain a JSON object");
  }
  for (const field of ALL_RECORD_FIELDS) {
    const occurrences = json.match(new RegExp(`"${field}"\\s*:`, "gu"))?.length ?? 0;
    if (occurrences > 1) throw new Error(`toolchain channel record has duplicate fields: ${field}`);
  }
  return normalizeChannelRecord(value);
}

export function renderChannelRecord(releaseBody, record) {
  const body = requireBody(releaseBody);
  const normalized = normalizeChannelRecord(record);
  const marker = channelMarker(normalized);
  const starts = markerStarts(body);

  if (starts.length > 1) throw new Error("multiple toolchain channel records found");
  if (starts.length === 1) {
    const existing = locateChannelMarker(body);
    parseChannelRecord(body);
    return `${body.slice(0, existing.start)}${marker}${body.slice(existing.end)}`;
  }

  if (body === "") return `${marker}\n`;
  const separator = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${separator}${marker}\n`;
}

export function selectManifestAsset(release, record) {
  const normalized = normalizeChannelRecord(record);
  if (!release || !Array.isArray(release.assets)) {
    throw new Error("toolchain release assets must be an array");
  }
  if (normalized.schemaVersion === 2) {
    if (
      release.tag_name !== normalized.releaseTag ||
      release.draft !== false ||
      release.immutable !== true
    ) {
      throw new Error("toolchain revision release must be published and immutable");
    }
  }
  const matches = release.assets.filter((asset) => asset?.name === normalized.manifest);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one release asset named ${normalized.manifest}, found ${matches.length}`,
    );
  }
  const asset = matches[0];
  let downloadUrl;
  try {
    downloadUrl = new URL(asset.browser_download_url);
  } catch {
    throw new Error(`${normalized.manifest} must have an HTTPS download URL`);
  }
  if (downloadUrl.protocol !== "https:" || downloadUrl.username || downloadUrl.password) {
    throw new Error(`${normalized.manifest} must have an HTTPS download URL`);
  }
  if (downloadUrl.hostname !== "github.com" || downloadUrl.search || downloadUrl.hash) {
    throw new Error(`${normalized.manifest} must have an immutable GitHub download URL`);
  }
  if (normalized.schemaVersion === 2) {
    const expectedPath = `/Chlience/yt-dlp-tauri-toolchain/releases/download/${normalized.releaseTag}/${encodeURIComponent(normalized.manifest)}`;
    if (downloadUrl.pathname !== expectedPath) {
      throw new Error(`${normalized.manifest} URL must match the archive revision release`);
    }
  }
  if (
    !(
      (Number.isSafeInteger(asset.id) && asset.id > 0) ||
      (typeof asset.id === "string" && /^[1-9][0-9]*$/u.test(asset.id))
    )
  ) {
    throw new Error(`${normalized.manifest} must have a release asset ID`);
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error(`${normalized.manifest} must have a positive byte size`);
  }
  return asset;
}

export function compareToolchainRevisions(left, right) {
  const [leftDate, leftSequence] = revisionParts(left);
  const [rightDate, rightSequence] = revisionParts(right);
  const dateOrder = leftDate.localeCompare(rightDate);
  if (dateOrder !== 0) return dateOrder < 0 ? -1 : 1;
  if (leftSequence === rightSequence) return 0;
  return leftSequence < rightSequence ? -1 : 1;
}

function normalizeChannelRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("toolchain channel record must be an object");
  }
  const fields = record.schemaVersion === 1 ? LEGACY_RECORD_FIELDS : ARCHIVE_RECORD_FIELDS;
  const keys = Object.keys(record);
  const unknown = keys.filter((key) => !fields.includes(key));
  if (unknown.length > 0) {
    throw new Error(`toolchain channel record has unknown fields: ${unknown.join(", ")}`);
  }
  const missing = fields.filter((key) => !Object.hasOwn(record, key));
  if (missing.length > 0) {
    throw new Error(`toolchain channel record is missing fields: ${missing.join(", ")}`);
  }
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    throw new Error(`Unsupported toolchain channel schema: ${record.schemaVersion}`);
  }
  try {
    revisionParts(record.revision);
  } catch {
    throw new Error(`Invalid toolchain channel revision: ${record.revision}`);
  }
  const expectedManifest = `tools-manifest-${record.revision}.json`;
  if (record.manifest !== expectedManifest) {
    throw new Error(`Channel manifest must match revision ${record.revision}`);
  }
  if (record.schemaVersion === 2) {
    if (record.repository !== ARCHIVE_REPOSITORY) {
      throw new Error(`Channel archive repository must be ${ARCHIVE_REPOSITORY}`);
    }
    if (record.releaseTag !== `toolchain-${record.revision}`) {
      throw new Error(`Channel release tag must match revision ${record.revision}`);
    }
  }
  if (!SHA256_PATTERN.test(record.sha256 ?? "")) {
    throw new Error("Channel digest must be a 64-character lowercase SHA-256");
  }
  if (record.schemaVersion === 1) {
    return {
      schemaVersion: 1,
      revision: record.revision,
      manifest: record.manifest,
      sha256: record.sha256,
    };
  }
  return {
    schemaVersion: 2,
    repository: ARCHIVE_REPOSITORY,
    revision: record.revision,
    releaseTag: record.releaseTag,
    manifest: record.manifest,
    sha256: record.sha256,
  };
}

function locateChannelMarker(body) {
  const starts = markerStarts(body);
  if (starts.length === 0) throw new Error("toolchain channel record is missing");
  if (starts.length > 1) throw new Error("multiple toolchain channel records found");
  const start = starts[0];
  const close = body.indexOf(MARKER_CLOSE, start + MARKER_OPEN.length);
  if (close < 0) throw new Error("toolchain channel record is not terminated");
  const end = close + MARKER_CLOSE.length;
  return { start, end, text: body.slice(start, end) };
}

function markerStarts(body) {
  const starts = [];
  let offset = 0;
  while (offset < body.length) {
    const start = body.indexOf(MARKER_OPEN, offset);
    if (start < 0) break;
    starts.push(start);
    offset = start + MARKER_OPEN.length;
  }
  return starts;
}

function channelMarker(record) {
  return `${MARKER_OPEN}\n${JSON.stringify(record)}\n${MARKER_CLOSE}`;
}

function revisionParts(value) {
  if (!REVISION_PATTERN.test(value ?? "")) {
    throw new Error(`Invalid toolchain revision: ${value}`);
  }
  const [date, sequence] = value.split(".");
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const parsedSequence = BigInt(sequence);
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    parsedSequence > 4_294_967_295n
  ) {
    throw new Error(`Invalid toolchain revision: ${value}`);
  }
  return [date, parsedSequence];
}

function requireBody(value) {
  if (typeof value !== "string") throw new Error("toolchain release body must be a string");
  return value;
}
