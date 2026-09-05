export type Page = "new" | "queue" | "settings";
export type SettingsPage = "general" | "tools" | "about";

export function createNavigation() {
  let page: Page = "new";
  let previousPage: Page = "new";
  const element = (id: string) =>
    document.querySelector<HTMLElement>(`#${id}`)!;

  function show(next: Page) {
    if (next === "settings" && page !== "settings") previousPage = page;
    page = next;
    for (const name of ["new", "queue", "settings"] as const) {
      element(`${name}-view`).hidden = name !== next;
      const button = element(
        name === "settings" ? "settings-toggle" : `nav-${name}`,
      );
      button.classList.toggle("is-active", name === next);
      if (name === next) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  }

  function settings(next: SettingsPage) {
    show("settings");
    for (const name of ["general", "tools", "about"] as const) {
      element(`settings-${name}`).hidden = name !== next;
      element(`settings-nav-${name}`).classList.toggle(
        "is-active",
        name === next,
      );
      element(`settings-nav-${name}`).setAttribute(
        "aria-current",
        name === next ? "page" : "false",
      );
    }
  }

  for (const id of ["nav-new", "queue-new", "queue-empty-new"]) {
    element(id).addEventListener("click", () => show("new"));
  }
  element("nav-queue").addEventListener("click", () => show("queue"));
  element("settings-toggle").addEventListener("click", () =>
    settings("general"),
  );
  element("settings-close").addEventListener("click", () => show(previousPage));
  element("prepare-tools").addEventListener("click", () => settings("tools"));
  for (const name of ["general", "tools", "about"] as const) {
    element(`settings-nav-${name}`).addEventListener("click", () =>
      settings(name),
    );
  }
  for (const id of ["home-change-folder", "download-change-folder"]) {
    element(id).addEventListener("click", () => settings("general"));
  }
  return {
    show,
    settings,
    current: () => page,
    back: () => show(previousPage),
  };
}
