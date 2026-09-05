import { createDownloadQueue } from "./download-queue";
import { createPlaylistSelection } from "./playlist-selection";
import { linkScope, playlistQualities } from "./playlist-model";
import type { DownloadInput } from "./download-model";
import { createNavigation } from "./navigation";
import {
  translations,
  type Language,
  type TranslationKey,
} from "./translations";
import type {
  AppState,
  LocalToolchainConfig,
  LocalToolchainPaths,
  ToolchainSource,
} from "./app-state";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import changelogMarkdown from "../CHANGELOG.md?raw";
import packageInfo from "../package.json";
import {
  releaseNotesForVersion,
  shouldShowReleaseNotes,
  stripTerminalSentencePunctuation,
} from "./release-notes";
import { thumbnailUrlCandidates } from "./thumbnail";
import { type ToolAction } from "./toolchain";
import {
  createToolchainSettings,
  type ToolInstallProgress,
} from "./toolchain-settings";
import {
  type GithubAccessMode,
  getUpdateStatus,
  parseGithubHttpError,
  parseLatestRelease,
  resolveGithubUrl,
} from "./update-check";

type VideoFormatOption = {
  label: string;
  format_selector: string;
  height?: number;
  extension: string;
  is_best: boolean;
};

type VideoMetadata = {
  title: string;
  is_playlist?: boolean;
  id?: string;
  webpage_url: string;
  thumbnail_url?: string;
  thumbnail_urls?: string[];
  duration_seconds?: number;
  description?: string;
  format_options: VideoFormatOption[];
};

const APP_VERSION = packageInfo.version;
const PROJECT_REPOSITORY_URL = "https://github.com/Chlience/yt-dlp-tauri";
const PROJECT_RELEASES_URL = `${PROJECT_REPOSITORY_URL}/releases`;
const LATEST_RELEASE_API_URL =
  "https://api.github.com/repos/Chlience/yt-dlp-tauri/releases/latest";
const GITHUB_ACCESS_STORAGE_KEY = "yt-dlp-tauri-github-access-mode";
const RELEASE_NOTES_SEEN_VERSION_STORAGE_KEY =
  "yt-dlp-tauri-release-notes-seen-version";
const MAX_TOASTS = 4;
const TOAST_AUTO_DISMISS_MS: Record<NoticeTone, number> = {
  success: 6000,
  warning: 8000,
  error: 0,
};

type NoticeTone = "success" | "warning" | "error";
type UpdateTone = "neutral" | "success" | "warning" | "error";

const state = {
  initialized: false,
  metadata: null as VideoMetadata | null,
  selectedFormat: null as VideoFormatOption | null,
  busy: false,
  activeOperation: null as "metadata" | "tools" | null,
  cancelRequested: false,
  lastUrl: "",
  toolsReady: false,
  toolAction: null as ToolAction | null,
  toolchainRevision: null as string | null,
  toolchainSource: "managed" as ToolchainSource,
  localToolchain: {
    schemaVersion: 1,
    ytDlpPath: null,
    ffmpegDirectory: null,
    denoPath: null,
  } as LocalToolchainConfig,
  localToolchainPaths: {
    ytDlpPath: null,
    ffmpegDirectory: null,
    denoPath: null,
  } as LocalToolchainPaths,
  pendingToolManifestJson: null as string | null,
  updateChecking: false,
  latestReleaseUrl: "",
  updateStatus: null as {
    key: TranslationKey;
    values: Record<string, string | number>;
    tone: UpdateTone;
  } | null,
  githubAccessMode: resolveInitialGithubAccessMode(),
  cookiesFile: null as string | null,
  cookiesOrigin: null as string | null,
  language: resolveInitialLanguage(),
  releaseNotesOpen: false,
  thumbnailCandidates: [] as string[],
  thumbnailCandidateIndex: 0,
};

let releaseNotesReturnFocus: HTMLElement | null = null;
const toastTimers = new Map<HTMLElement, number>();

