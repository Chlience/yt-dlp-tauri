import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export function ffmpegDashCommand({ ffmpeg, outputDirectory }) {
  return {
    command: ffmpeg,
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000",
      "-t",
      "2",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "24",
      "-keyint_min",
      "24",
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-use_timeline",
      "1",
      "-use_template",
      "1",
      "-adaptation_sets",
      "id=0,streams=v id=1,streams=a",
      "-f",
      "dash",
      join(outputDirectory, "media.mpd"),
    ],
  };
}

export function ytDlpDashCommand({
  ytDlp,
  deno,
  ffmpegDir,
  manifestUrl,
  output,
}) {
  return {
    command: ytDlp,
    args: [
      "--no-js-runtimes",
      "--js-runtimes",
      `deno:${deno}`,
      "--ffmpeg-location",
      ffmpegDir,
      "-f",
      "bestvideo+bestaudio",
      "--ignore-config",
      "--no-playlist",
      "--force-overwrites",
      "--merge-output-format",
      "mp4",
      "--output",
      output,
      manifestUrl,
    ],
  };
}

export function ffprobeStreamsCommand({ ffprobe, mediaPath }) {
  return {
    command: ffprobe,
    args: ["-v", "error", "-show_streams", "-of", "json", mediaPath],
  };
}

export function assertAudioVideoStreams(payload) {
  if (!payload || !Array.isArray(payload.streams)) {
    throw new Error("FFprobe output is missing streams");
  }
  const videoCount = payload.streams.filter((stream) => stream.codec_type === "video").length;
  const audioCount = payload.streams.filter((stream) => stream.codec_type === "audio").length;
  if (videoCount !== 1) {
    throw new Error(`Expected one video stream, found ${videoCount}`);
  }
  if (audioCount !== 1) {
    throw new Error(`Expected one audio stream, found ${audioCount}`);
  }
}

export async function runCompatibilitySuite(options) {
  const smokeReport = requireSmokeReport(options?.smokeReport);
  const commandRunner = options.commandRunner ?? runCommand;
  const ownsWorkRoot = !options.workRoot;
  const workRoot = options.workRoot
    ? resolve(options.workRoot)
    : await mkdtemp(join(tmpdir(), "yt-dlp-tauri-compatibility-"));
  const mediaRoot = join(workRoot, "media");
  const downloadRoot = join(workRoot, "download");
  await Promise.all([mkdir(mediaRoot, { recursive: true }), mkdir(downloadRoot, { recursive: true })]);

  const paths = smokeToolPaths(smokeReport);
  const commands = {
    generate: ffmpegDashCommand({ ffmpeg: paths.ffmpeg, outputDirectory: mediaRoot }),
    download: undefined,
    probe: undefined,
  };
  let server;

  try {
    await commandRunner(commands.generate, { timeoutMs: options.commandTimeoutMs });
    server = await startMediaServer(mediaRoot);
    const outputTemplate = join(downloadRoot, "result.%(ext)s");
    const outputPath = join(downloadRoot, "result.mp4");
    commands.download = ytDlpDashCommand({
      ytDlp: paths.ytDlp,
      deno: paths.deno,
      ffmpegDir: paths.ffmpegDir,
      manifestUrl: `${server.origin}/media.mpd`,
      output: outputTemplate,
    });
    await commandRunner(commands.download, { timeoutMs: options.commandTimeoutMs });

    commands.probe = ffprobeStreamsCommand({ ffprobe: paths.ffprobe, mediaPath: outputPath });
    const probe = await commandRunner(commands.probe, { timeoutMs: options.commandTimeoutMs });
    let probePayload;
    try {
      probePayload = JSON.parse(probe.stdout);
    } catch (error) {
      throw new Error(`Failed to parse FFprobe JSON: ${error.message}`);
    }
    assertAudioVideoStreams(probePayload);

    return {
      ok: true,
      target: smokeReport.target,
      generatedDash: true,
      downloadedSeparateStreams: true,
      mergedWithCandidateFfmpeg: true,
      outputPath,
      streamTypes: probePayload.streams.map((stream) => stream.codec_type).sort(),
    };
  } finally {
    if (server) await server.close();
    if (ownsWorkRoot && options.keepArtifacts !== true) {
      await rm(workRoot, { recursive: true, force: true });
    }
  }
}

