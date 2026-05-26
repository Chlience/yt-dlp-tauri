import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import packageInfo from "../package.json";
import { getUpdateStatus, parseLatestRelease } from "./update-check";

type ToolStatus = {
  name: string;
  relative_path: string;
  full_path: string;
  availability: "available" | "missing" | "cannot_execute";
  version?: string;
  error?: string;
};

type VideoFormatOption = {
  label: string;
  format_selector: string;
  height?: number;
  extension: string;
  is_best: boolean;
};

type VideoMetadata = {
  title: string;
  id?: string;
  webpage_url: string;
  thumbnail_url?: string;
  duration_seconds?: number;
  description?: string;
  format_options: VideoFormatOption[];
};

type AppState = {
  download_directory: string;
  tools_root: string;
};

type DownloadProgress = {
  percent?: number;
  status: string;
  speed?: string;
  eta?: string;
  raw?: string;
};

type ToolInstallProgress = {
  percent?: number;
  status: string;
  tool?: string;
};

const APP_VERSION = packageInfo.version;
const PROJECT_REPOSITORY_URL = "https://github.com/Chlience/yt-dlp-tauri";
const PROJECT_RELEASES_URL = `${PROJECT_REPOSITORY_URL}/releases`;
const LATEST_RELEASE_API_URL = "https://api.github.com/repos/Chlience/yt-dlp-tauri/releases/latest";