const elements = {
  retryStartup: must<HTMLButtonElement>("#retry-startup"),
  url: must<HTMLInputElement>("#url"),
  parse: must<HTMLButtonElement>("#parse"),
  download: must<HTMLButtonElement>("#download"),
  cancel: must<HTMLButtonElement>("#cancel"),
  openFolder: must<HTMLButtonElement>("#open-folder"),
  chooseCookies: must<HTMLButtonElement>("#choose-cookies"),
  clearCookies: must<HTMLButtonElement>("#clear-cookies"),
  settingsToggle: must<HTMLButtonElement>("#settings-toggle"),
  settingsClose: must<HTMLButtonElement>("#settings-close"),
  appShell: must<HTMLElement>("#app-shell"),
  newView: must<HTMLElement>("#new-view"),
  workspace: must<HTMLElement>("#download-workspace"),
  operationStatus: must<HTMLElement>("#operation-status"),
  toolsRequired: must<HTMLElement>("#tools-required"),
  emptyHints: must<HTMLElement>("#empty-hints"),
  homeDirectory: must<HTMLElement>("#home-directory"),
  directoryPreview: must<HTMLElement>("#download-directory-preview"),
  appToolStatus: must<HTMLElement>("#app-tool-status"),
  languageEn: must<HTMLButtonElement>("#language-en"),
  languageZh: must<HTMLButtonElement>("#language-zh"),
  verifyTools: must<HTMLButtonElement>("#verify-tools"),
  toolSourceManaged: must<HTMLButtonElement>("#tool-source-managed"),
  toolSourceLocal: must<HTMLButtonElement>("#tool-source-local"),
  managedToolchainDetails: must<HTMLElement>("#managed-toolchain-details"),
  localToolchainPaths: must<HTMLElement>("#local-toolchain-paths"),
  localYtDlpPath: must<HTMLElement>("#local-yt-dlp-path"),
  localFfmpegPath: must<HTMLElement>("#local-ffmpeg-path"),
  localDenoPath: must<HTMLElement>("#local-deno-path"),
  chooseLocalYtDlp: must<HTMLButtonElement>("#choose-local-yt-dlp"),
  chooseLocalFfmpeg: must<HTMLButtonElement>("#choose-local-ffmpeg"),
  chooseLocalDeno: must<HTMLButtonElement>("#choose-local-deno"),
  autoDetectLocalTools: must<HTMLButtonElement>("#auto-detect-local-tools"),
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
  toolchainHint: must<HTMLElement>("#toolchain-hint"),
  toolchainRevision: must<HTMLElement>("#toolchain-revision"),
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

const navigation = createNavigation();
const queue = createDownloadQueue(t, updateButtons);
const playlist = createPlaylistSelection({
  t,
  busy: (value) =>
    setBusy(
      value,
      value ? t("playlist.loading") : t("progress.idle"),
      "metadata",
    ),
  changed: () => {
    updateDownloadOptions();
    updateButtons();
  },
  currentUrl: () => elements.url.value.trim(),
});
let queueInitialized = false;
let enqueueing = false;
let showingScope = false;

const {
  setToolchainSource,
  chooseLocalTool,
  autoDetectLocalTools,
  verifyTools,
  installTools,
  checkToolUpdates,
  reinstallTools,
  renderToolchainRevision,
  renderToolchainSource,
  renderLocalToolchainPaths,
  updateToolActionButton,
  updateToolInstallProgress,
} = createToolchainSettings({
  state,
  elements,
  t,
  setBusy,
  applyAppState,
  loadAppState,
  invalidateParsedVideo,
  showNotice,
  logEvent,
});

window.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  applyTranslations();
  listen<ToolInstallProgress>("tool-install-progress", (event) =>
    updateToolInstallProgress(event.payload),
  );
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

  document
    .querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement
    >("[data-i18n-placeholder]")
    .forEach((element) => {
      const key = element.dataset.i18nPlaceholder as TranslationKey | undefined;
      if (key) {
        element.placeholder = t(key);
      }
    });

  document
    .querySelectorAll<HTMLElement>("[data-i18n-aria-label]")
    .forEach((element) => {
      const key = element.dataset.i18nAriaLabel as TranslationKey | undefined;
      if (key) {
        element.setAttribute("aria-label", t(key));
      }
    });

  document
    .querySelectorAll<HTMLImageElement>("[data-i18n-alt]")
    .forEach((element) => {
      const key = element.dataset.i18nAlt as TranslationKey | undefined;
      if (key) {
        element.alt = t(key);
      }
    });

  elements.languageEn.classList.toggle("is-active", state.language === "en");
  elements.languageZh.classList.toggle("is-active", state.language === "zh");
  elements.languageEn.setAttribute(
    "aria-pressed",
    String(state.language === "en"),
  );
  elements.languageZh.setAttribute(
    "aria-pressed",
    String(state.language === "zh"),
  );
  elements.appVersion.textContent = APP_VERSION;
  if (state.updateStatus) {
    renderUpdateStatus(
      t(state.updateStatus.key, state.updateStatus.values),
      state.updateStatus.tone,
    );
  }
  renderCookiesFile(state.cookiesFile, state.cookiesOrigin);
  renderToolchainRevision();
  renderToolchainSource();
  renderLocalToolchainPaths();
  updateGithubAccessButtons();
  updateToolActionButton();
  if (state.releaseNotesOpen) {
    renderReleaseNotes();
  }
  queue.render();
  playlist.render();
  updateDownloadOptions();
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
  elements.appShell.inert = isOpen;

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
  elements.retryStartup.addEventListener("click", () => void bootstrap());
  elements.parse.addEventListener("click", () => void parseCurrentUrl());
  elements.download.addEventListener(
    "click",
    () => void enqueueCurrentSelection(),
  );
  must("#scope-video").addEventListener(
    "click",
    () => void parseCurrentUrl("video"),
  );
  must("#scope-playlist").addEventListener(
    "click",
    () => void parseCurrentUrl("playlist"),
  );
  must("#media-mode").addEventListener("change", () => {
    updateDownloadOptions(true);
    updateButtons();
  });
  elements.cancel.addEventListener(
    "click",
    () => void cancelCurrentOperation(),
  );
  elements.chooseCookies.addEventListener(
    "click",
    () => void chooseCookiesFile(),
  );
  elements.clearCookies.addEventListener(
    "click",
    () => void clearCookiesFile(),
  );
  elements.languageEn.addEventListener("click", () => setLanguage("en"));
  elements.languageZh.addEventListener("click", () => setLanguage("zh"));
  elements.toolSourceManaged.addEventListener(
    "click",
    () => void setToolchainSource("managed"),
  );
  elements.toolSourceLocal.addEventListener(
    "click",
    () => void setToolchainSource("local"),
  );
  elements.chooseLocalYtDlp.addEventListener(
    "click",
    () => void chooseLocalTool("yt-dlp"),
  );
  elements.chooseLocalFfmpeg.addEventListener(
    "click",
    () => void chooseLocalTool("ffmpeg"),
  );
  elements.chooseLocalDeno.addEventListener(
    "click",
    () => void chooseLocalTool("deno"),
  );
  elements.autoDetectLocalTools.addEventListener(
    "click",
    () => void autoDetectLocalTools(),
  );
  elements.verifyTools.addEventListener("click", () => void verifyTools());
  elements.checkToolUpdates.addEventListener(
    "click",
    () => void checkToolUpdates(),
  );
  elements.installTools.addEventListener("click", () => void installTools());
  elements.reinstallTools.addEventListener(
    "click",
    () => void reinstallTools(),
  );
  elements.openFolder.addEventListener(
    "click",
    () => void openDownloadFolder(),
  );
  elements.browseFolder.addEventListener(
    "click",
    () => void browseDownloadFolder(),
  );
  elements.saveFolder.addEventListener(
    "click",
    () => void saveDownloadFolder(),
  );
  elements.resetFolder.addEventListener(
    "click",
    () => void resetDownloadFolder(),
  );
  elements.checkUpdates.addEventListener("click", () => void checkForUpdates());
  elements.releaseLink.addEventListener(
    "click",
    () => void openLatestRelease(),
  );
  elements.releaseNotesButton.addEventListener("click", () =>
    showReleaseNotes(),
  );
  elements.githubLink.addEventListener(
    "click",
    () => void openProjectRepository(),
  );
  elements.githubDirect.addEventListener("click", () =>
    setGithubAccessMode("direct"),
  );
  elements.githubProxy.addEventListener("click", () =>
    setGithubAccessMode("gh-proxy"),
  );
  elements.thumbnail.addEventListener("load", () => showLoadedThumbnail());
  elements.thumbnail.addEventListener("error", () =>
    loadNextThumbnailCandidate(),
  );
  elements.releaseNotesClose.addEventListener("click", () =>
    closeReleaseNotes(),
  );
  elements.releaseNotesDone.addEventListener("click", () =>
    closeReleaseNotes(),
  );
  elements.releaseNotesBackdrop.addEventListener("click", () =>
    closeReleaseNotes(),
  );
  elements.quality.addEventListener("change", () => {
    state.selectedFormat =
      state.metadata?.format_options[elements.quality.selectedIndex] ?? null;
    updateDownloadOptions();
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
    if (event.key === "Tab" && state.releaseNotesOpen) {
      const buttons = [elements.releaseNotesClose, elements.releaseNotesDone];
      if (event.shiftKey && document.activeElement === buttons[0]) {
        event.preventDefault();
        buttons[1].focus();
      } else if (!event.shiftKey && document.activeElement === buttons[1]) {
        event.preventDefault();
        buttons[0].focus();
      }
      return;
    }
    if (event.key !== "Escape") {
      return;
    }

    if (state.releaseNotesOpen) {
      closeReleaseNotes();
      return;
    }

    if (navigation.current() === "settings") {
      navigation.back();
      return;
    }

    if (navigation.current() === "queue" && queue.closeDetail()) {
      event.preventDefault();
      return;
    }

    const latestToast = Array.from(elements.toastRegion.children).find(
      (toast) => !toast.classList.contains("is-leaving"),
    );
    if (latestToast instanceof HTMLElement) {
      dismissToast(latestToast);
    }
  });
}

