import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { selectBackend, __test__ } from "../../src/backends/select.ts";
import { __test__ as diag } from "../../src/diagnostics/diagnostics.ts";

const SAVED_KEYS = [
  "PI_SUBAGENT_MODE",
  "CMUX_SOCKET_PATH",
  "TMUX",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "WEZTERM_UNIX_SOCKET",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of SAVED_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("selectBackend", () => {
  let snap: Record<string, string | undefined>;
  let origStderrWrite: typeof process.stderr.write;
  let stderrCapture: string;

  beforeEach(() => {
    snap = snapshotEnv();
    for (const k of SAVED_KEYS) delete process.env[k];
    __test__.resetWarnedValues();
    __test__.restoreDetectMux();
    stderrCapture = "";
    origStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string | Buffer) => {
      stderrCapture += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
  });

  afterEach(() => {
    (process.stderr as any).write = origStderrWrite;
    __test__.restoreDetectMux();
    restoreEnv(snap);
  });

  it("returns 'pane' when PI_SUBAGENT_MODE=pane (even without mux)", () => {
    process.env.PI_SUBAGENT_MODE = "pane";
    assert.equal(selectBackend(), "pane");
  });

  it("returns 'headless' when PI_SUBAGENT_MODE=headless (even with mux present)", () => {
    process.env.PI_SUBAGENT_MODE = "headless";
    process.env.TMUX = "/tmp/tmux-fake";
    assert.equal(selectBackend(), "headless");
  });

  it("is case-insensitive on PI_SUBAGENT_MODE", () => {
    process.env.PI_SUBAGENT_MODE = "HEADLESS";
    assert.equal(selectBackend(), "headless");
    process.env.PI_SUBAGENT_MODE = "Pane";
    assert.equal(selectBackend(), "pane");
  });

  it("warns once to stderr on invalid value then falls back to auto", () => {
    process.env.PI_SUBAGENT_MODE = "bogus";
    selectBackend();
    selectBackend(); // second call — should NOT re-warn
    const hits = stderrCapture.match(/invalid PI_SUBAGENT_MODE="bogus"/g) ?? [];
    assert.equal(hits.length, 1, `expected exactly one warn, got ${hits.length}`);
  });

  it("auto mode returns 'headless' when no mux env vars are set", () => {
    // PI_SUBAGENT_MODE and all mux env vars are already cleared by beforeEach;
    // restoreDetectMux() ran too, so this exercises the real detector's negative path.
    assert.equal(selectBackend(), "headless");
  });

  it("auto mode returns 'pane' when the mux detector reports a mux is available", () => {
    // Force the positive detector branch without depending on a real tmux/cmux binary
    // on $PATH. A regression that short-circuited auto mode to always return 'headless'
    // (e.g., a refactor that deleted the detectMux() call) would fail this case.
    __test__.setDetectMux(() => true);
    assert.equal(
      selectBackend(),
      "pane",
      "auto mode must consult detectMux() and route to 'pane' when it returns true",
    );
  });

  it("auto mode with an invalid PI_SUBAGENT_MODE value still consults detectMux() after warning", () => {
    // Belt-and-suspenders for the invalid-value fallthrough path: after warn-once,
    // the resolver must still honor the detector's verdict rather than hard-coding headless.
    process.env.PI_SUBAGENT_MODE = "bogus";
    __test__.setDetectMux(() => true);
    assert.equal(selectBackend(), "pane");
  });

  it("routes the invalid-mode warning through the dispatcher (UI when present, stderr otherwise), dedupe intact", () => {
    // stderr path (no UI): the existing resolver returns the null latestCtx.
    process.env.PI_SUBAGENT_MODE = "bogus";
    selectBackend();
    assert.ok(stderrCapture.includes('invalid PI_SUBAGENT_MODE="bogus"'));

    // UI path: swap in an ambient UI; dedupe means a NEW invalid value is needed.
    const prev = diag.getAmbientUi();
    const notes: Array<{ m: string; t?: string }> = [];
    diag.setAmbientUi(() => ({ hasUI: true, ui: { notify: (m, t) => notes.push({ m, t }) } }));
    try {
      process.env.PI_SUBAGENT_MODE = "bogus2";
      selectBackend();
      assert.equal(notes.length, 1);
      assert.equal(notes[0].t, "warning");
      assert.ok(notes[0].m.includes('invalid PI_SUBAGENT_MODE="bogus2"'));
      assert.equal(notes[0].m.endsWith("\n"), false, "UI text has trailing newline stripped");
    } finally {
      diag.setAmbientUi(prev);
    }
  });
});
