import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppState, LocalToolchainConfig, LocalToolchainPaths, ToolchainSource } from "./app-state";
import type { TranslationKey } from "./translations";
import type { GithubAccessMode } from "./update-check";
import {
  summarizeRemoteTools, summarizeTools, type RemoteToolManifest,
  type ToolAction, type ToolStatus, type ToolSummary, type ToolSummaryMode,
} from "./toolchain";

type SettingsContext = {
  state: {
    busy: boolean;
    toolsReady: boolean;
    toolAction: ToolAction | null;
    toolchainRevision: string | null;
    toolchainSource: ToolchainSource;
    localToolchain: LocalToolchainConfig;
    localToolchainPaths: LocalToolchainPaths;
    pendingToolManifestJson: string | null;
    githubAccessMode: GithubAccessMode;
  };
  elements: {
    toolList: HTMLElement;
    toolRoot: HTMLElement;
    toolInstallStatus: HTMLElement;
    toolchainRevision: HTMLElement;
    toolchainHint: HTMLElement;
    toolSourceManaged: HTMLButtonElement;
    toolSourceLocal: HTMLButtonElement;
    managedToolchainDetails: HTMLElement;
    localToolchainPaths: HTMLElement;
    localYtDlpPath: HTMLElement;
    localFfmpegPath: HTMLElement;
    localDenoPath: HTMLElement;
    autoDetectLocalTools: HTMLButtonElement;
    checkToolUpdates: HTMLButtonElement;
    reinstallTools: HTMLButtonElement;
    installTools: HTMLButtonElement;
  };
  t: (key: TranslationKey, values?: Record<string, string | number>) => string;
  setBusy: (busy: boolean, progressText?: string, operation?: "tools") => void;
  applyAppState: (state: AppState) => void;
  loadAppState: () => Promise<void>;
  invalidateParsedVideo: (message: string) => void;
  showNotice: (message: string, tone: "success" | "warning" | "error") => void;
  logEvent: (message: string) => void;
};

export type ToolInstallProgress = {
  percent?: number;
  status: string;
  tool?: string;
};

