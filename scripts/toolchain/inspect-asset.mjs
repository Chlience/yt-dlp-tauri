import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ZIP_LIST_MAX_BYTES = 16 * 1024 * 1024;

function normalizedSha256(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value.trim())) {
    throw new Error(`${label} must be a 64-character SHA-256 digest`);
  }
  return value.trim().toLowerCase();
}

function archivePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty path`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`unsafe archive member ${value}`);
  }
  const slashPath = value.trim().replaceAll("\\", "/");
  const segments = slashPath.split("/");
  if (
    slashPath.startsWith("/") ||
    slashPath.startsWith("//") ||
    /^[A-Za-z]:\//.test(slashPath) ||
    segments.includes("..")
  ) {
    throw new Error(`unsafe archive member ${value}`);
  }
  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  if (!normalized) {
    throw new Error(`unsafe archive member ${value}`);
  }
  return normalized;
}

function selectedArchiveEntry(entries, suffix) {
  const normalizedSuffix = archivePath(suffix, "archive member suffix");
  const normalizedEntries = entries.map((entry) => ({
    original: entry,
    normalized: archivePath(entry, "archive member"),
  }));
  const matches = normalizedEntries.filter(
    (entry) =>
      entry.normalized === normalizedSuffix ||
      entry.normalized.endsWith(`/${normalizedSuffix}`),
  );
  if (matches.length === 0) {
    throw new Error(`no archive member matches suffix ${normalizedSuffix}`);
  }
  if (matches.length > 1) {
    throw new Error(`multiple archive members match suffix ${normalizedSuffix}`);
  }
  return matches[0];
}

export function selectArchiveMember(entries, suffix) {
  if (!Array.isArray(entries)) {
    throw new Error("archive entries must be an array");
  }
  return selectedArchiveEntry(entries, suffix).normalized;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function requireApprovedUrl(value, approvedHosts, label) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  if (approvedHosts && !approvedHosts.has(parsed.hostname)) {
    throw new Error(`${label} uses unapproved host ${parsed.hostname}`);
  }
  return parsed;
}

async function downloadAsset({
  url,
  destination,
  fetchImpl,
  approvedHosts,
  expectedSize,
}) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download toolchain asset ${url}: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    throw new Error(`Toolchain asset ${url} returned an empty response body`);
  }
  if (response.url) {
    requireApprovedUrl(response.url, approvedHosts, "Downloaded asset URL");
  }

  const hash = createHash("sha256");
  let size = 0;
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      hashingStream,
      createWriteStream(destination, { flags: "wx" }),
    );
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw new Error(`Failed to stream toolchain asset ${url}: ${error}`);
  }

  if (expectedSize !== undefined && size !== expectedSize) {
    await unlink(destination).catch(() => {});
    throw new Error(`Toolchain asset ${url} has ${size} bytes, expected ${expectedSize}`);
  }
  return { size, sha256: hash.digest("hex") };
}

async function listZipEntries(path, unzipCommand) {
  try {
    const { stdout } = await execFileAsync(unzipCommand, ["-Z1", path], {
      encoding: "utf8",
      maxBuffer: ZIP_LIST_MAX_BYTES,
      windowsHide: true,
    });
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    const detail = typeof error?.stderr === "string" ? error.stderr.trim() : String(error);
    throw new Error(`Failed to list ZIP asset ${path}: ${detail}`);
  }
}

async function hashZipMember(path, member, unzipCommand) {
  const child = spawn(unzipCommand, ["-p", path, member], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    if (stderrBytes < 64 * 1024) {
      stderr.push(chunk);
      stderrBytes += chunk.length;
    }
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of child.stdout) {
    hash.update(chunk);
    size += chunk.length;
  }
  const { code, signal } = await completion;
  if (code !== 0) {
    const detail = Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(
      `Failed to extract ZIP member ${member}: exit ${code ?? signal}${detail ? `: ${detail}` : ""}`,
    );
  }
  return { size, sha256: hash.digest("hex") };
}

function validateMembers(members, kind) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error("Toolchain asset inspection requires at least one member");
  }
  return members.map((member, index) => {
    if (!member || typeof member !== "object" || typeof member.tool !== "string") {
      throw new Error(`Toolchain asset member ${index} requires a tool name`);
    }
    if (kind === "zip" && typeof member.archivePathSuffix !== "string") {
      throw new Error(`ZIP member ${member.tool} requires archivePathSuffix`);
    }
    return member;
  });
}

export async function inspectAsset({
  url,
  kind,
  tempDirectory,
  members,
  expectedSha256,
  expectedSize,
  approvedHosts,
  fetchImpl = fetch,
  unzipCommand = "unzip",
}) {
  if (kind !== "file" && kind !== "zip") {
    throw new Error(`Unsupported toolchain asset kind: ${kind}`);
  }
  if (typeof tempDirectory !== "string" || tempDirectory.trim() === "") {
    throw new Error("Toolchain asset inspection requires a temporary directory");
  }
  const hosts = approvedHosts ? new Set(approvedHosts) : undefined;
  const parsedUrl = requireApprovedUrl(url, hosts, "Toolchain asset URL");
  const validatedMembers = validateMembers(members, kind);
  const expectedDigest = normalizedSha256(expectedSha256, "expectedSha256");

  await mkdir(tempDirectory, { recursive: true });
  const sourceName = basename(parsedUrl.pathname) || "asset.bin";
  const destination = join(tempDirectory, `${randomUUID()}-${sourceName}`);
  const downloaded = await downloadAsset({
    url: parsedUrl,
    destination,
    fetchImpl,
    approvedHosts: hosts,
    expectedSize,
  });
  if (expectedDigest && downloaded.sha256 !== expectedDigest) {
    await unlink(destination).catch(() => {});
    throw new Error(
      `Toolchain asset ${url} has SHA-256 ${downloaded.sha256}, expected ${expectedDigest}`,
    );
  }

  if (kind === "file") {
    return {
      ...downloaded,
      members: validatedMembers.map((member) => ({
        tool: member.tool,
        archivePath: null,
        ...downloaded,
      })),
    };
  }

  const entries = await listZipEntries(destination, unzipCommand);
  const selectedPaths = new Set();
  const inspectedMembers = [];
  for (const member of validatedMembers) {
    const selected = selectedArchiveEntry(entries, member.archivePathSuffix);
    if (selectedPaths.has(selected.normalized)) {
      throw new Error(`ZIP member ${selected.normalized} is mapped more than once`);
    }
    selectedPaths.add(selected.normalized);
    inspectedMembers.push({
      tool: member.tool,
      archivePath: selected.normalized,
      ...(await hashZipMember(destination, selected.original, unzipCommand)),
    });
  }

  return { ...downloaded, members: inspectedMembers };
}
