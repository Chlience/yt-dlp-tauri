import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import * as releaseNotes from "../../src/release-notes.ts";
import * as thumbnail from "../../src/thumbnail.ts";
import * as toolchain from "../../src/toolchain.ts";
import * as updateCheck from "../../src/update-check.ts";

// Exercise the application through DOM events and IPC, without exporting its state for tests.
class Element {
  value = "";
  textContent = "";
  disabled = false;
  hidden = false;
  selectedIndex = 0;
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
    toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name),
  };

  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get isConnected() { return this.parent !== null; }
  set innerHTML(html: string) {
    this.replaceChildren(...Array.from(html.matchAll(/<span class="([^"]+)"/gu), match => {
      const child = new Element();
      child.className = match[1];
      return child;
    }));
  }
  querySelector(selector: string) {
    return this.children.find(child => child.className.split(" ").includes(selector.slice(1))) ?? null;
  }
  addEventListener(name: string, callback: (event: unknown) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  dispatch(name: string, event: unknown = {}) {
    for (const callback of this.listeners.get(name) ?? []) callback(event);
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(...children: Element[]) {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  prepend(child: Element) { child.parent = this; this.children.unshift(child); }
  replaceChildren(...children: Element[]) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  focus() {}
}

export const healthyTools = ["yt-dlp", "ffmpeg", "ffprobe", "deno"].map(name => ({
  name, availability: "available", version: "1", expected_version: "1", full_path: `/tools/${name}`,
}));

export const video = {
  title: "Video A",
  webpage_url: "https://video.example/a",
  format_options: [{ label: "Best MP4", format_selector: "b", extension: "mp4", is_best: true }],
};

type Handler = (args: any) => unknown;
export async function createApp(handlers: Record<string, Handler> = {}) {
  const nodes = new Map<string, Element>();
  for (const match of readFileSync("index.html", "utf8").matchAll(/\bid="([^"]+)"/gu)) {
    nodes.set(`#${match[1]}`, new Element());
  }
  const defaults: Record<string, Handler> = {
    get_app_state: () => ({
      download_directory: "/downloads", tools_root: "/tools", toolchain_revision: "20260711.1",
      toolchain_source: "managed", local_toolchain: { schemaVersion: 1 }, local_toolchain_paths: {}, cookies_file: null,
    }),
    check_tools: () => healthyTools,
    parse_metadata: () => video,
    download_video: () => "/downloads/video.mp4",
  };
  const calls: { command: string; args: any }[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const modules: Record<string, unknown> = {
    "@tauri-apps/api/core": { invoke: async (command: string, args: unknown) => {
      calls.push({ command, args });
      const handler = handlers[command] ?? defaults[command];
      if (!handler) throw new Error(`Unexpected command: ${command}`);
      return handler(args);
    } },
    "@tauri-apps/api/event": { listen: async () => () => {} },
    "@tauri-apps/plugin-dialog": { open: async () => handlers.open?.({}) ?? null },
    "@tauri-apps/plugin-opener": { openUrl: async () => {} },
    "../CHANGELOG.md?raw": readFileSync("CHANGELOG.md", "utf8"),
    "../package.json": JSON.parse(readFileSync("package.json", "utf8")),
    "./release-notes": releaseNotes,
    "./thumbnail": thumbnail,
    "./toolchain": toolchain,
    "./update-check": updateCheck,
  };
  const context = createContext({
    exports: {},
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
      return modules[name];
    },
    document: {
      querySelector: (selector: string) => nodes.get(selector) ?? null,
      querySelectorAll: () => [],
      createElement: () => new Element(),
      documentElement: {}, body: new Element(), activeElement: null,
    },
    window: {
      addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
      setTimeout: () => 1, clearTimeout() {}, confirm: () => true,
    },
    HTMLElement: Element,
    navigator: { language: "en" },
    localStorage: { getItem: () => null, setItem() {} },
  });
  const script = ts.transpileModule(readFileSync("src/main.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  runInContext(script, context, { filename: "main.js" });
  listeners.get("DOMContentLoaded")!({});
  await flush();
  return {
    calls,
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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
