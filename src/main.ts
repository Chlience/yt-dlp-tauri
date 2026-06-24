import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import changelogMarkdown from "../CHANGELOG.md?raw";
import packageInfo from "../package.json";
import { releaseNotesForVersion, shouldShowReleaseNotes, stripTerminalSentencePunctuation } from "./release-notes";
import { thumbnailUrlCandidates } from "./thumbnail";
import { findToolManifestAsset, summarizeTools, type ToolAction, type ToolStatus, type ToolSummaryMode } from "./toolchain";
import { type GithubAccessMode, getUpdateStatus, parseGithubHttpError, parseLatestRelease, resolveGithubUrl } from "./update-check";

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
  thumbnail_urls?: string[];
  duration_seconds?: number;
  description?: string;
  format_options: VideoFormatOption[];
};

type AppState = {
  download_directory: string;
  tools_root: string;
  cookies_file?: string | null;
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
const GITHUB_ACCESS_STORAGE_KEY = "yt-dlp-tauri-github-access-mode";
const RELEASE_NOTES_SEEN_VERSION_STORAGE_KEY = "yt-dlp-tauri-release-notes-seen-version";
const MAX_TOASTS = 4;
const TOAST_AUTO_DISMISS_MS: Record<NoticeTone, number> = {
  success: 6000,
  warning: 8000,
  error: 0,
};

const translations = {
  en: {
    "app.title": "yt-dlp-tauri",
    "app.eyebrow": "Desktop downloader",
    "app.heading": "Paste, choose, download.",
    "notifications.label": "Notifications",
    "language.label": "Language",
    "action.settings": "Settings",
    "action.close": "Close",
    "action.done": "Done",
    "action.dismissNotification": "Dismiss notification",
    "action.parse": "Parse",
    "action.download": "Download",
    "action.cancel": "Cancel",
    "action.openFolder": "Open folder",
    "action.browse": "Browse",
    "action.save": "Save",
    "action.reset": "Reset",
    "action.chooseCookies": "Choose Cookie file",
    "action.clearCookies": "Clear",
    "action.verifyTools": "Verify tools",
    "action.checkToolUpdates": "Check tool updates",
    "action.installTools": "Install tools",
    "action.updateTools": "Update tools",
    "action.reinstallTools": "Reinstall tools",
    "action.checkUpdates": "Check updates",
    "action.openRelease": "Open release",
    "action.releaseNotes": "Release notes",
    "action.projectHome": "Project home",
    "github.accessLabel": "GitHub access mode",
    "github.direct": "Direct",
    "github.proxy": "gh-proxy",
    "url.label": "Video URL",
    "url.placeholder": "https://www.youtube.com/watch?v=...",
    "cookies.label": "Cookie file",
    "cookies.none": "No cookies",
    "cookies.chooseFile": "Choose Cookie file",
    "preview.thumbnailAlt": "video thumbnail",
    "preview.emptyImage": "Preview",
    "preview.label": "Preview",
    "preview.noVideo": "No video parsed",
    "preview.emptyStart": "Paste a video URL to inspect title, cover, duration, and qualities.",
    "preview.emptyChanged": "Paste a URL and parse it before downloading.",
    "preview.cookiesChanged": "Cookie file changed. Parse again before downloading.",
    "preview.readingMetadata": "Reading metadata from yt-dlp...",
    "preview.parseFailed": "Metadata parsing failed. Check the URL and tools.",
    "preview.noDescription": "No description returned by yt-dlp.",
    "download.quality": "Quality",
    "progress.idle": "Idle",
    "progress.parsing": "Parsing video metadata...",
    "progress.metadataReady": "Metadata parsed. Choose a quality, then download.",
    "progress.metadataFailed": "Metadata parsing failed.",
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
    "notice.toolsOutdated": "Toolchain update available.",
    "notice.toolsDamaged": "Toolchain needs reinstall.",
    "notice.toolCheckFailed": "Tool check failed.",
    "notice.toolsInstalled": "Toolchain installed.",
    "notice.toolInstallNeedsAttention": "Tool install needs attention.",
    "notice.toolInstallFailed": "Tool install failed.",
    "notice.metadataParsed": "Metadata parsed.",
    "notice.downloadCompleted": "Download completed.",
    "notice.downloadCancelled": "Download cancelled.",
    "notice.folderUpdated": "Download folder updated.",
    "notice.folderReset": "Download folder reset.",
    "notice.cookiesUpdated": "Cookie file updated.",
    "notice.cookiesCleared": "Cookie file cleared.",
    "updates.checking": "Checking GitHub releases...",
    "updates.available": "New version available: {version}",
    "updates.current": "You are up to date.",
    "updates.noRelease": "No GitHub release found yet.",
    "updates.invalidRelease": "GitHub returned an unreadable release.",
    "updates.failed": "Could not check updates: {message}",
    "updates.rateLimited": "GitHub API rate limit reached. Try again after {time}, or switch GitHub access mode.",
    "updates.later": "later",
    "releaseNotes.kicker": "Updated",
    "releaseNotes.title": "What's new",
    "releaseNotes.version": "Version {version}",
    "releaseNotes.empty": "No release notes found for this version.",
    "settings.kicker": "Preferences",
    "settings.title": "Settings",
    "settings.outputFolder": "Output folder",
    "settings.resolvingFolder": "Resolving download folder...",
    "settings.toolchain": "Toolchain",
    "settings.toolchainHint": "Per-target tools are verified with SHA-256.",
    "settings.resolvingTools": "Resolving tools path...",
    "settings.installMissing": "Install missing tools automatically.",
    "settings.installingTools": "Installing missing tools...",
    "settings.updatingTools": "Updating tools to pinned versions...",
    "settings.reinstallingTools": "Reinstalling managed tools...",
    "settings.toolsPathPending": "Tools path not resolved yet",
    "settings.toolsChecking": "Checking tools...",
    "settings.toolsAvailable": "All required tools are available.",
    "settings.toolsMissing": "Missing tools can be installed automatically.",
    "settings.toolsDamaged": "Some tools are missing, damaged, or do not match the active manifest.",
    "settings.toolUpdatesChecking": "Checking the latest released tool manifest...",
    "settings.toolUpdatesAvailable": "A released toolchain update is available.",
    "settings.toolUpdatesCurrent": "Tools match the latest released manifest.",
    "settings.toolUpdatesNoManifest": "The latest release does not include a tool manifest yet.",
    "settings.toolUpdatesInvalidManifest": "The released tool manifest could not be read.",
    "settings.toolUpdatesFailed": "Tool update check failed: {message}",
    "settings.reinstallConfirm": "Reinstall managed tools at {path}? This removes the tool directory and temporary tool downloads, then downloads verified tools again.",
    "settings.toolCheckFailed": "Tool check failed.",
    "settings.toolsInstalled": "Toolchain installed.",
    "settings.toolsInstallPartial": "Install finished, but some tools still need attention.",
    "settings.toolInstallFailed": "Tool install failed.",
    "settings.activity": "Activity",
    "settings.activityHint": "Recent local events.",
    "settings.version": "Version",
    "settings.githubSite": "GitHub site",
    "settings.chooseFolder": "Choose download folder",
    "tool.currentUnknown": "unknown",
    "event.booted": "App booted.",
    "event.toolsAvailable": "yt-dlp, ffmpeg, ffprobe and deno are available.",
    "event.toolsMissing": "Tool check found missing tools.",
    "event.toolsDamaged": "Tool check found tools that need reinstall.",
    "event.toolUpdatesAvailable": "Released toolchain update found.",
    "event.toolUpdatesCurrent": "Tools match the latest released manifest.",
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
    "event.cookiesUpdated": "Cookie file selected: {file}",
    "event.cookiesCleared": "Cookie file cleared.",
  },
  zh: {
    "app.title": "yt-dlp-tauri",
    "app.eyebrow": "桌面下载器",
    "app.heading": "粘贴，选择，下载。",
    "notifications.label": "通知",
    "language.label": "语言",
    "action.settings": "设置",
    "action.close": "关闭",
    "action.done": "完成",
    "action.dismissNotification": "关闭通知",
    "action.parse": "解析",
    "action.download": "下载",
    "action.cancel": "取消",
    "action.openFolder": "打开目录",
    "action.browse": "浏览",
    "action.save": "保存",
    "action.reset": "重置",
    "action.chooseCookies": "选择 Cookie 文件",
    "action.clearCookies": "清除",
    "action.verifyTools": "验证工具",
    "action.checkToolUpdates": "检查工具更新",
    "action.installTools": "安装工具",
    "action.updateTools": "更新工具",
    "action.reinstallTools": "重新安装工具",
    "action.checkUpdates": "检查更新",
    "action.openRelease": "打开发布页",
    "action.releaseNotes": "更新说明",
    "action.projectHome": "项目主页",
    "github.accessLabel": "GitHub 访问方式",
    "github.direct": "直连",
    "github.proxy": "gh-proxy",
    "url.label": "视频链接",
    "url.placeholder": "https://www.youtube.com/watch?v=...",
    "cookies.label": "Cookie 文件",
    "cookies.none": "未使用 Cookie",
    "cookies.chooseFile": "选择 Cookie 文件",
    "preview.thumbnailAlt": "视频缩略图",
    "preview.emptyImage": "预览",
    "preview.label": "预览",
    "preview.noVideo": "尚未解析视频",
    "preview.emptyStart": "粘贴视频链接后解析，可查看标题、封面、时长和清晰度。",
    "preview.emptyChanged": "请先解析当前链接，再开始下载。",
    "preview.cookiesChanged": "Cookie 文件已变更，请重新解析后再下载。",
    "preview.readingMetadata": "正在通过 yt-dlp 读取信息...",
    "preview.parseFailed": "解析失败。请检查链接和工具链。",
    "preview.noDescription": "yt-dlp 未返回描述。",
    "download.quality": "清晰度",
    "progress.idle": "空闲",
    "progress.parsing": "正在解析视频信息...",
    "progress.metadataReady": "视频信息已解析。选择清晰度后即可下载。",
    "progress.metadataFailed": "视频信息解析失败。",
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
    "notice.toolsOutdated": "工具链有可用更新。",
    "notice.toolsDamaged": "工具链需要重新安装。",
    "notice.toolCheckFailed": "工具检查失败。",
    "notice.toolsInstalled": "工具链已安装。",
    "notice.toolInstallNeedsAttention": "工具安装需要处理。",
    "notice.toolInstallFailed": "工具安装失败。",
    "notice.metadataParsed": "视频信息已解析。",
    "notice.downloadCompleted": "下载完成。",
    "notice.downloadCancelled": "下载已取消。",
    "notice.folderUpdated": "下载目录已更新。",
    "notice.folderReset": "下载目录已重置。",
    "notice.cookiesUpdated": "Cookie 文件已更新。",
    "notice.cookiesCleared": "Cookie 文件已清除。",
    "updates.checking": "正在检查 GitHub Releases...",
    "updates.available": "发现新版本：{version}",
    "updates.current": "当前已是最新版本。",
    "updates.noRelease": "暂未找到 GitHub Release。",
    "updates.invalidRelease": "GitHub 返回的发布信息无法读取。",
    "updates.failed": "检查更新失败：{message}",
    "updates.rateLimited": "GitHub API 访问额度已用尽。请在 {time} 后重试，或切换 GitHub 访问方式。",
    "updates.later": "稍后",
    "releaseNotes.kicker": "已更新",
    "releaseNotes.title": "更新说明",
    "releaseNotes.version": "版本 {version}",
    "releaseNotes.empty": "当前版本没有更新说明。",
    "settings.kicker": "偏好",
    "settings.title": "设置",
    "settings.outputFolder": "输出目录",
    "settings.resolvingFolder": "正在解析下载目录...",
    "settings.toolchain": "工具链",
    "settings.toolchainHint": "按目标平台安装，并用 SHA-256 校验。",
    "settings.resolvingTools": "正在解析工具路径...",
    "settings.installMissing": "可自动安装缺失工具。",
    "settings.installingTools": "正在安装缺失工具...",
    "settings.updatingTools": "正在更新到固定版本...",
    "settings.reinstallingTools": "正在重新安装受管工具...",
    "settings.toolsPathPending": "工具路径尚未解析",
    "settings.toolsChecking": "正在检查工具链...",
    "settings.toolsAvailable": "所需工具均可用。",
    "settings.toolsMissing": "可自动安装缺失工具。",
    "settings.toolsDamaged": "部分工具缺失、损坏，或与当前清单不匹配。",
    "settings.toolUpdatesChecking": "正在检查最新发布的工具清单...",
    "settings.toolUpdatesAvailable": "有已发布的工具链更新。",
    "settings.toolUpdatesCurrent": "工具链与最新发布清单一致。",
    "settings.toolUpdatesNoManifest": "最新发布暂未附带工具清单。",
    "settings.toolUpdatesInvalidManifest": "发布的工具清单无法读取。",
    "settings.toolUpdatesFailed": "工具更新检查失败：{message}",
    "settings.reinstallConfirm": "重新安装 {path} 下的受管工具？这会删除工具目录和临时工具下载，然后重新下载并校验工具。",
    "settings.toolCheckFailed": "工具检查失败。",
    "settings.toolsInstalled": "工具链已安装。",
    "settings.toolsInstallPartial": "安装结束，但仍有工具需要处理。",
    "settings.toolInstallFailed": "工具安装失败。",
    "settings.activity": "活动",
    "settings.activityHint": "最近的本地事件。",
    "settings.version": "版本",
    "settings.githubSite": "GitHub 站点",
    "settings.chooseFolder": "选择下载目录",
    "tool.currentUnknown": "未知",
    "event.booted": "应用已启动。",
    "event.toolsAvailable": "yt-dlp、ffmpeg、ffprobe 和 deno 均可用。",
    "event.toolsMissing": "工具检查发现缺失项。",
    "event.toolsDamaged": "工具检查发现需要重新安装的项目。",
    "event.toolUpdatesAvailable": "发现已发布的工具链更新。",
    "event.toolUpdatesCurrent": "工具链与最新发布清单一致。",
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
    "event.cookiesUpdated": "已选择 Cookie 文件：{file}",
    "event.cookiesCleared": "Cookie 文件已清除。",
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
  toolAction: null as ToolAction | null,
  pendingToolManifestJson: null as string | null,
  updateChecking: false,
  latestReleaseUrl: "",
  updateStatus: null as { key: TranslationKey; values: Record<string, string | number>; tone: UpdateTone } | null,
  githubAccessMode: resolveInitialGithubAccessMode(),
  cookiesFile: null as string | null,
  language: resolveInitialLanguage(),
  releaseNotesOpen: false,
  thumbnailCandidates: [] as string[],
  thumbnailCandidateIndex: 0,
};

let releaseNotesReturnFocus: HTMLElement | null = null;
const toastTimers = new Map<HTMLElement, number>();

const elements = {
  url: must<HTMLInputElement>("#url"),
  parse: must<HTMLButtonElement>("#parse"),
  download: must<HTMLButtonElement>("#download"),
  cancel: must<HTMLButtonElement>("#cancel"),
  openFolder: must<HTMLButtonElement>("#open-folder"),
  chooseCookies: must<HTMLButtonElement>("#choose-cookies"),
  clearCookies: must<HTMLButtonElement>("#clear-cookies"),
  settingsToggle: must<HTMLButtonElement>("#settings-toggle"),
  settingsClose: must<HTMLButtonElement>("#settings-close"),
  settingsBackdrop: must<HTMLElement>("#settings-backdrop"),
  settingsDrawer: must<HTMLElement>("#settings-drawer"),
  languageEn: must<HTMLButtonElement>("#language-en"),
  languageZh: must<HTMLButtonElement>("#language-zh"),
  verifyTools: must<HTMLButtonElement>("#verify-tools"),
  checkToolUpdates: must<HTMLButtonElement>("#check-tool-updates"),
  installTools: must<HTMLButtonElement>("#install-tools"),
  reinstallTools: must<HTMLButtonElement>("#reinstall-tools"),
  browseFolder: must<HTMLButtonElement>("#browse-folder"),
  resetFolder: must<HTMLButtonElement>("#reset-folder"),
  saveFolder: must<HTMLButtonElement>("#save-folder"),
  checkUpdates: must<HTMLButtonElement>("#check-updates"),
  releaseLink: must<HTMLButtonElement>("#release-link"),
  releaseNotesButton: must<HTMLButtonElement>("#release-notes-button"),
  githubLink: must<HTMLButtonElement>("#github-link"),
  githubDirect: must<HTMLButtonElement>("#github-direct"),
  githubProxy: must<HTMLButtonElement>("#github-proxy"),
  releaseNotesBackdrop: must<HTMLElement>("#release-notes-backdrop"),
  releaseNotesDialog: must<HTMLElement>("#release-notes-dialog"),
  releaseNotesClose: must<HTMLButtonElement>("#release-notes-close"),
  releaseNotesDone: must<HTMLButtonElement>("#release-notes-done"),
  releaseNotesVersion: must<HTMLElement>("#release-notes-version"),
  releaseNotesList: must<HTMLElement>("#release-notes-list"),
  appVersion: must<HTMLElement>("#app-version"),
  updateStatus: must<HTMLElement>("#update-status"),
  folderInput: must<HTMLInputElement>("#folder-input"),
  folderText: must<HTMLElement>("#folder-text"),
  cookiesFile: must<HTMLElement>("#cookies-file"),
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
  toastRegion: must<HTMLElement>("#toast-region"),
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

function resolveInitialGithubAccessMode(): GithubAccessMode {
  return localStorage.getItem(GITHUB_ACCESS_STORAGE_KEY) === "gh-proxy" ? "gh-proxy" : "direct";
}

function t(key: TranslationKey, values: Record<string, string | number> = {}) {
  let text: string = translations[state.language][key] || translations.en[key] || key;
  for (const [name, value] of Object.entries(values)) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return stripTerminalSentencePunctuation(text);
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
  renderCookiesFile(state.cookiesFile);
  updateGithubAccessButtons();
  updateToolActionButton();
  if (state.releaseNotesOpen) {
    renderReleaseNotes();
  }
}

function setLanguage(language: Language) {
  state.language = language;
  localStorage.setItem("yt-dlp-tauri-language", language);
  applyTranslations();
  if (!state.metadata) {
    renderEmptyPreview(t("preview.emptyStart"));
  }
}

function setGithubAccessMode(accessMode: GithubAccessMode) {
  state.githubAccessMode = accessMode;
  localStorage.setItem(GITHUB_ACCESS_STORAGE_KEY, accessMode);
  clearUpdateStatus();
  updateGithubAccessButtons();
  updateButtons();
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

function maybeShowReleaseNotesAfterUpdate() {
  const seenVersion = localStorage.getItem(RELEASE_NOTES_SEEN_VERSION_STORAGE_KEY);
  if (!seenVersion) {
    localStorage.setItem(RELEASE_NOTES_SEEN_VERSION_STORAGE_KEY, APP_VERSION);
    return;
  }

  if (shouldShowReleaseNotes(seenVersion, APP_VERSION)) {
    showReleaseNotes();
  }
}

function showReleaseNotes() {
  releaseNotesReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  renderReleaseNotes();
  setReleaseNotesOpen(true);
}

function closeReleaseNotes() {
  localStorage.setItem(RELEASE_NOTES_SEEN_VERSION_STORAGE_KEY, APP_VERSION);
  setReleaseNotesOpen(false);
}

function setReleaseNotesOpen(isOpen: boolean) {
  state.releaseNotesOpen = isOpen;
  elements.releaseNotesDialog.hidden = !isOpen;
  elements.releaseNotesBackdrop.hidden = !isOpen;
  elements.releaseNotesDialog.setAttribute("aria-hidden", String(!isOpen));
  document.body.classList.toggle("modal-open", isOpen);

  if (isOpen) {
    elements.releaseNotesClose.focus();
    return;
  }

  releaseNotesReturnFocus?.focus();
  releaseNotesReturnFocus = null;
}

function renderReleaseNotes() {
  const notes = releaseNotesForVersion(changelogMarkdown, APP_VERSION, state.language);
  const items = notes?.items.length ? notes.items : [t("releaseNotes.empty")];

  elements.releaseNotesVersion.textContent = t("releaseNotes.version", { version: `v${APP_VERSION}` });
  elements.releaseNotesList.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("li");
      row.textContent = stripTerminalSentencePunctuation(item);
      return row;
    }),
  );
}

function bindEvents() {
  elements.parse.addEventListener("click", () => void parseCurrentUrl());
  elements.download.addEventListener("click", () => void downloadCurrentVideo());
  elements.cancel.addEventListener("click", () => void cancelCurrentDownload());
  elements.chooseCookies.addEventListener("click", () => void chooseCookiesFile());
  elements.clearCookies.addEventListener("click", () => void clearCookiesFile());
  elements.settingsToggle.addEventListener("click", () => setSettingsOpen(true));
  elements.settingsClose.addEventListener("click", () => setSettingsOpen(false));
  elements.settingsBackdrop.addEventListener("click", () => setSettingsOpen(false));
  elements.languageEn.addEventListener("click", () => setLanguage("en"));
  elements.languageZh.addEventListener("click", () => setLanguage("zh"));
  elements.verifyTools.addEventListener("click", () => void verifyTools());
  elements.checkToolUpdates.addEventListener("click", () => void checkToolUpdates());
  elements.installTools.addEventListener("click", () => void installTools());
  elements.reinstallTools.addEventListener("click", () => void reinstallTools());
  elements.openFolder.addEventListener("click", () => void openDownloadFolder());
  elements.browseFolder.addEventListener("click", () => void browseDownloadFolder());
  elements.saveFolder.addEventListener("click", () => void saveDownloadFolder());
  elements.resetFolder.addEventListener("click", () => void resetDownloadFolder());
  elements.checkUpdates.addEventListener("click", () => void checkForUpdates());
  elements.releaseLink.addEventListener("click", () => void openLatestRelease());
  elements.releaseNotesButton.addEventListener("click", () => showReleaseNotes());
  elements.githubLink.addEventListener("click", () => void openProjectRepository());
  elements.githubDirect.addEventListener("click", () => setGithubAccessMode("direct"));
  elements.githubProxy.addEventListener("click", () => setGithubAccessMode("gh-proxy"));
  elements.thumbnail.addEventListener("load", () => showLoadedThumbnail());
  elements.thumbnail.addEventListener("error", () => loadNextThumbnailCandidate());
  elements.releaseNotesClose.addEventListener("click", () => closeReleaseNotes());
  elements.releaseNotesDone.addEventListener("click", () => closeReleaseNotes());
  elements.releaseNotesBackdrop.addEventListener("click", () => closeReleaseNotes());
  elements.quality.addEventListener("change", () => {
    state.selectedFormat = state.metadata?.format_options[elements.quality.selectedIndex] ?? null;
    updateButtons();
  });
  elements.url.addEventListener("input", () => {
    if (elements.url.value.trim() !== state.lastUrl) {
      invalidateParsedVideo(t("preview.emptyChanged"));
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
    if (event.key !== "Escape") {
      return;
    }

    if (state.releaseNotesOpen) {
      closeReleaseNotes();
      return;
    }

    if (!elements.settingsDrawer.hidden) {
      setSettingsOpen(false);
      return;
    }

    const latestToast = elements.toastRegion.firstElementChild;
    if (latestToast instanceof HTMLElement) {
      dismissToast(latestToast);
    }
  });
}

async function bootstrap() {
  elements.progressText.textContent = t("progress.idle");
  renderEmptyPreview(t("preview.emptyStart"));
  logEvent(t("event.booted"));
  await loadAppState();
  maybeShowReleaseNotesAfterUpdate();
  await verifyTools({ quietReady: true });
}

async function loadAppState() {
  const appState = await invoke<AppState>("get_app_state");
  elements.folderText.textContent = appState.download_directory;
  elements.folderInput.value = appState.download_directory;
  elements.toolRoot.textContent = appState.tools_root || t("settings.toolsPathPending");
  renderCookiesFile(appState.cookies_file ?? null);
}

async function verifyTools(options: { quietReady?: boolean } = {}) {
  setBusy(true, undefined, "tools");
  state.pendingToolManifestJson = null;
  elements.toolInstallStatus.textContent = t("settings.toolsChecking");
  try {
    const tools = await invoke<ToolStatus[]>("check_tools");
    applyToolSummary(tools, "local", options);
  } catch (error) {
    state.toolsReady = false;
    state.toolAction = "install";
    const message = String(error);
    elements.toolInstallStatus.textContent = message || t("settings.toolCheckFailed");
    showNotice(message || t("settings.toolCheckFailed"), "error");
    updateToolActionButton();
  } finally {
    setBusy(false);
  }
}

async function installTools() {
  if (state.busy || !state.toolAction) {
    return;
  }

  if (state.toolAction === "reinstall") {
    await reinstallTools();
    return;
  }

  setBusy(true, undefined, "tools");
  elements.toolInstallStatus.textContent = t(toolActionStatusKey(state.toolAction));
  try {
    const tools = state.pendingToolManifestJson
      ? await invoke<ToolStatus[]>("install_tools_from_manifest", { manifestJson: state.pendingToolManifestJson })
      : await invoke<ToolStatus[]>("install_tools");
    state.pendingToolManifestJson = null;
    applyToolSummary(tools, "local");
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
  if (state.busy) {
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
    const releaseResponse = await fetch(resolveGithubUrl(LATEST_RELEASE_API_URL, state.githubAccessMode), {
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
      },
    });

    if (releaseResponse.status === 404) {
      elements.toolInstallStatus.textContent = t("updates.noRelease");
      showNotice(t("updates.noRelease"), "warning");
      return;
    }

    if (!releaseResponse.ok) {
      throw new Error((await parseGithubHttpError(releaseResponse)).message);
    }

    const releasePayload = await releaseResponse.json();
    const manifestAsset = findToolManifestAsset(releasePayload);
    if (!manifestAsset) {
      elements.toolInstallStatus.textContent = t("settings.toolUpdatesNoManifest");
      showNotice(t("settings.toolUpdatesNoManifest"), "warning");
      return;
    }

    const manifestResponse = await fetch(resolveGithubUrl(manifestAsset.downloadUrl, state.githubAccessMode), {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });

    if (!manifestResponse.ok) {
      throw new Error((await parseGithubHttpError(manifestResponse)).message);
    }

    const manifestJson = await manifestResponse.text();
    const tools = await invoke<ToolStatus[]>("check_tools_with_manifest", { manifestJson });
    const summary = applyToolSummary(tools, "remote");
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
  if (state.busy) {
    return;
  }

  const path = elements.toolRoot.textContent || t("settings.toolsPathPending");
  if (!window.confirm(t("settings.reinstallConfirm", { path }))) {
    return;
  }

  setBusy(true, undefined, "tools");
  elements.toolInstallStatus.textContent = t("settings.reinstallingTools");
  try {
    const tools = await invoke<ToolStatus[]>("reinstall_tools", { manifestJson: null });
    applyToolSummary(tools, "local");
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
    elements.progressText.textContent = t("progress.metadataReady");
    showNotice(t("notice.metadataParsed"), "success");
    logEvent(t("event.parsed", { title: metadata.title }));
  } catch (error) {
    renderEmptyPreview(t("preview.parseFailed"));
    elements.progressText.textContent = t("progress.metadataFailed");
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
    await openUrl(resolveGithubUrl(state.latestReleaseUrl || PROJECT_RELEASES_URL, state.githubAccessMode));
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
    const response = await fetch(resolveGithubUrl(LATEST_RELEASE_API_URL, state.githubAccessMode), {
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
      const githubError = await parseGithubHttpError(response);
      if (githubError.isRateLimited) {
        setUpdateStatus("updates.rateLimited", "error", { time: formatGithubRateLimitReset(githubError.rateLimitResetEpochSeconds) });
        return;
      }
      throw new Error(githubError.message);
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

async function chooseCookiesFile() {
  if (state.busy) {
    return;
  }

  try {
    const selected = await open({
      title: t("cookies.chooseFile"),
      directory: false,
      multiple: false,
      defaultPath: state.cookiesFile || undefined,
    });

    if (typeof selected === "string") {
      const appState = await invoke<AppState>("set_cookies_file", { path: selected });
      renderCookiesFile(appState.cookies_file ?? null);
      invalidateParsedVideo(t("preview.cookiesChanged"));
      showNotice(t("notice.cookiesUpdated"), "success");
      logEvent(t("event.cookiesUpdated", { file: fileNameFromPath(appState.cookies_file || selected) }));
    }
  } catch (error) {
    showNotice(String(error), "error");
  }
}

async function clearCookiesFile() {
  if (state.busy || !state.cookiesFile) {
    return;
  }

  try {
    const appState = await invoke<AppState>("clear_cookies_file");
    renderCookiesFile(appState.cookies_file ?? null);
    invalidateParsedVideo(t("preview.cookiesChanged"));
    showNotice(t("notice.cookiesCleared"), "success");
    logEvent(t("event.cookiesCleared"));
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

  renderThumbnailCandidates(thumbnailUrlCandidates(metadata));
}

function renderEmptyPreview(message: string) {
  elements.title.textContent = t("preview.noVideo");
  elements.details.textContent = message;
  elements.description.textContent = "";
  clearThumbnail();
}

function invalidateParsedVideo(message: string) {
  state.metadata = null;
  state.selectedFormat = null;
  state.lastUrl = "";
  renderEmptyPreview(message);
  renderQualityOptions([]);
}

function renderThumbnailCandidates(urls: string[]) {
  state.thumbnailCandidates = urls;
  state.thumbnailCandidateIndex = 0;

  if (urls.length === 0) {
    clearThumbnail();
    return;
  }

  loadThumbnailCandidate(0);
}

function loadThumbnailCandidate(index: number) {
  const url = state.thumbnailCandidates[index];
  if (!url) {
    clearThumbnail();
    return;
  }

  state.thumbnailCandidateIndex = index;
  elements.thumbnail.dataset.thumbnailIndex = String(index);
  elements.thumbnail.hidden = true;
  elements.thumbnailEmpty.hidden = false;
  elements.thumbnail.src = url;
}

function showLoadedThumbnail() {
  const currentIndex = Number(elements.thumbnail.dataset.thumbnailIndex ?? state.thumbnailCandidateIndex);
  if (!state.thumbnailCandidates[currentIndex]) {
    return;
  }

  elements.thumbnail.hidden = false;
  elements.thumbnailEmpty.hidden = true;
}

function loadNextThumbnailCandidate() {
  const currentIndex = Number(elements.thumbnail.dataset.thumbnailIndex ?? state.thumbnailCandidateIndex);
  const nextIndex = currentIndex + 1;
  if (nextIndex < state.thumbnailCandidates.length) {
    loadThumbnailCandidate(nextIndex);
    return;
  }

  clearThumbnail();
}

function clearThumbnail() {
  state.thumbnailCandidates = [];
  state.thumbnailCandidateIndex = 0;
  delete elements.thumbnail.dataset.thumbnailIndex;
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
      row.querySelector(".tool-version")!.textContent = formatToolVersion(tool);
      row.title = formatToolTitle(tool);
      return row;
    }),
  );
}

function applyToolSummary(tools: ToolStatus[], mode: ToolSummaryMode, options: { quietReady?: boolean } = {}) {
  const summary = summarizeTools(tools, mode);
  state.toolsReady = summary.ready;
  state.toolAction = summary.action;
  renderTools(tools);
  updateToolActionButton();
  elements.toolInstallStatus.textContent = t(summary.settingsKey);
  if (!(options.quietReady && summary.ready)) {
    showNotice(t(summary.noticeKey), summary.tone);
  }
  logEvent(t(summary.eventKey));
  return summary;
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
  if (typeof progress.percent !== "number" || progress.percent >= 100) {
    logEvent(progress.tool ? `${progress.status}: ${progress.tool}` : progress.status);
  }
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

function updateToolActionButton() {
  elements.installTools.hidden = state.toolAction === null;
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

function toolActionStatusKey(action: ToolAction | null): TranslationKey {
  if (action === "reinstall") {
    return "settings.reinstallingTools";
  }
  if (action === "update") {
    return "settings.updatingTools";
  }
  return "settings.installingTools";
}

function renderCookiesFile(file: string | null) {
  state.cookiesFile = file?.trim() || null;
  elements.cookiesFile.textContent = state.cookiesFile ? fileNameFromPath(state.cookiesFile) : t("cookies.none");
  elements.cookiesFile.title = state.cookiesFile || t("cookies.none");
  updateButtons();
}

function updateButtons() {
  const hasUrl = elements.url.value.trim().length > 0;
  elements.parse.disabled = state.busy || !hasUrl || !state.toolsReady;
  elements.download.disabled = state.busy || !state.metadata || !state.selectedFormat || !state.toolsReady;
  elements.cancel.disabled = state.activeOperation !== "download" || state.cancelRequested;
  elements.chooseCookies.disabled = state.busy;
  elements.clearCookies.disabled = state.busy || !state.cookiesFile;
  elements.verifyTools.disabled = state.busy;
  elements.checkToolUpdates.disabled = state.busy;
  elements.installTools.disabled = state.busy || !state.toolAction;
  elements.reinstallTools.disabled = state.busy;
  elements.browseFolder.disabled = state.busy;
  elements.saveFolder.disabled = state.busy;
  elements.resetFolder.disabled = state.busy;
  elements.checkUpdates.disabled = state.updateChecking;
  elements.githubDirect.disabled = state.updateChecking;
  elements.githubProxy.disabled = state.updateChecking;
}

function showNotice(message: string, tone: NoticeTone) {
  const text = stripTerminalSentencePunctuation(message.trim());
  if (!text) {
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast is-${tone}`;
  toast.setAttribute("role", tone === "error" ? "alert" : "status");

  const indicator = document.createElement("span");
  indicator.className = "toast-indicator";
  indicator.setAttribute("aria-hidden", "true");

  const copy = document.createElement("p");
  copy.className = "toast-copy";
  copy.textContent = text;

  const close = document.createElement("button");
  close.className = "toast-close";
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", t("action.dismissNotification"));
  close.addEventListener("click", () => dismissToast(toast));

  toast.addEventListener("pointerenter", () => clearToastTimer(toast));
  toast.addEventListener("pointerleave", () => maybeResumeToastTimer(toast, tone));
  toast.addEventListener("focusin", () => clearToastTimer(toast));
  toast.addEventListener("focusout", () => maybeResumeToastTimer(toast, tone));

  toast.append(indicator, copy, close);
  elements.toastRegion.prepend(toast);
  trimToastStack();
  scheduleToastDismiss(toast, tone);
}

function scheduleToastDismiss(toast: HTMLElement, tone: NoticeTone) {
  clearToastTimer(toast);
  const duration = TOAST_AUTO_DISMISS_MS[tone];
  if (duration <= 0) {
    return;
  }

  toastTimers.set(
    toast,
    window.setTimeout(() => dismissToast(toast), duration),
  );
}

function maybeResumeToastTimer(toast: HTMLElement, tone: NoticeTone) {
  if (toast.matches(":hover") || toast.contains(document.activeElement)) {
    return;
  }
  scheduleToastDismiss(toast, tone);
}

function clearToastTimer(toast: HTMLElement) {
  const timer = toastTimers.get(toast);
  if (timer) {
    window.clearTimeout(timer);
    toastTimers.delete(toast);
  }
}

function dismissToast(toast: HTMLElement) {
  if (!toast.isConnected || toast.classList.contains("is-leaving")) {
    return;
  }

  clearToastTimer(toast);
  toast.classList.add("is-leaving");
  window.setTimeout(() => toast.remove(), 180);
}

function trimToastStack() {
  while (elements.toastRegion.children.length > MAX_TOASTS) {
    const oldestToast = elements.toastRegion.lastElementChild;
    if (!(oldestToast instanceof HTMLElement)) {
      return;
    }
    clearToastTimer(oldestToast);
    oldestToast.remove();
  }
}

function renderUpdateStatus(message: string, tone: UpdateTone) {
  elements.updateStatus.textContent = message;
  elements.updateStatus.className = `update-status is-${tone}`;
}

function setUpdateStatus(key: TranslationKey, tone: UpdateTone, values: Record<string, string | number> = {}) {
  state.updateStatus = { key, values, tone };
  renderUpdateStatus(t(key, values), tone);
}

function clearUpdateStatus() {
  state.latestReleaseUrl = "";
  state.updateStatus = null;
  elements.releaseLink.hidden = true;
  renderUpdateStatus("", "neutral");
}

function updateGithubAccessButtons() {
  elements.githubDirect.classList.toggle("is-active", state.githubAccessMode === "direct");
  elements.githubProxy.classList.toggle("is-active", state.githubAccessMode === "gh-proxy");
  elements.githubDirect.setAttribute("aria-pressed", String(state.githubAccessMode === "direct"));
  elements.githubProxy.setAttribute("aria-pressed", String(state.githubAccessMode === "gh-proxy"));
}

function logEvent(message: string) {
  const row = document.createElement("li");
  row.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  elements.events.prepend(row);
  while (elements.events.children.length > 8) {
    elements.events.lastElementChild?.remove();
  }
}

function formatGithubRateLimitReset(epochSeconds?: number) {
  if (!epochSeconds) {
    return t("updates.later");
  }

  return new Intl.DateTimeFormat(state.language === "zh" ? "zh-CN" : "en", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epochSeconds * 1000));
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

function fileNameFromPath(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path;
}
