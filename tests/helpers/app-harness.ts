import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

// Exercise the application through DOM events and IPC, without exporting its state for tests.
class Element {
  private readonly onFocus: (element: Element) => void;
  constructor(onFocus: (element: Element) => void = () => {}) {
    this.onFocus = onFocus;
  }

  value = "";
  textContent = "";
  disabled = false;
  hidden = false;
  selectedIndex = 0;
  checked = false;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  parent: Element | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: unknown) => void)[]>();
  classes = new Set<string>();
  className = "";
  classList = {
    add: (name: string) => this.classes.add(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, enabled: boolean) =>
      enabled ? this.classes.add(name) : this.classes.delete(name),
  };

  get firstElementChild() {
    return this.children[0] ?? null;
  }
  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }
  get isConnected() {
    return this.parent !== null;
  }
  set innerHTML(html: string) {
    this.replaceChildren(
      ...Array.from(html.matchAll(/<span class="([^"]+)"/gu), (match) => {
        const child = new Element();
        child.className = match[1];
        return child;
      }),
    );
  }
  querySelector(selector: string): Element | null {
    for (const child of this.children) {
      if (child.className.split(" ").includes(selector.slice(1))) return child;
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }
  contains(element: Element | null): boolean {
    return this === element || this.children.some((child) => child.contains(element));
  }
  addEventListener(name: string, callback: (event: unknown) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  dispatch(name: string, event: unknown = {}) {
    for (const callback of this.listeners.get(name) ?? []) callback(event);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  append(...children: Element[]) {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  prepend(child: Element) {
    child.parent = this;
    this.children.unshift(child);
  }
  replaceChildren(...children: Element[]) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
    this.parent = null;
  }
  focus() {
    this.onFocus(this);
  }
}

export const healthyTools = ["yt-dlp", "ffmpeg", "ffprobe", "deno"].map(
  (name) => ({
    name,
    availability: "available",
    version: "1",
    expected_version: "1",
    full_path: `/tools/${name}`,
  }),
);

export const video = {
  title: "Video A",
  webpage_url: "https://video.example/a",
  format_options: [
    {
      label: "Best MP4",
      format_selector: "b",
      extension: "mp4",
      is_best: true,
    },
  ],
};

export const managedAppState = {
  download_directory: "/downloads",
  tools_root: "/tools",
  toolchain_revision: "20260711.1",
  toolchain_source: "managed",
  local_toolchain: { schemaVersion: 1 },
  local_toolchain_paths: {},
  cookies_file: null,
};

type Handler = (args: any) => unknown;
export async function createApp(handlers: Record<string, Handler> = {}) {
  let activeElement: Element | null = null;
  const createElement = () => new Element((element) => { activeElement = element; });
  const nodes = new Map<string, Element>();
  for (const match of readFileSync("index.html", "utf8").matchAll(
    /\bid="([^"]+)"/gu,
  )) {
    nodes.set(`#${match[1]}`, createElement());
  }
  let queue = {
    revision: 0,
    concurrency: 1,
    paused: false,
    requests: [] as any[],
  };
  const defaults: Record<string, Handler> = {
    get_app_state: () => managedAppState,
    check_tools: () => healthyTools,
    parse_metadata: () => video,
    get_download_queue: () => structuredClone(queue),
    enqueue_downloads: ({ requests }) => {
      queue = {
        ...queue,
        revision: queue.revision + 1,
        requests: [
          ...queue.requests,
          ...requests.map((request: any, index: number) => ({
            id: `request-${queue.requests.length + index + 1}`,
            revision: queue.revision + 1,
            request,
            status: "waiting",
            directory: "/downloads",
            filename: request.title,
          })),
        ],
      };
      return structuredClone(queue);
    },
  };
  const calls: { command: string; args: any }[] = [];
  nodes.get("#queue-filter")!.value = "all";
  nodes.get("#media-mode")!.value = "video";
  const ipcEvents = new Map<string, (event: unknown) => void>();
  const listeners = new Map<string, (event: unknown) => void>();
  const modules: Record<string, unknown> = {
    "@tauri-apps/api/core": {
      invoke: async (command: string, args: unknown) => {
        const payload = structuredClone(args);
        calls.push({ command, args: payload });
        const handler = handlers[command] ?? defaults[command];
        if (!handler) throw new Error(`Unexpected command: ${command}`);
        return handler(payload);
      },
    },
    "@tauri-apps/api/event": {
      listen: async (name: string, callback: (event: unknown) => void) => {
        ipcEvents.set(name, callback);
        return () => ipcEvents.delete(name);
      },
    },
    "@tauri-apps/plugin-dialog": {
      open: async () => handlers.open?.({}) ?? null,
    },
    "@tauri-apps/plugin-opener": { openUrl: async () => {} },
    "../CHANGELOG.md?raw": readFileSync("CHANGELOG.md", "utf8"),
    "../package.json": JSON.parse(readFileSync("package.json", "utf8")),
  };
  const context = createContext({
    URL,
    document: {
      querySelector: (selector: string) => nodes.get(selector) ?? null,
      querySelectorAll: () => [],
      createElement,
      documentElement: {},
      body: createElement(),
      get activeElement() { return activeElement; },
    },
    window: {
      addEventListener: (name: string, callback: (event: unknown) => void) =>
        listeners.set(name, callback),
      setTimeout: () => 1,
      clearTimeout() {},
      confirm: () => true,
    },
    HTMLElement: Element,
    navigator: { language: "en" },
    localStorage: { getItem: () => null, setItem() {} },
  });
  const loaded = new Map<string, { exports: unknown }>();
  function loadModule(file: string): unknown {
    const cached = loaded.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} };
    loaded.set(file, module);
    const script = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;
    const execute = runInContext(
      `(function(require, module, exports) {\n${script}\n})`,
      context,
      { filename: file },
    );
    execute(
      (name: string) => {
        if (name in modules) return modules[name];
        if (name.startsWith("./"))
          return loadModule(resolve(dirname(file), `${name}.ts`));
        throw new Error(`Unexpected module: ${name}`);
      },
      module,
      module.exports,
    );
    return module.exports;
  }
  loadModule(resolve("src/main.ts"));
  listeners.get("DOMContentLoaded")!({});
  await flush();
  return {
    calls,
    get focused() { return activeElement; },
    async key(key: string) {
      listeners.get("keydown")?.({ key, preventDefault() {} });
      await flush();
    },
    emit(name: string, payload: unknown) {
      ipcEvents.get(name)?.({ payload });
    },
    el(id: string) {
      const node = nodes.get(`#${id}`);
      if (!node) throw new Error(`Unknown element: ${id}`);
      return node;
    },
    async click(id: string) {
      const node = this.el(id);
      if (!node.disabled) node.dispatch("click");
      await flush();
    },
    input(url: string) {
      this.el("url").value = url;
      this.el("url").dispatch("input");
    },
  };
}

export function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