async function bootstrap() {
  if (state.busy) {
    return;
  }
  setBusy(true);
  elements.retryStartup.hidden = true;
  elements.progressText.textContent = t("progress.idle");
  renderEmptyPreview(t("preview.emptyStart"));
  logEvent(t("event.booted"));
  try {
    await loadAppState();
    if (!queueInitialized) {
      await queue.initialize();
      queueInitialized = true;
    }
    maybeShowReleaseNotesAfterUpdate();
    state.initialized = true;
  } catch (error) {
    state.initialized = false;
    state.toolsReady = false;
    const message = t("notice.startupFailed", { message: String(error) });
    elements.progressText.textContent = message;
    elements.retryStartup.hidden = false;
    showNotice(message, "error");
    logEvent(message);
    return;
  } finally {
    setBusy(false);
  }
  await verifyTools({ quietReady: true });
}

async function loadAppState() {
  const appState = await invoke<AppState>("get_app_state");
  applyAppState(appState);
}

function applyAppState(appState: AppState) {
  elements.folderText.textContent = appState.download_directory;
  elements.folderInput.value = appState.download_directory;
  elements.homeDirectory.textContent = appState.download_directory;
  elements.directoryPreview.textContent = appState.download_directory;
  elements.toolRoot.textContent =
    appState.tools_root || t("settings.toolsPathPending");
  state.toolchainRevision = appState.toolchain_revision ?? null;
  state.toolchainSource = appState.toolchain_source;
  state.localToolchain = appState.local_toolchain;
  state.localToolchainPaths = appState.local_toolchain_paths;
  renderToolchainRevision();
  renderToolchainSource();
  renderLocalToolchainPaths();
  renderCookiesFile(
    appState.cookies_file ?? null,
    appState.cookies_origin ?? null,
  );
}

