import assert from "node:assert/strict";
import test from "node:test";

import {
  canaryCommand,
  emptyCanaryState,
  issuesToUpdate,
  nextCanaryState,
  redactCanaryText,
  runCanaryChecks,
  validateCanaryConfig,
} from "../scripts/toolchain/canary.mjs";

test("Canary opens one issue action after three matching failures", () => {
  let state = emptyCanaryState();
  for (let count = 0; count < 3; count += 1) {
    state = nextCanaryState(
      state,
      [{ id: "youtube-public", ok: false, failureClass: "metadata" }],
      `2026-07-0${count + 1}T05:53:00Z`,
    );
  }

  assert.deepEqual(issuesToUpdate(state), [
    {
      id: "youtube-public",
      action: "open",
      failureClass: "metadata",
      count: 3,
    },
  ]);
});

test("a successful observation resets the counter", () => {
  const state = nextCanaryState(
    {
      entries: {
        "youtube-public": { count: 2, failureClass: "metadata" },
      },
    },
    [{ id: "youtube-public", ok: true }],
    "2026-07-03T05:53:00Z",
  );

  assert.equal(state.entries["youtube-public"].count, 0);
  assert.equal(state.entries["youtube-public"].recoveryAtUtc, "2026-07-03T05:53:00Z");
});

test("a different failure class starts a new consecutive sequence", () => {
  const state = nextCanaryState(
    {
      entries: {
        "youtube-public": {
          id: "youtube-public",
          operation: "metadata",
          count: 4,
          failureClass: "rate-limit",
          firstFailureAtUtc: "2026-07-01T05:53:00Z",
          lastFailureAtUtc: "2026-07-04T05:53:00Z",
          recoveryAtUtc: null,
        },
      },
    },
    [{ id: "youtube-public", operation: "metadata", ok: false, failureClass: "metadata" }],
    "2026-07-05T05:53:00Z",
  );

  assert.equal(state.entries["youtube-public"].count, 1);
  assert.equal(state.entries["youtube-public"].failureClass, "metadata");
  assert.equal(state.entries["youtube-public"].firstFailureAtUtc, "2026-07-05T05:53:00Z");
});

test("environmental Canary outcomes do not accumulate actionable failures", () => {
  let state = emptyCanaryState();
  for (let count = 0; count < 4; count += 1) {
    state = nextCanaryState(
      state,
      [
        {
          id: "youtube-public",
          operation: "metadata",
          ok: false,
          failureClass: "authentication",
        },
      ],
      `2026-07-0${count + 1}T05:53:00Z`,
    );
  }

  assert.equal(state.entries["youtube-public"].count, 0);
  assert.equal(state.entries["youtube-public"].alerted, false);
  assert.deepEqual(issuesToUpdate(state), []);
});

test("an environmental outcome closes a prior actionable alert", () => {
  const state = nextCanaryState(
    {
      entries: {
        "youtube-public": {
          id: "youtube-public",
          operation: "metadata",
          count: 5,
          failureClass: "metadata",
          alerted: true,
        },
      },
    },
    [
      {
        id: "youtube-public",
        operation: "metadata",
        ok: false,
        failureClass: "authentication",
      },
    ],
    "2026-07-06T05:53:00Z",
  );

  assert.deepEqual(issuesToUpdate(state), [
    {
      id: "youtube-public",
      action: "close",
      failureClass: "metadata",
      count: 0,
      resolution: "environmental",
      currentFailureClass: "authentication",
    },
  ]);
});

test("a new actionable failure class updates an existing site alert", () => {
  const state = nextCanaryState(
    {
      entries: {
        "youtube-public": {
          id: "youtube-public",
          operation: "metadata",
          count: 5,
          failureClass: "metadata",
          alerted: true,
        },
      },
    },
    [
      {
        id: "youtube-public",
        operation: "metadata",
        ok: false,
        failureClass: "target-unavailable",
      },
    ],
    "2026-07-06T05:53:00Z",
  );

  assert.deepEqual(issuesToUpdate(state), [
    {
      id: "youtube-public",
      action: "update",
      failureClass: "target-unavailable",
      count: 1,
    },
  ]);
});