const translations = {
  en: {
    "app.title": "yt-dlp-tauri",
    "app.eyebrow": "Desktop downloader",
    "app.heading": "Paste, choose, download.",
    "language.label": "Language",
    "action.settings": "Settings",
    "action.close": "Close",
    "action.parse": "Parse",
    "action.download": "Download",
    "action.cancel": "Cancel",
    "action.openFolder": "Open folder",
    "action.browse": "Browse",
    "action.save": "Save",
    "action.reset": "Reset",
    "action.refresh": "Refresh",
    "action.installTools": "Install tools",
    "action.repairTools": "Repair tools",
    "action.checkUpdates": "Check updates",
    "action.openRelease": "Open release",
    "action.github": "GitHub",
    "url.label": "Video URL",
    "url.placeholder": "https://www.youtube.com/watch?v=...",
    "preview.thumbnailAlt": "video thumbnail",
    "preview.emptyImage": "Preview",
    "preview.label": "Preview",
    "preview.noVideo": "No video parsed",
    "preview.emptyStart": "Paste a video URL to inspect title, cover, duration, and qualities.",
    "preview.emptyChanged": "Paste a URL and parse it before downloading.",
    "preview.readingMetadata": "Reading metadata from yt-dlp...",
    "preview.parseFailed": "Metadata parsing failed. Check the URL and tools.",
    "preview.noDescription": "No description returned by yt-dlp.",
    "download.quality": "Quality",
    "progress.idle": "Idle",
    "progress.parsing": "Parsing video metadata...",
    "progress.startingDownload": "Starting {quality} download...",
    "progress.savedTo": "Saved to {path}",
    "progress.completedOpenFolder": "Download completed. Open the folder to view the file.",
    "progress.downloadCancelled": "Download cancelled.",
    "progress.downloadFailed": "Download failed.",
    "progress.cancelling": "Cancelling download...",
    "progress.eta": "ETA",
    "notice.checkingTools": "Checking tools...",
    "notice.toolchainReady": "Toolchain ready.",
    "notice.toolsMissing": "Some tools are missing.",
    "notice.toolCheckFailed": "Tool check failed.",
    "notice.toolsInstalled": "Toolchain installed.",
    "notice.toolInstallNeedsAttention": "Tool install needs attention.",
    "notice.toolInstallFailed": "Tool install failed.",
    "notice.metadataParsed": "Metadata parsed.",
    "notice.downloadCompleted": "Download completed.",
    "notice.downloadCancelled": "Download cancelled.",
    "notice.folderUpdated": "Download folder updated.",
    "notice.folderReset": "Download folder reset.",
    "updates.checking": "Checking GitHub releases...",
    "updates.available": "New version available: {version}",
    "updates.current": "You are up to date.",
    "updates.noRelease": "No GitHub release found yet.",
    "updates.invalidRelease": "GitHub returned an unreadable release.",
    "updates.failed": "Could not check updates: {message}",
    "settings.kicker": "Preferences",
    "settings.title": "Settings",
    "settings.outputFolder": "Output folder",
    "settings.resolvingFolder": "Resolving download folder...",
    "settings.toolchain": "Toolchain",
    "settings.toolchainHint": "Per-target tools are verified with SHA-256.",
    "settings.resolvingTools": "Resolving tools path...",
    "settings.installMissing": "Install missing tools automatically.",
    "settings.toolsPathPending": "Tools path not resolved yet",
    "settings.toolsChecking": "Checking tools...",
    "settings.toolsAvailable": "All required tools are available.",
    "settings.toolsMissing": "Missing tools can be installed automatically.",
    "settings.toolCheckFailed": "Tool check failed.",
    "settings.toolsInstalled": "Toolchain installed.",
    "settings.toolsInstallPartial": "Install finished, but some tools still need attention.",
    "settings.toolInstallFailed": "Tool install failed.",
    "settings.activity": "Activity",
    "settings.activityHint": "Recent local events.",
    "settings.version": "Version",
    "settings.chooseFolder": "Choose download folder",
    "event.booted": "App booted.",
    "event.toolsAvailable": "yt-dlp, ffmpeg, ffprobe and deno are available.",
    "event.toolsMissing": "Tool check found missing tools.",
    "event.toolsInstalled": "Toolchain installed.",
    "event.toolsPartial": "Tool install completed with missing tools.",
    "event.toolInstallFailed": "Tool install failed.",
    "event.parsed": "Parsed {title}",
    "event.metadataFailed": "Metadata parsing failed.",
    "event.saved": "Saved {path}",
    "event.downloadCompleted": "Download completed.",
    "event.downloadCancelled": "Download cancelled.",
    "event.downloadFailed": "Download failed.",
    "event.cancelRequested": "Cancel requested.",
  },
  zh: {
    "app.title": "yt-dlp-tauri",
    "app.eyebrow": "桌面下载器",
    "app.heading": "粘贴，选择，下载。",
    "language.label": "语言",
    "action.settings": "设置",
    "action.close": "关闭",
    "action.parse": "解析",
    "action.download": "下载",
    "action.cancel": "取消",
    "action.openFolder": "打开目录",
    "action.browse": "浏览",
    "action.save": "保存",
    "action.reset": "重置",
    "action.refresh": "刷新",
    "action.installTools": "安装工具",
    "action.repairTools": "修复工具",
    "action.checkUpdates": "检查更新",
    "action.openRelease": "打开发布页",
    "action.github": "GitHub",
    "url.label": "视频链接",
    "url.placeholder": "https://www.youtube.com/watch?v=...",
    "preview.thumbnailAlt": "视频缩略图",
    "preview.emptyImage": "预览",
    "preview.label": "预览",
    "preview.noVideo": "尚未解析视频",
    "preview.emptyStart": "粘贴视频链接后解析，可查看标题、封面、时长和清晰度。",
    "preview.emptyChanged": "请先解析当前链接，再开始下载。",
    "preview.readingMetadata": "正在通过 yt-dlp 读取信息...",
    "preview.parseFailed": "解析失败。请检查链接和工具链。",
    "preview.noDescription": "yt-dlp 未返回描述。",
    "download.quality": "清晰度",
    "progress.idle": "空闲",
    "progress.parsing": "正在解析视频信息...",
    "progress.startingDownload": "开始下载 {quality}...",
    "progress.savedTo": "已保存到 {path}",
    "progress.completedOpenFolder": "下载完成。打开目录即可查看文件。",
    "progress.downloadCancelled": "下载已取消。",
    "progress.downloadFailed": "下载失败。",
    "progress.cancelling": "正在取消下载...",
    "progress.eta": "剩余",
    "notice.checkingTools": "正在检查工具链...",
    "notice.toolchainReady": "工具链已就绪。",
    "notice.toolsMissing": "缺少部分工具。",
    "notice.toolCheckFailed": "工具检查失败。",
    "notice.toolsInstalled": "工具链已安装。",
    "notice.toolInstallNeedsAttention": "工具安装需要处理。",
    "notice.toolInstallFailed": "工具安装失败。",
    "notice.metadataParsed": "视频信息已解析。",
    "notice.downloadCompleted": "下载完成。",
    "notice.downloadCancelled": "下载已取消。",
    "notice.folderUpdated": "下载目录已更新。",
    "notice.folderReset": "下载目录已重置。",
    "updates.checking": "正在检查 GitHub Releases...",
    "updates.available": "发现新版本：{version}",
    "updates.current": "当前已是最新版本。",
    "updates.noRelease": "暂未找到 GitHub Release。",
    "updates.invalidRelease": "GitHub 返回的发布信息无法读取。",
    "updates.failed": "检查更新失败：{message}",
    "settings.kicker": "偏好",
    "settings.title": "设置",
    "settings.outputFolder": "输出目录",
    "settings.resolvingFolder": "正在解析下载目录...",
    "settings.toolchain": "工具链",
    "settings.toolchainHint": "按目标平台安装，并用 SHA-256 校验。",
    "settings.resolvingTools": "正在解析工具路径...",
    "settings.installMissing": "可自动安装缺失工具。",
    "settings.toolsPathPending": "工具路径尚未解析",
    "settings.toolsChecking": "正在检查工具链...",
    "settings.toolsAvailable": "所需工具均可用。",
    "settings.toolsMissing": "可自动安装缺失工具。",
    "settings.toolCheckFailed": "工具检查失败。",
    "settings.toolsInstalled": "工具链已安装。",
    "settings.toolsInstallPartial": "安装结束，但仍有工具需要处理。",
    "settings.toolInstallFailed": "工具安装失败。",
    "settings.activity": "活动",
    "settings.activityHint": "最近的本地事件。",
    "settings.version": "版本",
    "settings.chooseFolder": "选择下载目录",
    "event.booted": "应用已启动。",
    "event.toolsAvailable": "yt-dlp、ffmpeg、ffprobe 和 deno 均可用。",
    "event.toolsMissing": "工具检查发现缺失项。",
    "event.toolsInstalled": "工具链已安装。",
    "event.toolsPartial": "工具安装完成，但仍有缺失项。",
    "event.toolInstallFailed": "工具安装失败。",
    "event.parsed": "已解析 {title}",
    "event.metadataFailed": "视频信息解析失败。",
    "event.saved": "已保存 {path}",
    "event.downloadCompleted": "下载完成。",
    "event.downloadCancelled": "下载已取消。",
    "event.downloadFailed": "下载失败。",
    "event.cancelRequested": "已请求取消。",
  },
} as const;