async function parseCurrentUrl(scope?: "video" | "playlist") {
  const url = elements.url.value.trim();
  if (!url || state.busy || !state.initialized || !state.toolsReady) {
    return;
  }

  const inferred = scope ?? linkScope(url);
  if (inferred === "choice") {
    invalidateParsedVideo(t("preview.emptyStart"));
    showingScope = true;
    must<HTMLElement>("#scope-chooser").hidden = false;
    updateButtons();
    return;
  }
  showingScope = false;
  must<HTMLElement>("#scope-chooser").hidden = true;
  if (inferred === "playlist") {
    invalidateParsedVideo(t("preview.readingMetadata"));
    state.lastUrl = url;
    updateDownloadOptions(true);
    await playlist.parse(url);
    return;
  }

  setBusy(true, t("progress.parsing"), "metadata");
  invalidateParsedVideo(t("preview.readingMetadata"));
  try {
    const metadata = await invoke<VideoMetadata>("parse_metadata", { url });
    if (elements.url.value.trim() !== url) {
      elements.progressText.textContent = t("progress.idle");
      return;
    }
    if (state.cancelRequested) throw "Operation cancelled.";
    if (metadata.is_playlist) {
      if (scope === "video") throw new Error(t("scope.videoUnavailable"));
      state.lastUrl = url;
      await playlist.parse(url);
      return;
    }
    state.metadata = metadata;
    state.lastUrl = url;
    state.selectedFormat = metadata.format_options[0] ?? null;
    renderMetadata(metadata);
    updateDownloadOptions(true);
    elements.progressText.textContent = t("progress.metadataReady");
    showNotice(t("notice.metadataParsed"), "success");
    logEvent(t("event.parsed", { title: metadata.title }));
  } catch (error) {
    if (elements.url.value.trim() !== url) {
      elements.progressText.textContent = t("progress.idle");
      return;
    }
    if (error === "Operation cancelled.") {
      invalidateParsedVideo(t("progress.metadataCancelled"));
      elements.progressText.textContent = t("progress.metadataCancelled");
      showNotice(t("notice.metadataCancelled"), "warning");
      logEvent(t("event.metadataCancelled"));
      return;
    }
    invalidateParsedVideo(t("preview.parseFailed"));
    elements.progressText.textContent = t("progress.metadataFailed");
    showNotice(String(error), "error");
    logEvent(t("event.metadataFailed"));
  } finally {
    setBusy(false);
  }
}