export function createToolchainSettings({
  state, elements, t, setBusy, applyAppState, loadAppState,
  invalidateParsedVideo, showNotice, logEvent,
}: SettingsContext) {
  async function setToolchainSource(source: ToolchainSource) {
    if (state.busy || source === state.toolchainSource) {
      return;
    }

    const previousSource = state.toolchainSource;
    let changed = false;
    setBusy(true, undefined, "tools");
    try {
      const appState = await invoke<AppState>("set_toolchain_source", { source });
      state.toolsReady = false;
      state.toolAction = null;
      state.pendingToolManifestJson = null;
      elements.toolList.replaceChildren();
      applyAppState(appState);
      invalidateParsedVideo(t("preview.toolsChanged"));
      logEvent(t(source === "local" ? "event.localToolsSelected" : "event.managedToolsSelected"));
      changed = true;
    } catch (error) {
      const message = String(error);
      state.toolchainSource = previousSource;
      renderToolchainSource();
      showNotice(t("settings.toolSourceFailed", { message }), "error");
    } finally {
      setBusy(false);
    }

    if (changed) {
      await verifyTools();
    }
  }

  async function chooseLocalTool(tool: "yt-dlp" | "ffmpeg" | "deno") {
    if (state.busy || state.toolchainSource !== "local") {
      return;
    }

    const directory = tool === "ffmpeg";
    const selected = await open({
      multiple: false,
      directory,
      ...(directory
        ? {}
        : {
            filters: [{ name: "Executable", extensions: ["exe"] }],
          }),
    });
    if (typeof selected !== "string") {
      return;
    }

    const config = { ...state.localToolchain };
    if (tool === "yt-dlp") {
      config.ytDlpPath = selected;
    } else if (tool === "ffmpeg") {
      config.ffmpegDirectory = selected;
    } else {
      config.denoPath = selected;
    }
    await saveLocalToolchain(config);
  }

  async function saveLocalToolchain(config: LocalToolchainConfig) {
    let saved = false;
    setBusy(true, undefined, "tools");
    try {
      const appState = await invoke<AppState>("set_local_toolchain", {
        config: {
          ytDlpPath: config.ytDlpPath ?? null,
          ffmpegDirectory: config.ffmpegDirectory ?? null,
          denoPath: config.denoPath ?? null,
        },
      });
      state.toolsReady = false;
      applyAppState(appState);
      invalidateParsedVideo(t("preview.toolsChanged"));
      saved = true;
    } catch (error) {
      showNotice(t("settings.localToolSaveFailed", { message: String(error) }), "error");
    } finally {
      setBusy(false);
    }

    if (saved) {
      await verifyTools();
    }
  }

  async function autoDetectLocalTools() {
    if (state.busy || state.toolchainSource !== "local") {
      return;
    }

    let detected = false;
    setBusy(true, undefined, "tools");
    elements.toolInstallStatus.textContent = t("settings.detectingLocalTools");
    try {
      const appState = await invoke<AppState>("auto_detect_local_toolchain");
      state.toolsReady = false;
      applyAppState(appState);
      invalidateParsedVideo(t("preview.toolsChanged"));
      detected = true;
    } catch (error) {
      showNotice(t("settings.localToolDetectFailed", { message: String(error) }), "error");
    } finally {
      setBusy(false);
    }

    if (detected) {
      await verifyTools();
    }
  }

  async function verifyTools(options: { quietReady?: boolean } = {}) {
    setBusy(true, undefined, "tools");
    state.pendingToolManifestJson = null;
    elements.toolInstallStatus.textContent = t("settings.toolsChecking");
    try {
      const tools = await invoke<ToolStatus[]>("check_tools");
      const summary = applyToolSummary(
        tools,
        state.toolchainSource === "local" ? "local" : "managed",
      );
      reportToolSummary(summary, options.quietReady);
    } catch (error) {
      state.toolsReady = false;
      state.toolAction = state.toolchainSource === "managed" ? "install" : null;
      const message = String(error);
      elements.toolInstallStatus.textContent = message || t("settings.toolCheckFailed");
      showNotice(message || t("settings.toolCheckFailed"), "error");
      updateToolActionButton();
    } finally {
      setBusy(false);
    }
  }

  async function installTools() {
    if (state.busy || state.toolchainSource !== "managed" || !state.toolAction) {
      return;
    }

    if (state.toolAction === "reinstall") {
      await reinstallTools();
      return;
    }

    await runToolInstallation(state.toolAction);
  }

  async function runToolInstallation(action: ToolAction) {
    setBusy(true, undefined, "tools");
    elements.toolInstallStatus.textContent = t(toolActionStatusKey(action));
    try {
      let tools: ToolStatus[];
      if (action === "reinstall") {
        tools = await invoke<ToolStatus[]>("reinstall_tools", {
          manifestJson: null,
          githubAccessMode: state.githubAccessMode,
        });
      } else if (state.pendingToolManifestJson) {
        tools = await invoke<ToolStatus[]>("install_tools_from_manifest", {
          manifestJson: state.pendingToolManifestJson,
          githubAccessMode: state.githubAccessMode,
        });
      } else {
        tools = await invoke<ToolStatus[]>("install_tools", {
          githubAccessMode: state.githubAccessMode,
        });
      }
      state.pendingToolManifestJson = null;
      await loadAppState();
      applyToolSummary(tools, "managed");
      elements.toolInstallStatus.textContent = state.toolsReady ? t("settings.toolsInstalled") : t("settings.toolsInstallPartial");
      showNotice(state.toolsReady ? t("notice.toolsInstalled") : t("notice.toolInstallNeedsAttention"), state.toolsReady ? "success" : "warning");
      logEvent(state.toolsReady ? t("event.toolsInstalled") : t("event.toolsPartial"));
    } catch (error) {
      const message = String(error);
      elements.toolInstallStatus.textContent = message || t("settings.toolInstallFailed");
      showNotice(message || t("settings.toolInstallFailed"), "error");
      logEvent(`${t("event.toolInstallFailed")} ${message}`.trim());
    } finally {
      setBusy(false);
    }
  }

  async function checkToolUpdates() {
    if (state.busy || state.toolchainSource !== "managed") {
      return;
    }

    setBusy(true, undefined, "tools");
    state.pendingToolManifestJson = null;
    if (state.toolAction === "update") {
      state.toolAction = null;
      updateToolActionButton();
    }
    elements.toolInstallStatus.textContent = t("settings.toolUpdatesChecking");
    try {
      const manifestResult = await invoke<RemoteToolManifest>("fetch_latest_tool_manifest", {
        githubAccessMode: state.githubAccessMode,
      });

      if (manifestResult.status === "no_release") {
        elements.toolInstallStatus.textContent = t("updates.noRelease");
        showNotice(t("updates.noRelease"), "warning");
        return;
      }

      if (manifestResult.status === "no_manifest") {
        elements.toolInstallStatus.textContent = t("settings.toolUpdatesNoManifest");
        showNotice(t("settings.toolUpdatesNoManifest"), "warning");
        return;
      }

      if (
        !manifestResult.manifestJson ||
        !manifestResult.source ||
        (manifestResult.source === "archive" && !manifestResult.revision)
      ) {
        elements.toolInstallStatus.textContent = t("settings.toolUpdatesInvalidManifest");
        showNotice(t("settings.toolUpdatesInvalidManifest"), "warning");
        return;
      }

      const manifestJson = manifestResult.manifestJson;
      const tools = await invoke<ToolStatus[]>("check_tools_with_manifest", { manifestJson });
      const summary = applyToolSummary(tools, "remote", { remoteRevision: manifestResult.revision });
      reportToolSummary(summary);
      if (summary.action) {
        state.pendingToolManifestJson = manifestJson;
        updateToolActionButton();
      } else {
        elements.toolInstallStatus.textContent = t("settings.toolUpdatesCurrent");
        logEvent(t("event.toolUpdatesCurrent"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      elements.toolInstallStatus.textContent = t("settings.toolUpdatesFailed", { message });
      showNotice(t("settings.toolUpdatesFailed", { message }), "error");
    } finally {
      setBusy(false);
    }
  }

  async function reinstallTools() {
    if (state.busy || state.toolchainSource !== "managed") {
      return;
    }

    const path = elements.toolRoot.textContent || t("settings.toolsPathPending");
    if (!window.confirm(t("settings.reinstallConfirm", { path }))) {
      return;
    }

    await runToolInstallation("reinstall");
  }

  function renderTools(tools: ToolStatus[]) {
    elements.toolList.replaceChildren(
      ...tools.map((tool) => {
        const row = document.createElement("li");
        row.className = `tool-row is-${tool.availability}`;
        row.innerHTML = `
          <span class="tool-dot"></span>
          <span class="tool-name"></span>
          <span class="tool-version"></span>
        `;
        row.querySelector(".tool-name")!.textContent = tool.name;
        row.querySelector(".tool-version")!.textContent = formatToolVersion(tool);
        row.title = formatToolTitle(tool);
        return row;
      }),
    );
  }

  function renderToolchainRevision() {
    elements.toolchainRevision.textContent =
      state.toolchainRevision ?? t("settings.noActiveRevision");
  }

  function renderToolchainSource() {
    const isLocal = state.toolchainSource === "local";
    elements.toolSourceManaged.classList.toggle("is-active", !isLocal);
    elements.toolSourceLocal.classList.toggle("is-active", isLocal);
    elements.toolSourceManaged.setAttribute("aria-pressed", String(!isLocal));
    elements.toolSourceLocal.setAttribute("aria-pressed", String(isLocal));
    elements.managedToolchainDetails.hidden = isLocal;
    elements.localToolchainPaths.hidden = !isLocal;
    elements.toolchainHint.textContent = t(
      isLocal ? "settings.localToolchainHint" : "settings.toolchainHint",
    );
    elements.autoDetectLocalTools.title = t("settings.usePathHint");
    elements.checkToolUpdates.hidden = isLocal;
    elements.reinstallTools.hidden = isLocal;
    updateToolActionButton();
  }

  function renderLocalToolchainPaths() {
    renderLocalToolPath(elements.localYtDlpPath, state.localToolchainPaths.ytDlpPath);
    renderLocalToolPath(elements.localFfmpegPath, state.localToolchainPaths.ffmpegDirectory);
    renderLocalToolPath(elements.localDenoPath, state.localToolchainPaths.denoPath);
  }

  function renderLocalToolPath(element: HTMLElement, path?: string | null) {
    const value = path?.trim() || "";
    element.textContent = value || t("settings.localPathNotDetected");
    element.title = value || t("settings.localPathNotDetected");
  }

  function applyToolSummary(
    tools: ToolStatus[],
    mode: ToolSummaryMode,
    options: { remoteRevision?: string | null } = {},
  ) {
    const summary =
      mode === "remote"
        ? summarizeRemoteTools(tools, state.toolchainRevision, options.remoteRevision ?? null)
        : summarizeTools(tools, mode);
    if (mode !== "remote") {
      state.toolsReady = summary.ready;
    }
    state.toolAction = summary.action;
    renderTools(tools);
    updateToolActionButton();
    elements.toolInstallStatus.textContent = t(summary.settingsKey);
    return summary;
  }

  function reportToolSummary(summary: ToolSummary, quietReady = false) {
    if (!(quietReady && summary.ready)) {
      showNotice(t(summary.noticeKey), summary.tone);
    }
    logEvent(t(summary.eventKey));
  }

  function formatToolVersion(tool: ToolStatus) {
    if (tool.availability === "outdated" && tool.expected_version) {
      return `${tool.version || t("tool.currentUnknown")} -> ${tool.expected_version}`;
    }
    return tool.version || tool.error || tool.relative_path;
  }

  function formatToolTitle(tool: ToolStatus) {
    return [
      tool.full_path,
      tool.expected_version ? `Expected ${tool.expected_version}` : null,
      tool.error,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function updateToolInstallProgress(progress: ToolInstallProgress) {
    elements.toolInstallStatus.textContent = [
      progress.status,
      typeof progress.percent === "number" ? `${progress.percent.toFixed(0)}%` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (typeof progress.percent !== "number" || progress.percent >= 100) {
      logEvent(progress.tool ? `${progress.status}: ${progress.tool}` : progress.status);
    }
  }

  function updateToolActionButton() {
    elements.installTools.hidden =
      state.toolchainSource === "local" || state.toolAction === null;
    if (!state.toolAction) {
      return;
    }

    const labelKey =
      state.toolAction === "reinstall"
        ? "action.reinstallTools"
        : state.toolAction === "update"
          ? "action.updateTools"
          : "action.installTools";
    elements.installTools.textContent = t(labelKey);
  }

  function toolActionStatusKey(action: ToolAction): TranslationKey {
    if (action === "reinstall") {
      return "settings.reinstallingTools";
    }
    if (action === "update") {
      return "settings.updatingTools";
    }
    return "settings.installingTools";
  }

  return {
    setToolchainSource, chooseLocalTool, autoDetectLocalTools, verifyTools,
    installTools, checkToolUpdates, reinstallTools, renderToolchainRevision,
    renderToolchainSource, renderLocalToolchainPaths, updateToolActionButton,
    updateToolInstallProgress,
  };
}