type Language = keyof typeof translations;
type TranslationKey = keyof (typeof translations)["en"];
type NoticeTone = "success" | "warning" | "error";
type UpdateTone = "neutral" | "success" | "warning" | "error";

const state = {
  metadata: null as VideoMetadata | null,
  selectedFormat: null as VideoFormatOption | null,
  busy: false,
  activeOperation: null as "metadata" | "download" | "tools" | null,
  cancelRequested: false,
  lastUrl: "",
  toolsReady: false,
  updateChecking: false,
  latestReleaseUrl: "",
  updateStatus: null as { key: TranslationKey; values: Record<string, string | number>; tone: UpdateTone } | null,
  language: resolveInitialLanguage(),
};

const elements = {
  url: must<HTMLInputElement>("#url"),
  parse: must<HTMLButtonElement>("#parse"),
  download: must<HTMLButtonElement>("#download"),
  cancel: must<HTMLButtonElement>("#cancel"),
  openFolder: must<HTMLButtonElement>("#open-folder"),
  settingsToggle: must<HTMLButtonElement>("#settings-toggle"),
  settingsClose: must<HTMLButtonElement>("#settings-close"),
  settingsBackdrop: must<HTMLElement>("#settings-backdrop"),
  settingsDrawer: must<HTMLElement>("#settings-drawer"),
  languageEn: must<HTMLButtonElement>("#language-en"),
  languageZh: must<HTMLButtonElement>("#language-zh"),
  refreshTools: must<HTMLButtonElement>("#refresh-tools"),
  installTools: must<HTMLButtonElement>("#install-tools"),
  browseFolder: must<HTMLButtonElement>("#browse-folder"),
  resetFolder: must<HTMLButtonElement>("#reset-folder"),
  saveFolder: must<HTMLButtonElement>("#save-folder"),
  checkUpdates: must<HTMLButtonElement>("#check-updates"),
  releaseLink: must<HTMLButtonElement>("#release-link"),
  githubLink: must<HTMLButtonElement>("#github-link"),
  appVersion: must<HTMLElement>("#app-version"),
  updateStatus: must<HTMLElement>("#update-status"),
  folderInput: must<HTMLInputElement>("#folder-input"),
  folderText: must<HTMLElement>("#folder-text"),
  toolRoot: must<HTMLElement>("#tool-root"),
  toolList: must<HTMLElement>("#tool-list"),
  toolInstallStatus: must<HTMLElement>("#tool-install-status"),
  title: must<HTMLElement>("#video-title"),
  details: must<HTMLElement>("#video-details"),
  description: must<HTMLElement>("#video-description"),
  thumbnail: must<HTMLImageElement>("#thumbnail"),
  thumbnailEmpty: must<HTMLElement>("#thumbnail-empty"),
  quality: must<HTMLSelectElement>("#quality"),
  progress: must<HTMLProgressElement>("#progress"),
  progressText: must<HTMLElement>("#progress-text"),
  events: must<HTMLElement>("#events"),
  notice: must<HTMLElement>("#notice"),
};

