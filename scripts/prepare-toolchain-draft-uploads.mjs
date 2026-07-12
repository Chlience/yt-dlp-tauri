import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireAssetName(value, label) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be a plain file name`);
  }
  return value;
}

function requireSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function expectedUploads(plan, candidateRoot, outputDirectory) {
  if (plan.mode !== "publish") throw new Error("Draft uploads require a publication plan");
  const operations = requireArray(plan.operations, "Publication operations");
  const publication = operations.find((operation) => operation?.kind === "publish-release");
  const required = requireArray(
    publication?.requiredDraftAssets,
    "Required draft assets",
  );
  const sources = operations
    .filter((operation) => operation?.kind === "upload" || operation?.kind === "metadata")
    .map((operation) => {
      const descriptor =
        operation.kind === "upload"
          ? {
              name: operation.descriptor?.assetName,
              size: operation.descriptor?.size,
              sha256: operation.descriptor?.sha256,
              sourcePath: join(candidateRoot, operation.path ?? ""),
            }
          : {
              name: operation.asset?.name,
              size: operation.asset?.size,
              sha256: operation.asset?.sha256,
              sourcePath: operation.path,
            };
      const name = requireAssetName(descriptor.name, "Draft asset name");
      return {
        name,
        size: requireSize(descriptor.size, `${name} size`),
        sha256: requireSha256(descriptor.sha256, `${name} SHA-256`),
        sourcePath: descriptor.sourcePath,
        uploadPath: join(outputDirectory, name),
      };
    });
  const byName = new Map();
  for (const source of sources) {
    if (byName.has(source.name)) throw new Error(`Duplicate draft upload ${source.name}`);
    byName.set(source.name, source);
  }
  if (required.length !== sources.length) {
    throw new Error("Draft upload operations do not match required assets");
  }
  for (const descriptorValue of required) {
    const descriptor = requireObject(descriptorValue, "Required draft asset");
    const name = requireAssetName(descriptor.name, "Required draft asset name");
    const source = byName.get(name);
    if (
      !source ||
      source.size !== requireSize(descriptor.size, `${name} required size`) ||
      source.sha256 !== requireSha256(descriptor.sha256, `${name} required SHA-256`)
    ) {
      throw new Error(`Draft upload ${name} does not match the publication requirement`);
    }
  }
  return sources;
}

export function createDraftUploadPlan(
  planValue,
  releaseValue,
  {
    candidateRoot = ".toolchain/candidate",
    outputDirectory = ".toolchain/publication/draft-uploads",
  } = {},
) {
  const plan = requireObject(planValue, "Publication plan");
  const release = requireObject(releaseValue, "Revision draft");
  const sources = expectedUploads(plan, candidateRoot, outputDirectory);
  const expectedNames = new Set(sources.map((source) => source.name));
  const assets = requireArray(release.assets, "Revision draft assets");
  for (const assetValue of assets) {
    const asset = requireObject(assetValue, "Revision draft asset");
    if (!expectedNames.has(asset.name)) {
      throw new Error(`Unexpected draft asset ${asset.name}`);
    }
  }

  const uploads = [];
  const reused = [];
  for (const source of sources) {
    const matches = assets.filter((asset) => asset.name === source.name);
    if (matches.length > 1) throw new Error(`Duplicate draft asset ${source.name}`);
    if (matches.length === 0) {
      uploads.push(source);
      continue;
    }
    const asset = matches[0];
    if (asset.size !== source.size) {
      throw new Error(`${source.name} draft asset size does not match`);
    }
    if (asset.digest !== `sha256:${source.sha256}`) {
      throw new Error(`${source.name} draft asset digest does not match`);
    }
    reused.push(source.name);
  }
  return { uploads, reused };
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function stageUpload(upload) {
  const sourceStat = await stat(upload.sourcePath);
  if (!sourceStat.isFile() || sourceStat.size !== upload.size) {
    throw new Error(`${upload.name} source size does not match`);
  }
  if ((await sha256(upload.sourcePath)) !== upload.sha256) {
    throw new Error(`${upload.name} source digest does not match`);
  }
  await copyFile(upload.sourcePath, upload.uploadPath);
}

export async function prepareDraftUploads({
  planPath = ".toolchain/publication/publication-plan.json",
  releasePath = ".toolchain/publication/draft-release-before-upload.json",
  candidateRoot = ".toolchain/candidate",
  outputDirectory = ".toolchain/publication/draft-uploads",
  outputPath = ".toolchain/publication/draft-upload-plan.json",
} = {}) {
  const [plan, release] = await Promise.all(
    [planPath, releasePath].map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  const result = createDraftUploadPlan(plan, release, {
    candidateRoot,
    outputDirectory,
  });
  await mkdir(outputDirectory, { recursive: true });
  for (const upload of result.uploads) await stageUpload(upload);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function main() {
  const result = await prepareDraftUploads();
  process.stdout.write(
    `${JSON.stringify({ uploads: result.uploads.length, reused: result.reused.length })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
