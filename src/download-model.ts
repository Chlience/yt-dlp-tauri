import type { ProxyConfig } from "./app-state";

export type DownloadInput = {
  url: string;
  title: string;
  video_id?: string;
  thumbnail_url?: string;
  format_selector: string;
  label: string;
  audio_only: boolean;
  playlist?: { url: string; title: string; index: number };
};

export type RequestStatus =
  | "waiting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";
export type DownloadItem = {
  id: string;
  revision: number;
  request: DownloadInput;
  status: RequestStatus;
  directory: string;
  filename: string;
  cookie_origin?: string;
  cookie_file?: string;
  proxy?: ProxyConfig;
  progress?: { percent?: number; status: string; speed?: string; eta?: string };
  output_path?: string;
  error?: string;
};
export type QueueSnapshot = {
  revision: number;
  concurrency: number;
  paused: boolean;
  requests: DownloadItem[];
};

export function isFinished(status: RequestStatus) {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

// IPC replies and events can arrive in either order. Keep newer per-request progress
// when applying a snapshot, and ignore events for records already cleared by it.
export class QueueModel {
  snapshot: QueueSnapshot = {
    revision: -1,
    concurrency: 1,
    paused: false,
    requests: [],
  };
  private pending = new Map<string, DownloadItem>();

  apply(snapshot: QueueSnapshot): boolean {
    if (snapshot.revision <= this.snapshot.revision) return false;
    const known = new Map([
      ...this.snapshot.requests.map((item) => [item.id, item] as const),
      ...this.pending,
    ]);
    this.snapshot = {
      ...snapshot,
      requests: snapshot.requests.map((item) => {
        const newer = known.get(item.id);
        return newer && newer.revision > item.revision ? newer : item;
      }),
    };
    for (const [id, item] of this.pending) {
      if (
        item.revision <= snapshot.revision ||
        snapshot.requests.some((request) => request.id === id)
      )
        this.pending.delete(id);
    }
    return true;
  }

  progress(item: DownloadItem): boolean {
    const index = this.snapshot.requests.findIndex(
      (request) => request.id === item.id,
    );
    if (index < 0) {
      if (
        item.revision > this.snapshot.revision &&
        item.revision > (this.pending.get(item.id)?.revision ?? -1)
      )
        this.pending.set(item.id, item);
      return false;
    }
    if (item.revision <= this.snapshot.requests[index].revision) return false;
    this.snapshot.requests[index] = item;
    return true;
  }

  get unfinished() {
    return this.snapshot.requests.some((item) => !isFinished(item.status));
  }
}