test("only the first recovery emits a close action", () => {
  let state = emptyCanaryState();
  for (let count = 0; count < 3; count += 1) {
    state = nextCanaryState(
      state,
      [{ id: "vimeo-public", operation: "simulate", ok: false, failureClass: "simulate" }],
      `2026-07-0${count + 1}T05:53:00Z`,
    );
  }
  state = nextCanaryState(
    state,
    [{ id: "vimeo-public", operation: "simulate", ok: true }],
    "2026-07-04T05:53:00Z",
  );
  assert.equal(issuesToUpdate(state)[0].action, "close");

  state = nextCanaryState(
    state,
    [{ id: "vimeo-public", operation: "simulate", ok: true }],
    "2026-07-05T05:53:00Z",
  );
  assert.deepEqual(issuesToUpdate(state), []);
});

test("Canary text redacts credentials, query strings, and local paths", () => {
  const redacted = redactCanaryText(
    "Authorization: Bearer secret\nCookie: SID=secret\nhttps://example.test/watch?id=secret C:\\Users\\runner\\cookies.txt /home/runner/cookies.txt",
  );

  assert.doesNotMatch(redacted, /secret|SID=|id=/u);
  assert.doesNotMatch(redacted, /C:\\Users|\/home\/runner/u);
  assert.match(redacted, /\[REDACTED\]/u);
});

test("Canary config allows only reviewed public HTTPS URLs", () => {
  assert.doesNotThrow(() =>
    validateCanaryConfig({
      schemaVersion: 1,
      sites: [
        {
          id: "youtube-public",
          operation: "metadata",
          url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        },
      ],
    }),
  );
  assert.throws(
    () =>
      validateCanaryConfig({
        schemaVersion: 1,
        sites: [
          {
            id: "private",
            operation: "metadata",
            url: "http://127.0.0.1/video",
          },
        ],
      }),
    /public HTTPS/u,
  );
});

test("Canary command pins candidate Deno and FFmpeg without cookies", () => {
  const command = canaryCommand(
    {
      id: "youtube-public",
      operation: "metadata",
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    },
    {
      ytDlp: "/tools/yt-dlp",
      deno: "/tools/deno",
      ffmpegDir: "/tools/ffmpeg/bin",
    },
  );

  assert.ok(command.args.includes("deno:/tools/deno"));
  assert.ok(command.args.includes("/tools/ffmpeg/bin"));
  assert.ok(command.args.includes("--dump-single-json"));
  assert.doesNotMatch(command.args.join(" "), /cookie|authorization/iu);
});

test("Canary observations classify 412 and redact query credentials", async () => {
  const observations = await runCanaryChecks(
    {
      schemaVersion: 1,
      sites: [
        {
          id: "youtube-public",
          operation: "metadata",
          url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        },
      ],
    },
    {
      denoBinary: "/tools/deno",
      ffmpegDirectory: "/tools/ffmpeg/bin",
      tools: [{ name: "yt-dlp", full_path: "/tools/yt-dlp" }],
    },
    async () => {
      throw new Error(
        "HTTP Error 412: Precondition Failed https://example.test/watch?token=secret",
      );
    },
  );

  assert.equal(observations[0].failureClass, "precondition");
  assert.doesNotMatch(observations[0].summary, /token|secret/u);
});

test("Canary observations distinguish an unavailable target from extractor failures", async () => {
  const observations = await runCanaryChecks(
    {
      schemaVersion: 1,
      sites: [
        {
          id: "youtube-public",
          operation: "metadata",
          url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        },
      ],
    },
    {
      denoBinary: "/tools/deno",
      ffmpegDirectory: "/tools/ffmpeg/bin",
      tools: [{ name: "yt-dlp", full_path: "/tools/yt-dlp" }],
    },
    async () => {
      throw new Error("ERROR: [youtube] example: Video unavailable");
    },
  );

  assert.equal(observations[0].failureClass, "target-unavailable");
});