window.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  applyTranslations();
  listen<DownloadProgress>("download-progress", (event) => updateDownloadProgress(event.payload));
  listen<ToolInstallProgress>("tool-install-progress", (event) => updateToolInstallProgress(event.payload));
  void bootstrap();
});

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}

function resolveInitialLanguage(): Language {
  const stored = localStorage.getItem("yt-dlp-tauri-language");
  if (stored === "en" || stored === "zh") {
    return stored;
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function t(key: TranslationKey, values: Record<string, string | number> = {}) {
  let text: string = translations[state.language][key] || translations.en[key] || key;
  for (const [name, value] of Object.entries(values)) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

function applyTranslations() {
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  document.title = t("app.title");

  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n as TranslationKey | undefined;
    if (key) {
      element.textContent = t(key);
    }
  });

  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-placeholder]").forEach((element) => {
    const key = element.dataset.i18nPlaceholder as TranslationKey | undefined;
    if (key) {
      element.placeholder = t(key);
    }
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((element) => {
    const key = element.dataset.i18nAriaLabel as TranslationKey | undefined;
    if (key) {
      element.setAttribute("aria-label", t(key));
    }
  });

  document.querySelectorAll<HTMLImageElement>("[data-i18n-alt]").forEach((element) => {
    const key = element.dataset.i18nAlt as TranslationKey | undefined;
    if (key) {
      element.alt = t(key);
    }
  });

  elements.languageEn.classList.toggle("is-active", state.language === "en");
  elements.languageZh.classList.toggle("is-active", state.language === "zh");
  elements.languageEn.setAttribute("aria-pressed", String(state.language === "en"));
  elements.languageZh.setAttribute("aria-pressed", String(state.language === "zh"));
  elements.appVersion.textContent = APP_VERSION;
  if (state.updateStatus) {
    renderUpdateStatus(t(state.updateStatus.key, state.updateStatus.values), state.updateStatus.tone);
  }
  updateInstallButtonLabel();
}

