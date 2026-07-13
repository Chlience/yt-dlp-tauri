import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { runCommand } from "./compatibility.mjs";

const SCHEMA_VERSION = 1;
const OPERATIONS = new Set(["metadata", "simulate"]);
const ENVIRONMENTAL_FAILURE_CLASSES = new Set([
  "authentication",
  "network",
  "precondition",
  "rate-limit",
]);
const PUBLIC_HOSTS = new Set([
  "vimeo.com",
  "www.vimeo.com",
  "www.youtube.com",
  "youtube.com",
]);
const SITE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function emptyCanaryState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAtUtc: null,
    entries: {},
  };
}

export function nextCanaryState(previous, observations, now = new Date().toISOString()) {
  const updatedAtUtc = requireTimestamp(now, "Canary update time");
  const previousState = normalizePreviousState(previous);
  const nextEntries = {};
  const seen = new Set();

  for (const observation of requireArray(observations, "Canary observations")) {
    const id = requireSiteId(observation?.id);
    if (seen.has(id)) throw new Error(`Duplicate Canary observation: ${id}`);
    seen.add(id);
    const prior = normalizePreviousEntry(previousState.entries[id], id);
    const operation = requireOperation(observation?.operation ?? prior.operation ?? "metadata");
    const ok = requireBoolean(observation?.ok, `${id} observation status`);

    if (ok) {
      const hadFailure = prior.count > 0;
      const wasAlerted = prior.alerted || prior.count >= 3;
      nextEntries[id] = {
        id,
        operation,
        count: 0,
        failureClass: prior.failureClass,
        firstFailureAtUtc: prior.firstFailureAtUtc,
        lastFailureAtUtc: prior.lastFailureAtUtc,
        recoveryAtUtc: hadFailure ? updatedAtUtc : prior.recoveryAtUtc,
        alerted: false,
        recoveryPending: hadFailure && wasAlerted,
        recoveredFailureClass: hadFailure && wasAlerted ? prior.failureClass : null,
        recoveryResolution: hadFailure && wasAlerted ? "success" : null,
      };
      continue;
    }

    const failureClass = requireFailureClass(observation?.failureClass);
    const priorWasAlerted = prior.alerted || prior.count >= 3;
    if (ENVIRONMENTAL_FAILURE_CLASSES.has(failureClass)) {
      nextEntries[id] = {
        id,
        operation,
        count: 0,
        failureClass,
        firstFailureAtUtc: null,
        lastFailureAtUtc: updatedAtUtc,
        recoveryAtUtc: priorWasAlerted ? updatedAtUtc : prior.recoveryAtUtc,
        alerted: false,
        recoveryPending: priorWasAlerted,
        recoveredFailureClass: priorWasAlerted ? prior.failureClass : null,
        recoveryResolution: priorWasAlerted ? "environmental" : null,
      };
      continue;
    }

    const sameSequence =
      prior.count > 0 &&
      prior.failureClass === failureClass &&
      prior.operation === operation;
    const count = sameSequence ? prior.count + 1 : 1;
    nextEntries[id] = {
      id,
      operation,
      count,
      failureClass,
      firstFailureAtUtc: sameSequence ? prior.firstFailureAtUtc ?? updatedAtUtc : updatedAtUtc,
      lastFailureAtUtc: updatedAtUtc,
      recoveryAtUtc: sameSequence ? prior.recoveryAtUtc : null,
      alerted: priorWasAlerted || count >= 3,
      recoveryPending: false,
      recoveredFailureClass: null,
      recoveryResolution: null,
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAtUtc,
    entries: Object.fromEntries(
      Object.entries(nextEntries).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function issuesToUpdate(state) {
  const normalized = normalizePreviousState(state);
  const actions = [];
  for (const [id, rawEntry] of Object.entries(normalized.entries).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const entry = normalizePreviousEntry(rawEntry, id);
    if (entry.recoveryPending && entry.recoveryAtUtc === normalized.updatedAtUtc) {
      actions.push({
        id,
        action: "close",
        failureClass: entry.recoveredFailureClass ?? entry.failureClass,
        count: 0,
        resolution: entry.recoveryResolution ?? "success",
        ...(entry.recoveryResolution === "environmental"
          ? { currentFailureClass: entry.failureClass }
          : {}),
      });
    }
    if (entry.count === 3) {
      actions.push({ id, action: "open", failureClass: entry.failureClass, count: entry.count });
    } else if (entry.count > 3 || (entry.alerted && entry.count > 0)) {
      actions.push({ id, action: "update", failureClass: entry.failureClass, count: entry.count });
    }
  }
  return actions;
}

export function validateCanaryConfig(config) {
  if (!config || typeof config !== "object" || config.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported Canary config schema: ${config?.schemaVersion}`);
  }
  const sites = requireArray(config.sites, "Canary sites").map((site) => {
    const id = requireSiteId(site?.id);
    const operation = requireOperation(site?.operation);
    let parsed;
    try {
      parsed = new URL(site?.url);
    } catch {
      throw new Error(`${id} must use a reviewed public HTTPS URL`);
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !PUBLIC_HOSTS.has(parsed.hostname.toLowerCase())
    ) {
      throw new Error(`${id} must use a reviewed public HTTPS URL`);
    }
    return { id, operation, url: parsed.href };
  });
  if (sites.length === 0) throw new Error("Canary sites must not be empty");
  ensureUnique(sites.map((site) => site.id), "Canary site");
  return { schemaVersion: SCHEMA_VERSION, sites };
}

export function redactCanaryText(value) {
  let redacted = String(value ?? "");
  redacted = redacted.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu,
    "$1: [REDACTED]",
  );

  const urls = [];
  redacted = redacted.replace(/https?:\/\/[^\s"'<>]+/giu, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      url.search = "";
      url.hash = "";
      const placeholder = `CANARY_REDACTED_URL_${urls.length}`;
      urls.push(url.href);
      return placeholder;
    } catch {
      return "[REDACTED_URL]";
    }
  });
  redacted = redacted
    .replace(/[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]*/gu, "[LOCAL_PATH]")
    .replace(/\/(?:home|Users|private\/var|tmp)\/[^\s]*/gu, "[LOCAL_PATH]");
  urls.forEach((url, index) => {
    redacted = redacted.replaceAll(`CANARY_REDACTED_URL_${index}`, url);
  });
  return redacted.slice(0, 1000);
}

export function canaryCommand(site, paths) {
  const common = [
    "--ignore-config",
    "--no-playlist",
    "--no-js-runtimes",
    "--js-runtimes",
    `deno:${paths.deno}`,
    "--ffmpeg-location",
    paths.ffmpegDir,
  ];
  const operationArguments =
    site.operation === "metadata"
      ? ["--skip-download", "--dump-single-json"]
      : ["--simulate", "--format", "best"];
  return {
    command: paths.ytDlp,
    args: [...common, ...operationArguments, site.url],
  };
}

export async function runCanaryChecks(config, smokeReport, commandRunner = runCommand) {
  const normalizedConfig = validateCanaryConfig(config);
  let paths;
  try {
    paths = smokePaths(smokeReport);
  } catch (error) {
    return normalizedConfig.sites.map((site) => ({
      id: site.id,
      operation: site.operation,
      ok: false,
      failureClass: "toolchain",
      summary: redactCanaryText(error.message),
    }));
  }

  const observations = [];
  for (const site of normalizedConfig.sites) {
    try {
      await commandRunner(canaryCommand(site, paths), { timeoutMs: 2 * 60 * 1000 });
      observations.push({ id: site.id, operation: site.operation, ok: true });
    } catch (error) {
      const summary = redactCanaryText(error.message);
      observations.push({
        id: site.id,
        operation: site.operation,
        ok: false,
        failureClass: classifyCanaryFailure(summary, site.operation),
        summary,
      });
    }
  }
  return observations;
}

export function classifyCanaryFailure(summary, operation) {
  const normalized = String(summary).toLowerCase();
  if (/\b429\b|rate.?limit|too many requests/u.test(normalized)) return "rate-limit";
  if (/\b401\b|\b403\b|login|authentication|sign in/u.test(normalized)) {
    return "authentication";
  }
  if (/\b412\b|precondition/u.test(normalized)) return "precondition";
  if (
    /\bvideo (?:is )?unavailable\b|\bprivate video\b|\bvideo (?:has been|was) removed\b|\bvideo is no longer available\b/u.test(
      normalized,
    )
  ) {
    return "target-unavailable";
  }
  if (/timed out|timeout|network|dns|connection|temporar/u.test(normalized)) return "network";
  return operation === "simulate" ? "simulate" : "metadata";
}

function smokePaths(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.tools)) {
    throw new Error("Native smoke report is unavailable");
  }
  const pathFor = (name) => {
    const tool = report.tools.find((item) => item.name === name);
    const path = tool?.fullPath ?? tool?.full_path;
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error(`Native smoke report is missing ${name}`);
    }
    return path;
  };
  const deno = report.denoBinary ?? report.deno_binary ?? pathFor("deno");
  const ffmpegDir = report.ffmpegDirectory ?? report.ffmpeg_directory;
  if (typeof deno !== "string" || !isAbsolute(deno)) {
    throw new Error("Native smoke report has an invalid Deno path");
  }
  if (typeof ffmpegDir !== "string" || !isAbsolute(ffmpegDir)) {
    throw new Error("Native smoke report has an invalid FFmpeg directory");
  }
  return { ytDlp: pathFor("yt-dlp"), deno, ffmpegDir };
}

function normalizePreviousState(state) {
  if (!state || typeof state !== "object") return emptyCanaryState();
  if (state.schemaVersion !== undefined && state.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported Canary state schema: ${state.schemaVersion}`);
  }
  const entries = state.entries ?? {};
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error("Canary state entries must be an object");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAtUtc: state.updatedAtUtc ?? null,
    entries,
  };
}

function normalizePreviousEntry(entry, id) {
  if (!entry || typeof entry !== "object") {
    return {
      id,
      operation: null,
      count: 0,
      failureClass: null,
      firstFailureAtUtc: null,
      lastFailureAtUtc: null,
      recoveryAtUtc: null,
      alerted: false,
      recoveryPending: false,
      recoveredFailureClass: null,
      recoveryResolution: null,
    };
  }
  const count = Number.isInteger(entry.count) && entry.count >= 0 ? entry.count : 0;
  return {
    id,
    operation: entry.operation ?? null,
    count,
    failureClass: entry.failureClass ?? null,
    firstFailureAtUtc: entry.firstFailureAtUtc ?? null,
    lastFailureAtUtc: entry.lastFailureAtUtc ?? null,
    recoveryAtUtc: entry.recoveryAtUtc ?? null,
    alerted: entry.alerted === true || count >= 3,
    recoveryPending: entry.recoveryPending === true,
    recoveredFailureClass: entry.recoveredFailureClass ?? null,
    recoveryResolution: entry.recoveryResolution ?? null,
  };
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireSiteId(value) {
  if (typeof value !== "string" || !SITE_ID_PATTERN.test(value)) {
    throw new Error(`Invalid Canary site ID: ${value}`);
  }
  return value;
}

function requireOperation(value) {
  if (!OPERATIONS.has(value)) throw new Error(`Unsupported Canary operation: ${value}`);
  return value;
}

function requireFailureClass(value) {
  if (typeof value !== "string" || !SITE_ID_PATTERN.test(value)) {
    throw new Error(`Invalid Canary failure class: ${value}`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function ensureUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function parseCliArguments(argumentsList) {
  const allowed = new Set(["--config", "--smoke-report", "--previous-state", "--output-dir"]);
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!allowed.has(flag) || value === undefined) {
      throw new Error(`Invalid Canary argument: ${flag ?? "missing"}`);
    }
    if (values.has(flag)) throw new Error(`${flag} may only be provided once`);
    values.set(flag, value);
  }
  for (const required of ["--config", "--smoke-report", "--output-dir"]) {
    if (!values.has(required)) throw new Error(`${required} is required`);
  }
  return {
    config: values.get("--config"),
    smokeReport: values.get("--smoke-report"),
    previousState: values.get("--previous-state"),
    outputDirectory: values.get("--output-dir"),
  };
}

async function readOptionalJson(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isDirectExecution() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const cli = parseCliArguments(process.argv.slice(2));
    const config = JSON.parse(await readFile(cli.config, "utf8"));
    const smokeReport = await readOptionalJson(cli.smokeReport);
    const previousState = (await readOptionalJson(cli.previousState)) ?? emptyCanaryState();
    const observations = await runCanaryChecks(config, smokeReport);
    const state = nextCanaryState(previousState, observations);
    const actions = issuesToUpdate(state);
    await mkdir(cli.outputDirectory, { recursive: true });
    await Promise.all([
      writeJson(join(cli.outputDirectory, "canary-observations.json"), observations),
      writeJson(join(cli.outputDirectory, "canary-state.json"), state),
      writeJson(join(cli.outputDirectory, "canary-issue-actions.json"), actions),
    ]);
    const passed = observations.filter((observation) => observation.ok).length;
    process.stdout.write(`Canary checks: ${passed}/${observations.length} passed\n`);
  } catch (error) {
    process.stderr.write(`${redactCanaryText(error.message)}\n`);
    process.exitCode = 1;
  }
}
