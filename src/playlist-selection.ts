import { invoke } from "@tauri-apps/api/core";
import {
  mergeEntries,
  selectRange,
  selectable,
  type PlaylistItem,
  type PlaylistPage,
} from "./playlist-model";
import type { TranslationKey } from "./translations";

type Translate = (
  key: TranslationKey,
  values?: Record<string, string | number>,
) => string;
const node = <T extends HTMLElement>(id: string) =>
  document.querySelector<T>(`#${id}`)!;
const PAGE_SIZE = 50;

export function createPlaylistSelection(options: {
  t: Translate;
  busy: (value: boolean) => void;
  changed: () => void;
  currentUrl: () => string;
}) {
  let url = "";
  let title = "";
  let directory = "";
  let entries: PlaylistItem[] = [];
  let selected = new Set<number>();
  let total: number | undefined;
  let next: number | undefined;
  let page = 0;
  let loading = false;
  let message = "";
  let generation = 0;
  const { t } = options;

  function render() {
    node("playlist-title").textContent = title || t("scope.playlist");
    node("playlist-summary").textContent = t(
      total ? "playlist.countKnown" : "playlist.countUnknown",
      { loaded: entries.length, total: total ?? 0, selected: selected.size },
    );
    node("playlist-list").replaceChildren(
      ...entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item) => {
        const row = document.createElement("label");
        row.className = `playlist-row${selectable(item) ? "" : " is-unavailable"}`;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(item.index);
        checkbox.disabled = !selectable(item);
        checkbox.setAttribute("aria-label", `#${item.index} ${item.title}`);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.add(item.index);
          else selected.delete(item.index);
          // Keep focus on this checkbox while updating the selection summary.
          node("playlist-summary").textContent = t(
            total ? "playlist.countKnown" : "playlist.countUnknown",
            {
              loaded: entries.length,
              total: total ?? 0,
              selected: selected.size,
            },
          );
          options.changed();
        });
        const number = document.createElement("span");
        number.className = "playlist-number";
        number.textContent = String(item.index).padStart(2, "0");
        const copy = document.createElement("div");
        copy.className = "playlist-copy";
        const heading = document.createElement("strong");
        heading.textContent = item.title;
        const details = document.createElement("span");
        details.className = "muted";
        details.textContent =
          item.unavailable_reason ||
          (item.duration_seconds != null
            ? `${Math.floor(item.duration_seconds / 60)}:${String(Math.round(item.duration_seconds % 60)).padStart(2, "0")}`
            : t("playlist.durationUnknown"));
        copy.append(heading, details);
        row.append(checkbox, number, copy);
        return row;
      }),
    );
    node("playlist-page-label").textContent = t("playlist.page", {
      page: page + 1,
      pages: Math.max(1, Math.ceil(entries.length / PAGE_SIZE)),
    });
    node<HTMLButtonElement>("playlist-previous").disabled = page === 0;
    node<HTMLButtonElement>("playlist-next").disabled =
      (page + 1) * PAGE_SIZE >= entries.length;
    node<HTMLButtonElement>("playlist-load-more").disabled = loading;
    node("playlist-load-more").hidden = next == null;
    node("playlist-message").hidden = !message && !loading;
    node("playlist-message").textContent = loading
      ? t("playlist.loading")
      : message;
    node<HTMLButtonElement>("select-all").disabled = entries.length === 0;
    node<HTMLButtonElement>("invert-selection").disabled = entries.length === 0;
  }

  function selectionChanged() {
    node("selection-error").hidden = true;
    render();
    options.changed();
  }
  async function load(start: number, token: number) {
    if (loading) return;
    loading = true;
    message = "";
    options.busy(true);
    render();
    try {
      const result = await invoke<PlaylistPage>("parse_playlist_page", {
        url,
        start,
      });
      if (generation !== token || options.currentUrl() !== url) return;
      title = result.title || title;
      directory = result.directory_name || directory;
      entries = mergeEntries(entries, result.entries);
      for (const index of selected)
        if (!entries.some((item) => item.index === index && selectable(item)))
          selected.delete(index);
      total = result.total ?? total;
      next = result.next_start ?? undefined;
      message = result.error
        ? t("playlist.partialError", { message: result.error })
        : entries.length === 0
          ? t("playlist.noItems")
          : "";
    } catch (error) {
      if (generation !== token || options.currentUrl() !== url) return;
      next = start;
      message = t("playlist.partialError", { message: String(error) });
    } finally {
      loading = false;
      options.busy(false);
      render();
      options.changed();
    }
  }

  node("select-all").addEventListener("click", () => {
    selected = new Set(entries.filter(selectable).map((item) => item.index));
    selectionChanged();
  });
  node("invert-selection").addEventListener("click", () => {
    selected = new Set(
      entries
        .filter((item) => selectable(item) && !selected.has(item.index))
        .map((item) => item.index),
    );
    selectionChanged();
  });
  node("apply-range").addEventListener("click", () => {
    const result = selectRange(
      node<HTMLInputElement>("playlist-range").value,
      entries,
    );
    if (!result) {
      node("selection-error").hidden = false;
      node("selection-error").textContent = t("playlist.invalidRange");
      return;
    }
    selected = result;
    selectionChanged();
  });
  node("playlist-previous").addEventListener("click", () => {
    if (page > 0) page--;
    render();
  });
  node("playlist-next").addEventListener("click", () => {
    if ((page + 1) * PAGE_SIZE < entries.length) page++;
    render();
  });
  node("playlist-load-more").addEventListener("click", () => {
    if (next != null) void load(next, generation);
  });

  return {
    get active() {
      return Boolean(url);
    },
    get title() {
      return title;
    },
    get directory() {
      return directory;
    },
    get url() {
      return url;
    },
    get selected() {
      return entries.filter(
        (item) => selected.has(item.index) && selectable(item),
      );
    },
    render,
    reset() {
      generation++;
      url = "";
      title = "";
      directory = "";
      entries = [];
      selected.clear();
      total = undefined;
      next = undefined;
      page = 0;
      message = "";
      node("selection-error").hidden = true;
    },
    async parse(value: string) {
      this.reset();
      url = value;
      next = 1;
      options.changed();
      await load(1, generation);
    },
  };
}