function setLanguage(language: Language) {
  state.language = language;
  localStorage.setItem("yt-dlp-tauri-language", language);
  applyTranslations();
  if (!state.metadata) {
    renderEmptyPreview(t("preview.emptyStart"));
  }
}

function setSettingsOpen(isOpen: boolean) {
  elements.settingsDrawer.hidden = !isOpen;
  elements.settingsBackdrop.hidden = !isOpen;
  elements.settingsDrawer.setAttribute("aria-hidden", String(!isOpen));
  document.body.classList.toggle("settings-open", isOpen);

  if (isOpen) {
    elements.settingsClose.focus();
  } else {
    elements.settingsToggle.focus();
  }
}

function bindEvents() {
  elements.parse.addEventListener("click", () => void parseCurrentUrl());
  elements.download.addEventListener("click", () => void downloadCurrentVideo());
  elements.cancel.addEventListener("click", () => void cancelCurrentDownload());
  elements.settingsToggle.addEventListener("click", () => setSettingsOpen(true));
  elements.settingsClose.addEventListener("click", () => setSettingsOpen(false));
  elements.settingsBackdrop.addEventListener("click", () => setSettingsOpen(false));
  elements.languageEn.addEventListener("click", () => setLanguage("en"));
  elements.languageZh.addEventListener("click", () => setLanguage("zh"));
  elements.refreshTools.addEventListener("click", () => void refreshTools());
  elements.installTools.addEventListener("click", () => void installTools());
  elements.openFolder.addEventListener("click", () => void openDownloadFolder());
  elements.browseFolder.addEventListener("click", () => void browseDownloadFolder());
  elements.saveFolder.addEventListener("click", () => void saveDownloadFolder());
  elements.resetFolder.addEventListener("click", () => void resetDownloadFolder());
  elements.checkUpdates.addEventListener("click", () => void checkForUpdates());
  elements.releaseLink.addEventListener("click", () => void openLatestRelease());
  elements.githubLink.addEventListener("click", () => void openProjectRepository());
  elements.quality.addEventListener("change", () => {
    state.selectedFormat = state.metadata?.format_options[elements.quality.selectedIndex] ?? null;
    updateButtons();
  });
  elements.url.addEventListener("input", () => {
    if (elements.url.value.trim() !== state.lastUrl) {
      state.metadata = null;
      state.selectedFormat = null;
      renderEmptyPreview(t("preview.emptyChanged"));
      renderQualityOptions([]);
    }
    updateButtons();
  });
  elements.url.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void parseCurrentUrl();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.settingsDrawer.hidden) {
      setSettingsOpen(false);
    }
  });
}

async function bootstrap() {
  showNotice(t("notice.checkingTools"), "warning");
  elements.progressText.textContent = t("progress.idle");
  renderEmptyPreview(t("preview.emptyStart"));
  logEvent(t("event.booted"));
  await loadAppState();
  await refreshTools();
}

async function loadAppState() {
  const appState = await invoke<AppState>("get_app_state");
  elements.folderText.textContent = appState.download_directory;
  elements.folderInput.value = appState.download_directory;
  elements.toolRoot.textContent = appState.tools_root || t("settings.toolsPathPending");
}

