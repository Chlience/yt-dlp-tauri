import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  QueueModel,
  isFinished,
  type DownloadItem,
  type DownloadInput,
  type QueueSnapshot,
} from "./download-model";
import type { TranslationKey } from "./translations";

type Translate = (
  key: TranslationKey,
  values?: Record<string, string | number>,
) => string;
const node = <T extends HTMLElement>(id: string) =>
  document.querySelector<T>(`#${id}`)!;

export function createDownloadQueue(t: Translate, changed: () => void) {
  const model = new QueueModel();
  const list = node("queue-list");
  const rows = new Map<string, HTMLElement>();
  const pending = new Set<string>();
  const rowState = new Map<
    string,
    { key: string; status: HTMLElement; progress?: HTMLProgressElement }
  >();
  let bound = false;
  let changingOptions = false;
  let selected: string | null = null;

  function button(label: string, action: () => void, disabled = false) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "button secondary compact";
    element.textContent = label;
    element.disabled = disabled;
    element.addEventListener("click", action);
    return element;
  }

  function detail(item?: DownloadItem) {
    node("request-detail").hidden = !item;
    if (!item) return;
    const fields: [string, string][] = [
      [t("queue.requestId"), item.id],
      [t("queue.title"), item.request.title],
      [t("url.label"), item.request.url],
      [t("download.quality"), item.request.label],
      [t("download.saveTo"), item.directory],
      [t("queue.filename"), item.output_path || item.filename],
      [
        t("proxy.label"),
        item.proxy?.mode === "custom"
          ? item.proxy.url || t("proxy.custom")
          : t(item.proxy?.mode === "direct" ? "proxy.direct" : "proxy.system"),
      ],
      [
        t("cookies.label"),
        item.cookie_file
          ? `${item.cookie_file} · ${item.cookie_origin || t("queue.cookieDomains")}`
          : t("cookies.none"),
      ],
    ];
    if (item.request.playlist)
      fields.push([
        t("scope.playlist"),
        `${item.request.playlist.title} · #${item.request.playlist.index}`,
      ]);
    if (item.error) fields.push([t("queue.failed"), item.error]);
    const content = node("request-detail-content");
    content.replaceChildren(
      ...fields.map(([label, value]) => {
        const field = document.createElement("div");
        field.className = "field";
        const heading = document.createElement("span");
        heading.className = "muted";
        heading.textContent = label;
        const text = document.createElement("p");
        text.textContent = value;
        field.append(heading, text);
        return field;
      }),
    );
    if (item.status === "failed" || item.status === "cancelled") {
      const hint = document.createElement("p");
      hint.className = "field-hint";
      hint.textContent = t("queue.retryHint");
      content.append(hint);
    }
  }

  function closeDetail(restoreFocus = true) {
    if (selected === null) return false;
    const row = rows.get(selected);
    selected = null;
    detail();
    if (restoreFocus) {
      const target = row && !row.hidden
        ? row.querySelector<HTMLButtonElement>(".request-title")
        : null;
      (target ?? node("queue-filter")).focus();
    }
    return true;
  }

  function renderRow(item: DownloadItem) {
    const row = rows.get(item.id) ?? document.createElement("article");
    const filter = node<HTMLSelectElement>("queue-filter").value;
    row.hidden =
      filter !== "all" &&
      (filter === "active" ? isFinished(item.status) : item.status !== filter);
    const key = `${item.status}/${pending.has(item.id)}/${t("queue.details")}/${item.error || ""}/${item.output_path || ""}`;
    const text = [
      t(`queue.${item.status}`),
      item.status === "running" ? progressText(item) : item.error,
    ]
      .filter(Boolean)
      .join(" · ");
    const previous = rowState.get(item.id);
    if (previous?.key === key) {
      previous.status.textContent = text;
      if (previous.progress) {
        if (typeof item.progress?.percent === "number")
          previous.progress.value = item.progress.percent;
        else previous.progress.removeAttribute("value");
      }
      return;
    }
    row.className = `request-row is-${item.status}`;
    row.dataset.requestId = item.id;
    const copy = document.createElement("div");
    copy.className = "request-copy";
    const title = document.createElement("button");
    title.type = "button";
    title.className = "request-title";
    title.textContent = item.request.title;
    title.addEventListener("click", () => {
      selected = item.id;
      detail(model.snapshot.requests.find((request) => request.id === item.id));
      node("request-detail-close").focus();
    });
    const subtitle = document.createElement("p");
    subtitle.className = "muted";
    subtitle.textContent = [
      item.request.playlist
        ? `${item.request.playlist.title} · #${item.request.playlist.index}`
        : item.id,
      item.request.label,
    ].join(" · ");
    const status = document.createElement("p");
    status.className = "request-status";
    status.textContent = text;
    let meter: HTMLProgressElement | undefined;
    copy.append(title, subtitle, status);
    if (item.status === "running") {
      const progress = document.createElement("progress");
      meter = progress;
      progress.max = 100;
      if (typeof item.progress?.percent === "number")
        progress.value = item.progress.percent;
      progress.setAttribute(
        "aria-label",
        `${item.request.title}: ${t("queue.running")}`,
      );
      copy.append(progress);
    }
    const actions = document.createElement("div");
    actions.className = "request-actions";
    const blocked = pending.has(item.id);
    if (!isFinished(item.status))
      actions.append(
        button(
          t("action.cancel"),
          () => void command("cancel_request", { id: item.id }, item.id),
          blocked || item.status === "cancelling",
        ),
      );
    if (item.status === "failed" || item.status === "cancelled")
      actions.append(
        button(
          t("queue.retry"),
          () => void command("retry_request", { id: item.id }, item.id),
          blocked,
        ),
      );
    if (item.status === "completed") {
      if (item.output_path)
        actions.append(
          button(t("queue.openFile"), () => void openOutput(item.id, false)),
        );
      actions.append(
        button(t("action.openFolder"), () => void openOutput(item.id, true)),
      );
    }
    row.replaceChildren(copy, actions);
    if (!rows.has(item.id)) {
      rows.set(item.id, row);
      list.append(row);
    }
    rowState.set(item.id, { key, status, progress: meter });
  }

  function progressText(item: DownloadItem) {
    const progress = item.progress;
    if (!progress) return "";
    return [
      typeof progress.percent === "number"
        ? `${progress.percent.toFixed(1)}%`
        : null,
      progress.speed,
      progress.eta ? `${t("progress.eta")} ${progress.eta}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function render() {
    const snapshot = model.snapshot;
    for (const [id, row] of rows) {
      if (!snapshot.requests.some((item) => item.id === id)) {
        row.remove();
        rows.delete(id);
        rowState.delete(id);
      }
    }
    snapshot.requests.forEach(renderRow);
    const active = snapshot.requests.filter(
      (item) => !isFinished(item.status),
    ).length;
    node("queue-count").textContent = String(active);
    node("queue-count").hidden = active === 0;
    const summary = t("queue.summary", {
      total: snapshot.requests.length,
      active,
      completed: snapshot.requests.filter((item) => item.status === "completed")
        .length,
      failed: snapshot.requests.filter((item) => item.status === "failed")
        .length,
    });
    node("queue-summary").textContent = summary;
    node("app-queue-status").textContent = summary;
    node<HTMLSelectElement>("queue-concurrency").value = String(
      snapshot.concurrency,
    );
    node<HTMLSelectElement>("default-concurrency").value = String(
      snapshot.concurrency,
    );
    node("queue-pause").textContent = t(
      snapshot.paused ? "queue.resume" : "queue.stopStarting",
    );
    node("queue-paused-message").hidden = !snapshot.paused;
    for (const id of ["queue-concurrency", "default-concurrency", "queue-pause"]) {
      node<HTMLButtonElement | HTMLSelectElement>(id).disabled = changingOptions;
    }
    node("queue-empty").hidden = snapshot.requests.length !== 0;
    node<HTMLButtonElement>("queue-clear").disabled = !snapshot.requests.some(
      (item) => isFinished(item.status),
    );
    const filter = node<HTMLSelectElement>("queue-filter").value;
    const noMatches =
      snapshot.requests.length > 0 &&
      !snapshot.requests.some(
        (item) =>
          filter === "all" ||
          (filter === "active"
            ? !isFinished(item.status)
            : item.status === filter),
      );
    node("queue-no-results").hidden = !noMatches;
    node("queue-content").hidden = noMatches;
    const selectedItem = snapshot.requests.find((item) => item.id === selected);
    if (selected !== null && !selectedItem) {
      closeDetail(node("request-detail").contains(document.activeElement));
    } else {
      detail(selectedItem);
    }
    changed();
  }

  function apply(snapshot: QueueSnapshot) {
    if (model.apply(snapshot)) render();
  }
  function error(value: unknown) {
    node("queue-error").hidden = false;
    node("queue-error").textContent = String(value);
  }
  async function command(
    name: string,
    args: Record<string, unknown> = {},
    id?: string,
  ) {
    const optionsChange = name === "set_queue_options";
    if (optionsChange && changingOptions) return;
    if (id && pending.has(id)) return;
    if (optionsChange) changingOptions = true;
    if (id) pending.add(id);
    node("queue-error").hidden = true;
    render();
    try {
      apply(await invoke<QueueSnapshot>(name, args));
    } catch (value) {
      error(value);
    } finally {
      if (id) pending.delete(id);
      if (optionsChange) changingOptions = false;
      render();
    }
  }
  async function openOutput(id: string, folder: boolean) {
    try {
      await invoke("open_request_output", { id, folder });
    } catch (value) {
      error(value);
    }
  }

  return {
    get unfinished() {
      return model.unfinished;
    },
    render,
    closeDetail,
    async enqueue(requests: DownloadInput[]) {
      apply(await invoke<QueueSnapshot>("enqueue_downloads", { requests }));
    },
    async initialize() {
      if (!bound) {
        await listen<QueueSnapshot>("queue-changed", (event) =>
          apply(event.payload),
        );
        await listen<DownloadItem>("request-progress", (event) => {
          if (model.progress(event.payload)) {
            renderRow(event.payload);
            if (event.payload.id === selected) detail(event.payload);
          }
        });
        await listen("confirm-close", async () => {
          if (window.confirm(t("queue.confirmClose"))) {
            try {
              await invoke("close_application");
            } catch (value) {
              error(value);
            }
          }
        });
        node("queue-filter").addEventListener("change", render);
        node("queue-clear").addEventListener(
          "click",
          () => void command("clear_finished_requests"),
        );
        node("request-detail-close").addEventListener("click", () => closeDetail());
        node("queue-pause").addEventListener(
          "click",
          () =>
            void command("set_queue_options", {
              concurrency: model.snapshot.concurrency,
              paused: !model.snapshot.paused,
            }),
        );
        for (const id of ["queue-concurrency", "default-concurrency"]) {
          node(id).addEventListener(
            "change",
            () =>
              void command("set_queue_options", {
                concurrency: Number(node<HTMLSelectElement>(id).value),
                paused: model.snapshot.paused,
              }),
          );
        }
        bound = true;
      }
      apply(await invoke<QueueSnapshot>("get_download_queue"));
    },
  };
}