async function enqueueCurrentSelection() {
  if (state.busy || enqueueing || !state.toolsReady) return;
  const audio = must<HTMLSelectElement>("#media-mode").value === "audio";
  const format = audio
    ? { format_selector: "ba/b", label: t("download.audioOnly") }
    : playlist.active
      ? playlistQualities[elements.quality.selectedIndex]
      : state.selectedFormat;
  if (!format) return;
  const label =
    playlist.active && !audio && elements.quality.selectedIndex === 0
      ? t("download.best")
      : format.label;
  const common = {
    format_selector: format.format_selector,
    label,
    audio_only: audio,
  };
  const requests: DownloadInput[] = playlist.active
    ? playlist.selected.map((item) => ({
        ...common,
        url: item.url!,
        title: item.title,
        video_id: item.id,
        thumbnail_url: item.thumbnail_url,
        playlist: {
          url: playlist.url,
          title: playlist.title,
          index: item.index,
        },
      }))
    : state.metadata
      ? [
          {
            ...common,
            url: state.metadata.webpage_url || state.lastUrl,
            title: state.metadata.title,
            video_id: state.metadata.id,
            thumbnail_url: state.metadata.thumbnail_url,
          },
        ]
      : [];
  if (!requests.length) return;
  enqueueing = true;
  updateButtons();
  try {
    await queue.enqueue(requests);
    navigation.show("queue");
    showNotice(t("download.added", { count: requests.length }), "success");
  } catch (error) {
    showNotice(String(error), "error");
  } finally {
    enqueueing = false;
    updateButtons();
  }
}