async function refreshTools() {
  setBusy(true, undefined, "tools");
  elements.toolInstallStatus.textContent = t("settings.toolsChecking");
  try {
    const tools = await invoke<ToolStatus[]>("check_tools");
    state.toolsReady = tools.every((tool) => tool.availability === "available");
    renderTools(tools);
    updateInstallButtonLabel();
    elements.toolInstallStatus.textContent = state.toolsReady ? t("settings.toolsAvailable") : t("settings.toolsMissing");
    showNotice(state.toolsReady ? t("notice.toolchainReady") : t("notice.toolsMissing"), state.toolsReady ? "success" : "warning");
    logEvent(state.toolsReady ? t("event.toolsAvailable") : t("event.toolsMissing"));
  } catch (error) {
    state.toolsReady = false;
    elements.toolInstallStatus.textContent = t("settings.toolCheckFailed");
    showNotice(String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function installTools() {
  if (state.busy) {
    return;
  }

  setBusy(true, undefined, "tools");
  elements.toolInstallStatus.textContent = t("settings.installMissing");
  try {
    const tools = await invoke<ToolStatus[]>("install_tools");
    state.toolsReady = tools.every((tool) => tool.availability === "available");
    renderTools(tools);
    updateInstallButtonLabel();
    elements.toolInstallStatus.textContent = state.toolsReady ? t("settings.toolsInstalled") : t("settings.toolsInstallPartial");
    showNotice(state.toolsReady ? t("notice.toolsInstalled") : t("notice.toolInstallNeedsAttention"), state.toolsReady ? "success" : "warning");
    logEvent(state.toolsReady ? t("event.toolsInstalled") : t("event.toolsPartial"));
  } catch (error) {
    elements.toolInstallStatus.textContent = t("settings.toolInstallFailed");
    showNotice(String(error), "error");
    logEvent(t("event.toolInstallFailed"));
  } finally {
    setBusy(false);
  }
}

async function parseCurrentUrl() {
  const url = elements.url.value.trim();
  if (!url || state.busy) {
    return;
  }

  setBusy(true, t("progress.parsing"), "metadata");
  renderEmptyPreview(t("preview.readingMetadata"));
  try {
    const metadata = await invoke<VideoMetadata>("parse_metadata", { url });
    state.metadata = metadata;
    state.lastUrl = url;
    state.selectedFormat = metadata.format_options[0] ?? null;
    renderMetadata(metadata);
    renderQualityOptions(metadata.format_options);
    showNotice(t("notice.metadataParsed"), "success");
    logEvent(t("event.parsed", { title: metadata.title }));
  } catch (error) {
    renderEmptyPreview(t("preview.parseFailed"));
    showNotice(String(error), "error");
    logEvent(t("event.metadataFailed"));
  } finally {
    setBusy(false);
  }
}

async function downloadCurrentVideo() {
  const metadata = state.metadata;
  const selectedFormat = state.selectedFormat;
  const url = state.lastUrl || elements.url.value.trim();
  if (!metadata || !selectedFormat || !url || state.busy) {
    return;
  }

  setBusy(true, t("progress.startingDownload", { quality: selectedFormat.label }), "download");
  elements.progress.removeAttribute("value");
  try {
    const outputPath = await invoke<string | null>("download_video", {
      request: {
        url,
        format_selector: selectedFormat.format_selector,
        label: selectedFormat.label,
      },
    });
    elements.progress.value = 100;
    elements.progressText.textContent = outputPath ? t("progress.savedTo", { path: outputPath }) : t("progress.completedOpenFolder");
    showNotice(t("notice.downloadCompleted"), "success");
    logEvent(outputPath ? t("event.saved", { path: outputPath }) : t("event.downloadCompleted"));
  } catch (error) {
    const message = String(error);
    elements.progress.value = 0;
    if (message.toLowerCase().includes("cancel")) {
      elements.progressText.textContent = t("progress.downloadCancelled");
      showNotice(t("notice.downloadCancelled"), "warning");
      logEvent(t("event.downloadCancelled"));
    } else {
      elements.progressText.textContent = t("progress.downloadFailed");
      showNotice(message, "error");
      logEvent(t("event.downloadFailed"));
    }
  } finally {
    setBusy(false);
  }
}

async function cancelCurrentDownload() {
  if (state.activeOperation !== "download" || state.cancelRequested) {
    return;
  }

  state.cancelRequested = true;
  elements.progressText.textContent = t("progress.cancelling");
  updateButtons();
  try {
    await invoke("cancel_download");
    logEvent(t("event.cancelRequested"));
  } catch (error) {
    showNotice(String(error), "error");
    state.cancelRequested = false;
    updateButtons();
  }
}

async function openDownloadFolder() {
  try {
    await invoke("open_download_directory");
  } catch (error) {
    showNotice(String(error), "error");
  }
}

async function openProjectRepository() {
  try {
    await openUrl(PROJECT_REPOSITORY_URL);
  } catch (error) {
    showNotice(String(error), "error");
  }
}

async function openLatestRelease() {
  try {
    await openUrl(state.latestReleaseUrl || PROJECT_RELEASES_URL);
  } catch (error) {
    showNotice(String(error), "error");
  }
}

async function checkForUpdates() {
  if (state.updateChecking) {
    return;
  }

  state.updateChecking = true;
  state.latestReleaseUrl = "";
  elements.releaseLink.hidden = true;
  setUpdateStatus("updates.checking", "neutral");
  updateButtons();

  try {
    const response = await fetch(LATEST_RELEASE_API_URL, {
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
      },
    });

    if (response.status === 404) {
      setUpdateStatus("updates.noRelease", "warning");
      return;
    }

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`.trim());
    }

    const latestRelease = parseLatestRelease(await response.json());
    if (!latestRelease) {
      setUpdateStatus("updates.invalidRelease", "error");
      return;
    }

    const updateStatus = getUpdateStatus(APP_VERSION, latestRelease);
    if (updateStatus.kind === "available") {
      state.latestReleaseUrl = updateStatus.releaseUrl;
      elements.releaseLink.hidden = false;
      setUpdateStatus("updates.available", "success", { version: updateStatus.latestVersion });
    } else {
      setUpdateStatus("updates.current", "success");
    }
  } catch (error) {
    setUpdateStatus("updates.failed", "error", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    state.updateChecking = false;
    updateButtons();
  }
}

async function browseDownloadFolder() {
  try {
    const selected = await open({
      title: t("settings.chooseFolder"),
      directory: true,
      multiple: false,
      defaultPath: elements.folderInput.value || undefined,
    });

    if (typeof selected === "string") {
      elements.folderInput.value = selected;
      await saveDownloadFolder();
    }
  } catch (error) {
    showNotice(String(error), "error");
  }
}

async function saveDownloadFolder() {
  try {
    const appState = await invoke<AppState>("set_download_directory", { directory: elements.folderInput.value });
    elements.folderText.textContent = appState.download_directory;
    elements.folderInput.value = appState.download_directory;
    showNotice(t("notice.folderUpdated"), "success");
  } catch (error) {
    showNotice(String(error), "error");
  }
}

async function resetDownloadFolder() {
  try {
    const appState = await invoke<AppState>("reset_download_directory");
    elements.folderText.textContent = appState.download_directory;
    elements.folderInput.value = appState.download_directory;
    showNotice(t("notice.folderReset"), "success");
  } catch (error) {
    showNotice(String(error), "error");
  }
}

function renderMetadata(metadata: VideoMetadata) {
  elements.title.textContent = metadata.title;
  elements.details.textContent = [
    metadata.id ? `ID ${metadata.id}` : null,
    metadata.duration_seconds ? formatDuration(metadata.duration_seconds) : null,
    metadata.webpage_url,
  ]
    .filter(Boolean)
    .join(" · ");
  elements.description.textContent = metadata.description?.trim() || t("preview.noDescription");

  if (metadata.thumbnail_url) {
    elements.thumbnail.src = metadata.thumbnail_url;
    elements.thumbnail.hidden = false;
    elements.thumbnailEmpty.hidden = true;
  } else {
    elements.thumbnail.removeAttribute("src");
    elements.thumbnail.hidden = true;
    elements.thumbnailEmpty.hidden = false;
  }
}

function renderEmptyPreview(message: string) {
  elements.title.textContent = t("preview.noVideo");
  elements.details.textContent = message;
  elements.description.textContent = "";
  elements.thumbnail.removeAttribute("src");
  elements.thumbnail.hidden = true;
  elements.thumbnailEmpty.hidden = false;
}

function renderQualityOptions(options: VideoFormatOption[]) {
  elements.quality.replaceChildren(
    ...options.map((option) => {
      const item = document.createElement("option");
      item.textContent = option.label;
      item.value = option.format_selector;
      return item;
    }),
  );
  elements.quality.disabled = options.length === 0;
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
      row.querySelector(".tool-version")!.textContent = tool.version || tool.error || tool.relative_path;
      row.title = tool.full_path;
      return row;
    }),
  );
}

function updateDownloadProgress(progress: DownloadProgress) {
  if (typeof progress.percent === "number") {
    elements.progress.value = progress.percent;
  } else {
    elements.progress.removeAttribute("value");
  }

  elements.progressText.textContent = [
    progress.status,
    typeof progress.percent === "number" ? `${progress.percent.toFixed(1)}%` : null,
    progress.speed,
    progress.eta ? `${t("progress.eta")} ${progress.eta}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function updateToolInstallProgress(progress: ToolInstallProgress) {
  elements.toolInstallStatus.textContent = [
    progress.status,
    typeof progress.percent === "number" ? `${progress.percent.toFixed(0)}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  logEvent(progress.tool ? `${progress.status}: ${progress.tool}` : progress.status);
}

function setBusy(isBusy: boolean, progressText?: string, operation: "metadata" | "download" | "tools" | null = null) {
  state.busy = isBusy;
  state.activeOperation = isBusy ? operation : null;
  if (!isBusy) {
    state.cancelRequested = false;
  }
  if (progressText) {
    elements.progressText.textContent = progressText;
  }
  updateButtons();
}

function updateInstallButtonLabel() {
  elements.installTools.textContent = t(state.toolsReady ? "action.repairTools" : "action.installTools");
}

function updateButtons() {
  const hasUrl = elements.url.value.trim().length > 0;
  elements.parse.disabled = state.busy || !hasUrl || !state.toolsReady;
  elements.download.disabled = state.busy || !state.metadata || !state.selectedFormat || !state.toolsReady;
  elements.cancel.disabled = state.activeOperation !== "download" || state.cancelRequested;
  elements.refreshTools.disabled = state.busy;
  elements.installTools.disabled = state.busy;
  elements.browseFolder.disabled = state.busy;
  elements.saveFolder.disabled = state.busy;
  elements.resetFolder.disabled = state.busy;
  elements.checkUpdates.disabled = state.updateChecking;
}

function showNotice(message: string, tone: NoticeTone) {
  elements.notice.textContent = message;
  elements.notice.className = `notice is-${tone}`;
}

function renderUpdateStatus(message: string, tone: UpdateTone) {
  elements.updateStatus.textContent = message;
  elements.updateStatus.className = `update-status is-${tone}`;
}

function setUpdateStatus(key: TranslationKey, tone: UpdateTone, values: Record<string, string | number> = {}) {
  state.updateStatus = { key, values, tone };
  renderUpdateStatus(t(key, values), tone);
}

function logEvent(message: string) {
  const row = document.createElement("li");
  row.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  elements.events.prepend(row);
  while (elements.events.children.length > 8) {
    elements.events.lastElementChild?.remove();
  }
}

function formatDuration(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}