export async function startMediaServer(mediaRoot) {
  const canonicalRoot = await realpath(mediaRoot);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400).end();
        return;
      }
      const requestedPath = resolve(canonicalRoot, `.${decodedPath}`);
      if (!pathIsBelow(canonicalRoot, requestedPath)) {
        response.writeHead(403).end();
        return;
      }

      let canonicalFile;
      try {
        canonicalFile = await realpath(requestedPath);
      } catch {
        response.writeHead(404).end();
        return;
      }
      if (!pathIsBelow(canonicalRoot, canonicalFile)) {
        response.writeHead(403).end();
        return;
      }
      const fileStatus = await stat(canonicalFile);
      if (!fileStatus.isFile()) {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, {
        "Content-Length": fileStatus.size,
        "Content-Type": mediaContentType(canonicalFile),
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      await pipeline(createReadStream(canonicalFile), response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to resolve compatibility server address");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
        server.closeIdleConnections?.();
      }),
  };
}

export function runCommand(
  { command, args },
  { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {},
) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Command timed out after ${timeoutMs}ms: ${basename(command)}`));
    }, timeoutMs);

    function capture(chunks, chunk) {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        child.kill();
        finish(new Error(`Command output exceeded ${MAX_CAPTURE_BYTES} bytes: ${basename(command)}`));
        return;
      }
      chunks.push(chunk);
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectCommand(error);
      else resolveCommand(result);
    }

    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => {
      finish(new Error(`Failed to start ${command}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) finish(undefined, result);
      else {
        const detail = preferredOutputLine(result.stderr, result.stdout);
        finish(
          new Error(
            `${basename(command)} exited with code ${code ?? "unknown"}${
              detail ? `: ${detail}` : ""
            }`,
          ),
        );
      }
    });
  });
}

function requireSmokeReport(report) {
  if (!report || typeof report !== "object") throw new Error("Smoke report is required");
  if (typeof report.target !== "string" || report.target === "") {
    throw new Error("Smoke report target is required");
  }
  if (!Array.isArray(report.tools)) throw new Error("Smoke report tools must be an array");
  return report;
}

function smokeToolPaths(report) {
  const pathFor = (name) => {
    const tool = report.tools.find((candidate) => candidate.name === name);
    const path = tool?.fullPath ?? tool?.full_path;
    if (typeof path !== "string" || path === "") {
      throw new Error(`Smoke report is missing the absolute ${name} path`);
    }
    if (!isAbsolute(path)) throw new Error(`Smoke report ${name} path must be absolute`);
    return path;
  };
  const deno = report.denoBinary ?? report.deno_binary ?? pathFor("deno");
  const ffmpegDir = report.ffmpegDirectory ?? report.ffmpeg_directory;
  if (typeof deno !== "string" || !isAbsolute(deno)) {
    throw new Error("Smoke report Deno binary must be absolute");
  }
  if (typeof ffmpegDir !== "string" || !isAbsolute(ffmpegDir)) {
    throw new Error("Smoke report FFmpeg directory must be absolute");
  }
  return {
    ytDlp: pathFor("yt-dlp"),
    ffmpeg: pathFor("ffmpeg"),
    ffprobe: pathFor("ffprobe"),
    deno,
    ffmpegDir,
  };
}

function pathIsBelow(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && !pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
  );
}

function mediaContentType(path) {
  if (path.endsWith(".mpd")) return "application/dash+xml";
  if (path.endsWith(".m4s")) return "video/iso.segment";
  if (path.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

function preferredOutputLine(...values) {
  const lines = values.flatMap((value) =>
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return lines.find((line) => /(?:^|\s)ERROR:/iu.test(line)) ?? lines[0];
}

function parseCliArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`${flag ?? "Argument"} requires a value`);
    }
    if (!["--smoke-report", "--report", "--work-root"].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (values.has(flag)) throw new Error(`${flag} may only be provided once`);
    values.set(flag, value);
  }
  for (const required of ["--smoke-report", "--report"]) {
    if (!values.has(required)) throw new Error(`${required} is required`);
  }
  return {
    smokeReport: values.get("--smoke-report"),
    report: values.get("--report"),
    workRoot: values.get("--work-root"),
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isDirectExecution() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  let cli;
  try {
    cli = parseCliArguments(process.argv.slice(2));
    const smokeReport = JSON.parse(await readFile(cli.smokeReport, "utf8"));
    const report = await runCompatibilitySuite({
      smokeReport,
      workRoot: cli.workRoot,
      keepArtifacts: true,
    });
    await writeJson(cli.report, report);
  } catch (error) {
    if (cli?.report) {
      await writeJson(cli.report, { ok: false, error: error.message }).catch(() => {});
    }
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
