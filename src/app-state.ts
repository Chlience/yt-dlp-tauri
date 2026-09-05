export type AppState = {
  download_directory: string;
  tools_root: string;
  toolchain_revision?: string | null;
  toolchain_source: ToolchainSource;
  local_toolchain: LocalToolchainConfig;
  local_toolchain_paths: LocalToolchainPaths;
  cookies_file?: string | null;
  cookies_origin?: string | null;
  proxy?: ProxyConfig;
};

export type ProxyConfig = {
  mode: "system" | "direct" | "custom";
  url?: string | null;
};

export type ToolchainSource = "managed" | "local";

export type LocalToolchainConfig = {
  schemaVersion: number;
  ytDlpPath?: string | null;
  ffmpegDirectory?: string | null;
  denoPath?: string | null;
};

export type LocalToolchainPaths = Omit<LocalToolchainConfig, "schemaVersion">;
