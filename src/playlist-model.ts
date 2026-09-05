export type PlaylistItem = {
  index: number;
  id?: string;
  title: string;
  filename?: string;
  url?: string;
  thumbnail_url?: string;
  duration_seconds?: number;
  unavailable_reason?: string;
};
export type PlaylistPage = {
  title: string;
  directory_name: string;
  entries: PlaylistItem[];
  total?: number;
  next_start?: number;
  error?: string;
};

export function selectable(item: PlaylistItem) {
  return Boolean(item.url) && !item.unavailable_reason;
}

export function selectRange(
  value: string,
  entries: PlaylistItem[],
): Set<number> | null {
  if (!value.trim()) return new Set();
  const result = new Set<number>();
  const available = new Map(entries.map((item) => [item.index, item]));
  for (const token of value.split(/[,，]/)) {
    const match = token.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) return null;
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first < 1 ||
      last < first ||
      last - first >= entries.length
    )
      return null;
    for (let index = first; index <= last; index++) {
      const item = available.get(index);
      if (!item) return null;
      if (selectable(item)) result.add(index);
    }
  }
  return result;
}

export function linkScope(value: string): "choice" | "playlist" | "video" {
  try {
    const url = new URL(value);
    if (url.searchParams.has("list"))
      return url.searchParams.has("v") || url.hostname === "youtu.be"
        ? "choice"
        : "playlist";
    if (
      /bilibili\.com$/.test(url.hostname) &&
      (/\/(medialist|lists|favlist|space)\b/.test(url.pathname) ||
        url.searchParams.has("sid"))
    )
      return "playlist";
    if (/bilibili\.com$/.test(url.hostname) && /\/video\//.test(url.pathname))
      return "choice";
  } catch {
    /* Backend reports invalid URLs. */
  }
  return "video";
}

export function mergeEntries(
  previous: PlaylistItem[],
  incoming: PlaylistItem[],
) {
  const items = new Map(previous.map((item) => [item.index, item]));
  incoming.forEach((item) => items.set(item.index, item));
  return [...items.values()].sort((a, b) => a.index - b.index);
}

export const playlistQualities = [
  {
    label: "Best",
    format_selector: "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
  },
  ...[2160, 1440, 1080, 720, 480].map((height) => ({
    label: `≤ ${height}p`,
    format_selector: `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/b[height<=${height}][ext=mp4]/bv*[height<=${height}]+ba/b[height<=${height}]`,
  })),
];