function updateDownloadOptions(resetQuality = false) {
  const audio = must<HTMLSelectElement>("#media-mode").value === "audio";
  if (resetQuality || (playlist.active && !elements.quality.children.length)) {
    const options = audio
      ? [
          {
            label: t("download.audioOnly"),
            format_selector: "ba/b",
            extension: "",
            is_best: true,
          },
        ]
      : playlist.active
        ? playlistQualities.map((format, index) => ({
            ...format,
            label: index === 0 ? t("download.best") : format.label,
            extension: "mp4",
            is_best: index === 0,
          }))
        : (state.metadata?.format_options ?? []);
    renderQualityOptions(options);
    if (!playlist.active && !audio) state.selectedFormat = options[0] ?? null;
  }
  const firstOption = elements.quality.children[0];
  if (firstOption && audio) firstOption.textContent = t("download.audioOnly");
  else if (firstOption && playlist.active)
    firstOption.textContent = t("download.best");
  must<HTMLElement>("#preview-panel").hidden = playlist.active;
  must<HTMLElement>("#playlist-panel").hidden = !playlist.active;
  must<HTMLElement>("#quality-hint").textContent = audio
    ? t("download.audioHint")
    : playlist.active
      ? t("playlist.qualityHint")
      : "";
  const count = playlist.active
    ? playlist.selected.length
    : state.metadata
      ? 1
      : 0;
  must<HTMLElement>("#selected-summary").textContent = t("download.selected", {
    count,
  });
  const root = elements.folderText.textContent || "";
  elements.directoryPreview.textContent =
    playlist.active && playlist.directory
      ? `${root}${root.includes("\\") ? "\\" : "/"}${playlist.directory}`
      : root;
  must<HTMLElement>("#filename-section").hidden = !playlist.active;
  must<HTMLElement>("#filename-preview").replaceChildren(
    ...playlist.selected.slice(0, 3).map((item) => {
      const line = document.createElement("p");
      line.textContent = `${item.filename || `${String(item.index).padStart(2, "0")} - ${item.title}`}.…`;
      line.title = line.textContent;
      return line;
    }),
  );
}

async function cancelCurrentOperation() {
  if (state.activeOperation !== "metadata" || state.cancelRequested) {
    return;
  }

  state.cancelRequested = true;
  elements.progressText.textContent = t("progress.cancelling");
  updateButtons();
  try {
    await invoke("cancel_metadata");
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
    const appState = await invoke<AppState>("set_download_directory", {
      directory: elements.folderInput.value,
    });
    elements.folderText.textContent = appState.download_directory;
    elements.folderInput.value = appState.download_directory;
    elements.homeDirectory.textContent = appState.download_directory;
    updateDownloadOptions();
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
    elements.homeDirectory.textContent = appState.download_directory;
    updateDownloadOptions();
    showNotice(t("notice.folderReset"), "success");
  } catch (error) {
    showNotice(String(error), "error");
  }
}

