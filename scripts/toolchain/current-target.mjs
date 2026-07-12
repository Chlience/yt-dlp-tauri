import { pathToFileURL } from "node:url";

const TARGETS = new Map([
  ["win32/x64", "win-x64"],
]);

export function nativeToolchainTarget(platform = process.platform, arch = process.arch) {
  const target = TARGETS.get(`${platform}/${arch}`);
  if (!target) {
    throw new Error(`Unsupported native toolchain target: ${platform}/${arch}`);
  }
  return target;
}

function isDirectExecution() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    process.stdout.write(`${nativeToolchainTarget()}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
