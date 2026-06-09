/**
 * Herdr terminal-multiplexer adapter.
 *
 * Strategy: tab-per-subagent for `createSurface`, pane-split for
 * `createSurfaceSplit`. The opaque surface string is
 * `herdr:<kind>:<encoded workspace_id>:<encoded terminal_id>`.
 * Every operation re-resolves the current `pane_id` and `tab_id` from the
 * stored `terminal_id` via `herdr pane list`, because Herdr compacts public
 * tab/pane ids when sibling tabs/panes close (verified against Herdr 0.5.10).
 *
 * Manual integration verification (run inside a live Herdr session):
 *
 *   1. Pane subagent end-to-end:
 *      `PI_SUBAGENT_MUX=herdr pi -ne -e <repo>/src/index.ts \
 *        --model anthropic/claude-haiku-4-5 'use the test-echo subagent'`
 *      Expected: a new herdr tab appears with the subagent's label, the child
 *      runs to completion, transcript is readable, and pi cleans up the tab.
 *
 *   2. subagent_run_parallel (concurrent tab creation):
 *      Trigger `subagent_run_parallel` with 3+ test-echo subagents from pi.
 *      Expected: 3+ unique tabs appear; each child completes; cleanup removes
 *      every tab even after sibling closes compact tab ids.
 *
 *   3. subagent_interrupt (Esc delivery):
 *      Start a long-running pane-pi subagent; call `subagent_interrupt id=...`.
 *      Expected: the child receives Esc and interrupts its active turn; the
 *      child pane/session/watcher remain alive.
 *
 *   4. Detached / focus:false:
 *      Trigger a `subagent_run_parallel` call with `focus: false`. Expected:
 *      focus stays on the parent pi tab while new subagent tabs are created.
 *
 *   5. Id compaction tolerance:
 *      Launch two subagent tabs; close one externally via `herdr tab close`.
 *      Verify `subagent_done` / cleanup on the remaining subagent still
 *      succeeds — the surviving tab's tab_id will have compacted to a lower
 *      number, and the adapter must resolve it via terminal_id.
 *
 *   6. Read-source combination:
 *      Run a subagent whose output is short enough to remain in `visible`
 *      but not flushed to `recent-unwrapped`. pollForExit must still observe
 *      `__SUBAGENT_DONE_<n>__` in the screen scrape.
 *
 *   7. Claude-CLI child subagent end-to-end:
 *      From a live Herdr session, launch a Claude-CLI pane-backed child via
 *      `subagent` / `subagent_run_serial` / `subagent_run_parallel`
 *      (e.g. `PI_SUBAGENT_MUX=herdr pi -ne -e <repo>/src/index.ts \
 *        --model anthropic/claude-haiku-4-5 \
 *        'use the test-echo subagent with cli=claude and a long input payload'`).
 *      Expected: a new herdr tab/pane appears running the `claude` CLI; the
 *      orchestrator delivers a long command (above a single TTY write) without
 *      truncation via `sendLongCommand`; the child completes its turn; the
 *      transcript is readable via `readScreen` / `readScreenAsync` (combined
 *      `recent-unwrapped` + `visible` sources); completion is reported through
 *      the `.exit` / `__SUBAGENT_DONE_<n>__` sentinel and observed by
 *      `pollForExit`; and the adapter's `closeSurface` cleans up the tab/pane
 *      (no orphaned Claude-CLI process, no orphaned herdr pane). Repeat with
 *      `subagent_run_parallel` driving at least one Claude-CLI child alongside
 *      one pi-CLI child to exercise mixed-CLI concurrent launches.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type {
  MuxAdapter,
  HerdrPaneInfo,
  HerdrSurfaceKind,
  HerdrSurface,
} from "../types.ts";
import { hasCommand } from "../shell.ts";

const execFileAsync = promisify(execFile);

export function parseHerdrJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseHerdrPaneInfo(value: unknown): HerdrPaneInfo | null {
  if (!value || typeof value !== "object") return null;

  // Herdr 0.5.x returns pane objects both directly in nested command results
  // (e.g. tab create's `result.root_pane`) and inside `pane get`'s
  // `{ result: { pane: ... } }` envelope. Accept both so callers can parse the
  // live CLI shape without duplicating envelope-unwrapping logic.
  const paneValue = (value as { result?: unknown; pane?: unknown }).pane;
  const resultValue = (value as { result?: unknown }).result;
  const resultPaneValue =
    resultValue && typeof resultValue === "object"
      ? (resultValue as { pane?: unknown }).pane
      : undefined;
  const record = (paneValue ?? resultPaneValue ?? value) as {
    pane_id?: unknown;
    tab_id?: unknown;
    workspace_id?: unknown;
    terminal_id?: unknown;
    focused?: unknown;
  };
  if (
    typeof record.pane_id !== "string" || record.pane_id.length === 0 ||
    typeof record.tab_id !== "string" || record.tab_id.length === 0 ||
    typeof record.workspace_id !== "string" || record.workspace_id.length === 0 ||
    typeof record.terminal_id !== "string" || record.terminal_id.length === 0
  ) {
    return null;
  }
  const info: HerdrPaneInfo = {
    pane_id: record.pane_id,
    tab_id: record.tab_id,
    workspace_id: record.workspace_id,
    terminal_id: record.terminal_id,
  };
  if (typeof record.focused === "boolean") info.focused = record.focused;
  return info;
}

export function parseHerdrTabCreateResult(value: unknown): HerdrPaneInfo | null {
  if (!value || typeof value !== "object") return null;
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;
  return parseHerdrPaneInfo((result as { root_pane?: unknown }).root_pane);
}

export function parseHerdrPaneSplitResult(value: unknown): HerdrPaneInfo | null {
  if (!value || typeof value !== "object") return null;
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;
  return parseHerdrPaneInfo((result as { pane?: unknown }).pane);
}

export function parseHerdrPaneList(value: unknown): HerdrPaneInfo[] | null {
  if (!value) return null;
  let array: unknown;
  if (Array.isArray(value)) {
    array = value;
  } else if (typeof value === "object") {
    const result = (value as { result?: unknown; panes?: unknown }).result;
    if (Array.isArray(result)) {
      array = result;
    } else if (result && typeof result === "object" && Array.isArray((result as { panes?: unknown }).panes)) {
      array = (result as { panes: unknown[] }).panes;
    } else if (Array.isArray((value as { panes?: unknown }).panes)) {
      array = (value as { panes: unknown[] }).panes;
    } else {
      return null;
    }
  } else {
    return null;
  }
  const out: HerdrPaneInfo[] = [];
  for (const entry of array as unknown[]) {
    const info = parseHerdrPaneInfo(entry);
    if (info) out.push(info);
  }
  return out;
}

export function findPaneByTerminalId(
  panes: readonly HerdrPaneInfo[],
  terminalId: string,
): HerdrPaneInfo | null {
  for (const pane of panes) {
    if (pane.terminal_id === terminalId) return pane;
  }
  return null;
}

export function encodeHerdrSurface(
  kind: HerdrSurfaceKind,
  workspaceId: string,
  terminalId: string,
): string {
  return `herdr:${kind}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(terminalId)}`;
}

export function decodeHerdrSurface(surface: string): HerdrSurface | null {
  if (!surface.startsWith("herdr:")) return null;
  const parts = surface.split(":");
  if (parts.length !== 4) return null;
  const [, kindRaw, workspaceRaw, terminalRaw] = parts;
  if (kindRaw !== "tab" && kindRaw !== "pane") return null;
  if (!workspaceRaw || !terminalRaw) return null;
  let workspaceId: string;
  let terminalId: string;
  try {
    workspaceId = decodeURIComponent(workspaceRaw);
    terminalId = decodeURIComponent(terminalRaw);
  } catch {
    return null;
  }
  if (!workspaceId || !terminalId) return null;
  return { kind: kindRaw, workspaceId, terminalId };
}

export function buildHerdrTabCreateArgs(params: {
  workspaceId: string;
  cwd: string;
  label: string;
  detach: boolean;
}): string[] {
  const args = [
    "tab",
    "create",
    "--workspace",
    params.workspaceId,
    "--cwd",
    params.cwd,
    "--label",
    params.label,
  ];
  if (params.detach) args.push("--no-focus");
  return args;
}

export function buildHerdrPaneSplitArgs(params: {
  paneId: string;
  direction: "left" | "right" | "up" | "down";
  detach: boolean;
}): string[] {
  const direction =
    params.direction === "left" || params.direction === "right" ? "right" : "down";
  const args = ["pane", "split", params.paneId, "--direction", direction];
  if (params.detach) args.push("--no-focus");
  return args;
}

export function buildHerdrSendCommandArgs(paneId: string, command: string): string[][] {
  return [
    ["pane", "send-text", paneId, command],
    ["pane", "send-keys", paneId, "Enter"],
  ];
}

export function isHerdrPaneNotFoundError(error: unknown): boolean {
  const record = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [record?.message, record?.stdout, record?.stderr]
    .filter((value): value is string | Buffer => typeof value === "string" || Buffer.isBuffer(value))
    .some((value) => value.toString().includes("pane_not_found"));
}

function isHerdrPaneResolutionRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Could not resolve herdr surface to a live pane");
}

function isRetryableHerdrPaneActionError(error: unknown): boolean {
  return isHerdrPaneNotFoundError(error) || isHerdrPaneResolutionRace(error);
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function runHerdrPaneActionWithRetry(params: {
  resolvePaneId: () => string;
  run: (paneId: string) => void;
  maxAttempts?: number;
  retryDelayMs?: number;
}): void {
  const maxAttempts = Math.max(1, params.maxAttempts ?? 5);
  const retryDelayMs = Math.max(0, params.retryDelayMs ?? 100);
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const paneId = params.resolvePaneId();
      params.run(paneId);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableHerdrPaneActionError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      sleepSync(retryDelayMs);
    }
  }
  throw lastError;
}

export function combineHerdrReadOutput(
  recentUnwrapped: string,
  visible: string,
): string {
  const left = recentUnwrapped.trimEnd();
  const right = visible.trimEnd();
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  return `${left}\n${right}`;
}

function runHerdrText(args: readonly string[]): string {
  return execFileSync("herdr", args as string[], { encoding: "utf8" });
}

function runHerdrJson(args: readonly string[]): unknown {
  const stdout = runHerdrText(args).trim();
  if (!stdout) {
    throw new Error(`herdr ${args.join(" ")} returned empty stdout`);
  }
  const parsed = parseHerdrJson(stdout);
  if (parsed === null) {
    throw new Error(`herdr ${args.join(" ")} returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  return parsed;
}

function readHerdrPaneListSnapshot(): HerdrPaneInfo[] {
  // `herdr pane list` prints JSON by default; Herdr 0.5.x rejects a `--json` flag.
  const parsed = runHerdrJson(["pane", "list"]);
  const list = parseHerdrPaneList(parsed);
  if (!list) {
    throw new Error(`herdr pane list returned unexpected shape`);
  }
  return list;
}

function resolveSurfacePane(surface: string): HerdrPaneInfo {
  const decoded = decodeHerdrSurface(surface);
  if (!decoded) {
    throw new Error(`herdr adapter received non-herdr surface: ${surface}`);
  }
  const panes = readHerdrPaneListSnapshot();
  const pane = findPaneByTerminalId(panes, decoded.terminalId);
  if (!pane) {
    throw new Error(
      `Could not resolve herdr surface to a live pane (terminal_id=${decoded.terminalId}; ` +
        `kind=${decoded.kind}; workspace_id=${decoded.workspaceId}). ` +
        `The pane may have been closed externally.`,
    );
  }
  return pane;
}

function getParentPaneInfo(): HerdrPaneInfo {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) {
    throw new Error(
      "HERDR_PANE_ID is not set — pi must be running inside a herdr pane to create surfaces.",
    );
  }
  const parsed = runHerdrJson(["pane", "get", paneId]);
  const info =
    parseHerdrPaneInfo(parsed) ??
    parseHerdrPaneInfo((parsed as { result?: unknown }).result);
  if (!info) {
    throw new Error(
      `herdr pane get ${paneId} returned an unexpected shape: ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }
  return info;
}

async function readHerdrPaneSource(
  paneId: string,
  source: "recent-unwrapped" | "visible",
  lines: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "herdr",
      ["pane", "read", paneId, "--source", source, "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" },
    );
    return stdout;
  } catch {
    return "";
  }
}

function readHerdrPaneSourceSync(
  paneId: string,
  source: "recent-unwrapped" | "visible",
  lines: number,
): string {
  try {
    return execFileSync(
      "herdr",
      ["pane", "read", paneId, "--source", source, "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" },
    );
  } catch {
    return "";
  }
}

export const herdrAdapter: MuxAdapter = {
  name: "herdr",

  isAvailable(): boolean {
    return process.env.HERDR_ENV === "1" && hasCommand("herdr");
  },

  setupHint(): string {
    return "Start pi inside herdr (`herdr` to launch a session, then run `pi`).";
  },

  createSurface(name: string, opts?: { detach?: boolean }): string {
    const parent = getParentPaneInfo();
    const args = buildHerdrTabCreateArgs({
      workspaceId: parent.workspace_id,
      cwd: process.cwd(),
      label: name,
      detach: opts?.detach === true,
    });
    const parsed = runHerdrJson(args);
    const rootPane = parseHerdrTabCreateResult(parsed);
    if (!rootPane) {
      throw new Error(
        `Unexpected herdr tab create response: ${JSON.stringify(parsed).slice(0, 200)}`,
      );
    }
    return encodeHerdrSurface("tab", rootPane.workspace_id, rootPane.terminal_id);
  },

  createSurfaceSplit(
    name: string,
    direction: "left" | "right" | "up" | "down",
    fromSurface?: string,
    opts?: { detach?: boolean },
  ): string {
    void name;
    let parentPaneId: string;
    if (fromSurface) {
      parentPaneId = resolveSurfacePane(fromSurface).pane_id;
    } else {
      parentPaneId = getParentPaneInfo().pane_id;
    }
    const args = buildHerdrPaneSplitArgs({
      paneId: parentPaneId,
      direction,
      detach: opts?.detach === true,
    });
    const parsed = runHerdrJson(args);
    const pane = parseHerdrPaneSplitResult(parsed);
    if (!pane) {
      throw new Error(
        `Unexpected herdr pane split response: ${JSON.stringify(parsed).slice(0, 200)}`,
      );
    }
    return encodeHerdrSurface("pane", pane.workspace_id, pane.terminal_id);
  },

  closeSurface(surface: string): void {
    const decoded = decodeHerdrSurface(surface);
    if (!decoded) {
      throw new Error(`herdr adapter received non-herdr surface in closeSurface: ${surface}`);
    }
    const panes = readHerdrPaneListSnapshot();
    const pane = findPaneByTerminalId(panes, decoded.terminalId);
    if (!pane) {
      return;
    }
    if (decoded.kind === "tab") {
      execFileSync("herdr", ["tab", "close", pane.tab_id], { encoding: "utf8" });
    } else {
      execFileSync("herdr", ["pane", "close", pane.pane_id], { encoding: "utf8" });
    }
  },

  sendCommand(surface: string, command: string): void {
    // `sendCommand` is the mux abstraction for "type this and press Enter".
    // Herdr's `pane run` is also documented as a combined text+Enter operation,
    // but the explicit text/key primitives keep this path tied to interactive
    // input semantics across Herdr versions.
    // Re-resolve between the text and Enter calls: Herdr compacts public pane
    // ids when sibling panes close, so a pane_id can become stale between two
    // CLI invocations even though the stored terminal_id surface is still live.
    runHerdrPaneActionWithRetry({
      resolvePaneId: () => resolveSurfacePane(surface).pane_id,
      run: (paneId) => {
        execFileSync("herdr", buildHerdrSendCommandArgs(paneId, command)[0], { encoding: "utf8" });
      },
    });
    runHerdrPaneActionWithRetry({
      resolvePaneId: () => resolveSurfacePane(surface).pane_id,
      run: (paneId) => {
        execFileSync("herdr", buildHerdrSendCommandArgs(paneId, command)[1], { encoding: "utf8" });
      },
    });
  },

  sendEscape(surface: string): void {
    const pane = resolveSurfacePane(surface);
    execFileSync("herdr", ["pane", "send-keys", pane.pane_id, "Esc"], { encoding: "utf8" });
  },

  readScreen(surface: string, lines = 50): string {
    const pane = resolveSurfacePane(surface);
    const recent = readHerdrPaneSourceSync(pane.pane_id, "recent-unwrapped", lines);
    const visible = readHerdrPaneSourceSync(pane.pane_id, "visible", lines);
    return combineHerdrReadOutput(recent, visible);
  },

  async readScreenAsync(surface: string, lines = 50): Promise<string> {
    const pane = resolveSurfacePane(surface);
    const [recent, visible] = await Promise.all([
      readHerdrPaneSource(pane.pane_id, "recent-unwrapped", lines),
      readHerdrPaneSource(pane.pane_id, "visible", lines),
    ]);
    return combineHerdrReadOutput(recent, visible);
  },

  renameCurrentTab(title: string): void {
    try {
      const parent = getParentPaneInfo();
      execFileSync("herdr", ["tab", "rename", parent.tab_id, title], { encoding: "utf8" });
    } catch {
      // Best-effort: Herdr versions without `tab rename` keep the prior label.
    }
  },

  renameWorkspace(title: string): void {
    try {
      const parent = getParentPaneInfo();
      execFileSync("herdr", ["workspace", "rename", parent.workspace_id, title], {
        encoding: "utf8",
      });
    } catch {
      // Best-effort: Herdr versions without `workspace rename` keep the prior label.
    }
  },
};