async function chooseCookiesFile() {
  if (state.busy) {
    return;
  }

  const url = elements.url.value.trim();
  setBusy(true);
  try {
    const selected = await open({
      title: t("cookies.chooseFile"),
      directory: false,
      multiple: false,
      defaultPath: state.cookiesFile || undefined,
    });

    if (typeof selected === "string") {
      const appState = await invoke<AppState>("set_cookies_file", { path: selected, url });
      renderCookiesFile(appState.cookies_file ?? null, appState.cookies_origin ?? null);
      invalidateParsedVideo(t("preview.cookiesChanged"));
      showNotice(t("notice.cookiesUpdated"), "success");
      logEvent(t("event.cookiesUpdated", { file: fileNameFromPath(appState.cookies_file || selected) }));
    }
  } catch (error) {
    showNotice(String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function clearCookiesFile() {
  if (state.busy || !state.cookiesFile) {
    return;
  }

  setBusy(true);
  try {
    const appState = await invoke<AppState>("clear_cookies_file");
    renderCookiesFile(appState.cookies_file ?? null);
    invalidateParsedVideo(t("preview.cookiesChanged"));
    showNotice(t("notice.cookiesCleared"), "success");
    logEvent(t("event.cookiesCleared"));
  } catch (error) {
    showNotice(String(error), "error");
  } finally {
    setBusy(false);
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
  playlist.reset();
  showingScope = false;
  must<HTMLElement>("#scope-chooser").hidden = true;
  state.metadata = null;
  state.selectedFormat = null;
  state.lastUrl = "";
  renderEmptyPreview(message);
  renderQualityOptions([]);
  updateButtons();
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

function setBusy(
  isBusy: boolean,
  progressText?: string,
  operation: "metadata" | "tools" | null = null,
) {
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

function renderCookiesFile(file: string | null, origin: string | null = null) {
  state.cookiesFile = file?.trim() || null;
  state.cookiesOrigin = origin;
  elements.cookiesFile.textContent = state.cookiesFile
    ? [fileNameFromPath(state.cookiesFile), origin].filter(Boolean).join(" · ")
    : t("cookies.none");
  elements.cookiesFile.title = state.cookiesFile
    ? [state.cookiesFile, origin].filter(Boolean).join("\n")
    : t("cookies.none");
  updateButtons();
}

function updateButtons() {
  const hasContent = Boolean(state.metadata) || playlist.active;
  elements.workspace.hidden = !hasContent;
  elements.newView.classList.toggle("has-content", hasContent);
  elements.newView.classList.toggle("has-scope", showingScope);
  elements.emptyHints.hidden = hasContent || state.busy || showingScope;
  elements.toolsRequired.hidden =
    !state.initialized || state.toolsReady || state.activeOperation === "tools";
  elements.appToolStatus.textContent = t(
    state.toolsReady ? "settings.toolsAvailable" : "settings.toolsMissing",
  );
  elements.operationStatus.hidden =
    !state.busy &&
    elements.retryStartup.hidden &&
    Boolean(
      hasContent ||
        !elements.progressText.textContent ||
        elements.progressText.textContent === t("progress.idle"),
    );
  elements.progress.hidden = true;
  elements.cancel.hidden = state.activeOperation !== "metadata";
  const configurationUnavailable = state.busy || !state.initialized;
  const hasUrl = elements.url.value.trim().length > 0;
  elements.retryStartup.disabled = state.busy;
  elements.parse.disabled =
    configurationUnavailable || !hasUrl || !state.toolsReady;
  elements.download.disabled =
    configurationUnavailable ||
    enqueueing ||
    !state.toolsReady ||
    (playlist.active
      ? playlist.selected.length === 0
      : !state.metadata ||
        (!state.selectedFormat &&
          must<HTMLSelectElement>("#media-mode").value !== "audio"));
  elements.quality.disabled =
    configurationUnavailable ||
    !hasContent ||
    must<HTMLSelectElement>("#media-mode").value === "audio";
  must<HTMLSelectElement>("#media-mode").disabled = configurationUnavailable;
  const toolsUnavailable = configurationUnavailable || queue.unfinished;
  must<HTMLElement>("#queue-tool-lock").hidden = !queue.unfinished;
  elements.cancel.disabled =
    state.activeOperation !== "metadata" || state.cancelRequested;
  elements.chooseCookies.disabled = configurationUnavailable;
  elements.clearCookies.disabled =
    configurationUnavailable || !state.cookiesFile;
  elements.toolSourceManaged.disabled = toolsUnavailable;
  elements.toolSourceLocal.disabled = toolsUnavailable;
  elements.chooseLocalYtDlp.disabled =
    toolsUnavailable || state.toolchainSource !== "local";
  elements.chooseLocalFfmpeg.disabled =
    toolsUnavailable || state.toolchainSource !== "local";
  elements.chooseLocalDeno.disabled =
    toolsUnavailable || state.toolchainSource !== "local";
  elements.autoDetectLocalTools.disabled =
    toolsUnavailable || state.toolchainSource !== "local";
  elements.verifyTools.disabled = configurationUnavailable;
  elements.checkToolUpdates.disabled =
    configurationUnavailable || state.toolchainSource !== "managed";
  elements.installTools.disabled = toolsUnavailable || !state.toolAction;
  elements.reinstallTools.disabled =
    toolsUnavailable || state.toolchainSource !== "managed";
  elements.openFolder.disabled = configurationUnavailable;
  elements.browseFolder.disabled = configurationUnavailable;
  elements.saveFolder.disabled = configurationUnavailable;
  elements.resetFolder.disabled = configurationUnavailable;
  elements.checkUpdates.disabled = state.updateChecking;
  elements.githubDirect.disabled = state.updateChecking;
  elements.githubProxy.disabled = state.updateChecking;
  for (const id of ["scope-video", "scope-playlist"])
    must<HTMLButtonElement>(`#${id}`).disabled =
      configurationUnavailable || !state.toolsReady;
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
  elements.toastRegion.scrollTop = 0;
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
