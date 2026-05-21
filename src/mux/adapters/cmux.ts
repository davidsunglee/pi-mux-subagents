import { execSync, execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import type { MuxAdapter, CmuxFocusSnapshot, CmuxCreatedSurface, CmuxAppIdentity } from "../types.ts";
import { hasCommand, shellEscape } from "../shell.ts";

const execFileAsync = promisify(execFile);

/** Tracked subagent pane for cmux — reused across subagent launches. */
let cmuxSubagentPane: string | null = null;

type CmuxIdentifySnapshot = {
  focused: CmuxFocusSnapshot | null;
  caller: CmuxFocusSnapshot | null;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseCmuxFocusedSnapshot(value: unknown): CmuxFocusSnapshot | null {
  if (!value || typeof value !== "object") return null;

  const focused = (value as { focused?: unknown }).focused;
  if (!focused || typeof focused !== "object") return null;

  const record = focused as { surface_ref?: unknown; pane_ref?: unknown };
  const surfaceRef = nonEmptyString(record.surface_ref) ? record.surface_ref : undefined;
  const paneRef = nonEmptyString(record.pane_ref) ? record.pane_ref : undefined;

  if (!surfaceRef && !paneRef) return null;
  return { surfaceRef, paneRef };
}

export function parseCmuxJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseCmuxFocusedSnapshotFromJson(value: string): CmuxFocusSnapshot | null {
  return parseCmuxFocusedSnapshot(parseCmuxJson(value));
}

function parseCmuxCallerSnapshot(value: unknown): CmuxFocusSnapshot | null {
  if (!value || typeof value !== "object") return null;

  const caller = (value as { caller?: unknown }).caller;
  if (!caller || typeof caller !== "object") return null;

  const record = caller as { surface_ref?: unknown; pane_ref?: unknown };
  const surfaceRef = nonEmptyString(record.surface_ref) ? record.surface_ref : undefined;
  const paneRef = nonEmptyString(record.pane_ref) ? record.pane_ref : undefined;

  if (!surfaceRef && !paneRef) return null;
  return { surfaceRef, paneRef };
}

export function parseCmuxPaneRefForSurface(value: unknown, surface: string): string | null {
  if (!value || typeof value !== "object") return null;

  const record = value as { surface_ref?: unknown; pane_ref?: unknown; caller?: unknown };
  if (record.surface_ref === surface && nonEmptyString(record.pane_ref)) return record.pane_ref;

  const caller = record.caller;
  if (!caller || typeof caller !== "object") return null;

  const callerRecord = caller as { surface_ref?: unknown; pane_ref?: unknown };
  if (callerRecord.surface_ref === surface && nonEmptyString(callerRecord.pane_ref)) {
    return callerRecord.pane_ref;
  }

  return null;
}

export function parseCmuxPaneRefForSurfaceFromJson(value: string, surface: string): string | null {
  return parseCmuxPaneRefForSurface(parseCmuxJson(value), surface);
}

export function isCmuxForegroundAppIdentity(identity: CmuxAppIdentity | null): boolean {
  const bundleIdentifier = identity?.bundleIdentifier?.trim().toLowerCase();
  if (bundleIdentifier === "com.cmuxterm.app") return true;

  const localizedName = identity?.localizedName?.trim().toLowerCase();
  return localizedName === "cmux";
}

function readMacForegroundAppIdentity(): CmuxAppIdentity | null {
  try {
    const script = `
      ObjC.import("AppKit");
      const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      if (!app) {
        JSON.stringify({});
      } else {
        JSON.stringify({
          bundleIdentifier: app.bundleIdentifier ? ObjC.unwrap(app.bundleIdentifier) : "",
          localizedName: app.localizedName ? ObjC.unwrap(app.localizedName) : "",
        });
      }
    `;
    const output = execFileSync("osascript", ["-l", "JavaScript", "-e", script], {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    const parsed = parseCmuxJson(output);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { bundleIdentifier?: unknown; localizedName?: unknown };
    return {
      bundleIdentifier: nonEmptyString(record.bundleIdentifier) ? record.bundleIdentifier : undefined,
      localizedName: nonEmptyString(record.localizedName) ? record.localizedName : undefined,
    };
  } catch {
    return null;
  }
}

function isCmuxForegroundApp(): boolean {
  if (process.platform !== "darwin") return true;
  return isCmuxForegroundAppIdentity(readMacForegroundAppIdentity());
}

function readCmux(args: string[]): string | null {
  const result = spawnSync("cmux", args, { encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout;
}

function parseCmuxIdentifySnapshot(value: string | null): CmuxIdentifySnapshot {
  const parsed = value ? parseCmuxJson(value) : null;
  return {
    focused: parseCmuxFocusedSnapshot(parsed),
    caller: parseCmuxCallerSnapshot(parsed),
  };
}

function captureCmuxIdentifySnapshot(): CmuxIdentifySnapshot {
  return parseCmuxIdentifySnapshot(readCmux(["identify", "--json"]));
}

function captureCmuxFocusSnapshot(): CmuxFocusSnapshot | null {
  return captureCmuxIdentifySnapshot().focused;
}

function readCmuxPaneRefForSurface(surface: string): string | null {
  const info = readCmux(["identify", "--surface", surface]);
  return info ? parseCmuxPaneRefForSurfaceFromJson(info, surface) : null;
}

function restoreCmuxFocusSnapshot(
  snapshot: CmuxFocusSnapshot | null,
  options?: { cmuxWasForeground?: boolean },
): void {
  if (!snapshot) return;
  if (options?.cmuxWasForeground === false) return;
  if (!isCmuxForegroundApp()) return;

  if (snapshot.paneRef) {
    spawnSync("cmux", ["focus-pane", "--pane", snapshot.paneRef], { encoding: "utf8" });
  }

  if (snapshot.surfaceRef) {
    spawnSync("cmux", ["focus-panel", "--panel", snapshot.surfaceRef], { encoding: "utf8" });
  }
}

function waitForCmuxFocusSettle(): void {
  // Sleep ~100ms without keeping the event loop busy. cmux's focus update is
  // asynchronous relative to `cmux new-split` exit, so we have to give it a
  // moment to settle before we sample the focused snapshot back.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}

function cmuxFocusMatchesChild(
  currentFocus: CmuxFocusSnapshot | null,
  child: CmuxCreatedSurface,
): boolean {
  if (!currentFocus) return false;
  if (currentFocus.surfaceRef === child.surface) return true;
  return !!currentFocus.paneRef && currentFocus.paneRef === child.paneRef;
}

function cmuxFocusMatchesSurfaceRef(
  currentFocus: CmuxFocusSnapshot | null,
  surfaceRef: string | undefined,
): boolean {
  return !!surfaceRef && currentFocus?.surfaceRef === surfaceRef;
}

function cmuxFocusMatchesPaneRef(
  currentFocus: CmuxFocusSnapshot | null,
  paneRef: string | undefined,
): boolean {
  return !!paneRef && currentFocus?.paneRef === paneRef;
}

export function shouldRestoreCmuxFocusAfterLaunch(params: {
  cmuxWasForeground: boolean;
  cmuxIsForeground?: boolean;
  snapshot: CmuxFocusSnapshot | null;
  currentFocus: CmuxFocusSnapshot | null;
  child: CmuxCreatedSurface;
  sourceSurfaceRef?: string;
  callerSnapshot?: CmuxFocusSnapshot | null;
}): boolean {
  if (!params.cmuxWasForeground || params.cmuxIsForeground === false || !params.snapshot) {
    return false;
  }

  return (
    cmuxFocusMatchesChild(params.currentFocus, params.child) ||
    cmuxFocusMatchesSurfaceRef(params.currentFocus, params.sourceSurfaceRef) ||
    cmuxFocusMatchesSurfaceRef(params.currentFocus, params.callerSnapshot?.surfaceRef) ||
    // cmux can settle focus onto another active surface in the caller pane
    // after creating a split/surface; treat that as "focus moved as a
    // side-effect of the launch" and restore the original snapshot.
    cmuxFocusMatchesPaneRef(params.currentFocus, params.callerSnapshot?.paneRef)
  );
}

function restoreCmuxFocusIfLaunchSurfaceFocused(
  snapshot: CmuxFocusSnapshot | null,
  child: CmuxCreatedSurface,
  options: {
    cmuxWasForeground: boolean;
    sourceSurfaceRef?: string;
    callerSnapshot?: CmuxFocusSnapshot | null;
  },
): void {
  if (!snapshot || !options.cmuxWasForeground) return;

  waitForCmuxFocusSettle();
  const currentFocus = captureCmuxFocusSnapshot();
  const cmuxIsForeground = isCmuxForegroundApp();
  if (
    shouldRestoreCmuxFocusAfterLaunch({
      cmuxWasForeground: options.cmuxWasForeground,
      cmuxIsForeground,
      snapshot,
      currentFocus,
      child,
      sourceSurfaceRef: options.sourceSurfaceRef,
      callerSnapshot: options.callerSnapshot,
    })
  ) {
    restoreCmuxFocusSnapshot(snapshot, { cmuxWasForeground: true });
  }
}

function parseCmuxCreatedSurface(output: string, command: string): CmuxCreatedSurface {
  const surfaceMatch = output.match(/surface:\d+/);
  if (!surfaceMatch) {
    throw new Error(`Unexpected cmux ${command} output: ${output}`);
  }

  return {
    surface: surfaceMatch[0],
    paneRef: output.match(/pane:\d+/)?.[0],
  };
}

function renameCmuxSurface(surface: string, name: string): void {
  execFileSync("cmux", ["rename-tab", "--surface", surface, name], { encoding: "utf8" });
}

function createCmuxSplitSurface(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): CmuxCreatedSurface {
  const identifySnapshot = captureCmuxIdentifySnapshot();
  const focusSnapshot = identifySnapshot.focused;
  const callerSnapshot = identifySnapshot.caller;
  const cmuxWasForeground = isCmuxForegroundApp();
  let child: CmuxCreatedSurface | null = null;

  try {
    const args = ["new-split", direction];
    if (fromSurface) args.push("--surface", fromSurface);

    const output = execFileSync("cmux", args, { encoding: "utf8" }).trim();
    child = parseCmuxCreatedSurface(output, "new-split");
    child.paneRef ??= readCmuxPaneRefForSurface(child.surface) ?? undefined;
    renameCmuxSurface(child.surface, name);
    return child;
  } finally {
    if (child) {
      restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
        cmuxWasForeground,
        sourceSurfaceRef: fromSurface,
        callerSnapshot,
      });
    } else {
      restoreCmuxFocusSnapshot(focusSnapshot, { cmuxWasForeground });
    }
  }
}

function createSurfaceInPane(name: string, pane: string): string {
  const identifySnapshot = captureCmuxIdentifySnapshot();
  const focusSnapshot = identifySnapshot.focused;
  const callerSnapshot = identifySnapshot.caller;
  const cmuxWasForeground = isCmuxForegroundApp();
  let child: CmuxCreatedSurface | null = null;

  try {
    const output = execFileSync("cmux", ["new-surface", "--pane", pane], {
      encoding: "utf8",
    }).trim();
    child = parseCmuxCreatedSurface(output, "new-surface");
    child.paneRef ??= pane;
    renameCmuxSurface(child.surface, name);
    return child.surface;
  } finally {
    if (child) {
      restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
        cmuxWasForeground,
        callerSnapshot,
      });
    } else {
      restoreCmuxFocusSnapshot(focusSnapshot, { cmuxWasForeground });
    }
  }
}

export const cmuxAdapter: MuxAdapter = {
  name: "cmux",

  isAvailable(): boolean {
    return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
  },

  setupHint(): string {
    return "Start pi inside cmux (`cmux pi`).";
  },

  createSurface(name: string, _opts?: { detach?: boolean }): string {
    if (cmuxSubagentPane) {
      try {
        const tree = execSync(`cmux tree`, { encoding: "utf8" });
        if (tree.includes(cmuxSubagentPane)) {
          return createSurfaceInPane(name, cmuxSubagentPane);
        }
      } catch {}
      cmuxSubagentPane = null;
    }

    const created = createCmuxSplitSurface(name, "right", process.env.CMUX_SURFACE_ID);
    cmuxSubagentPane = created.paneRef ?? null;
    return created.surface;
  },

  createSurfaceSplit(
    name: string,
    direction: "left" | "right" | "up" | "down",
    fromSurface?: string,
    _opts?: { detach?: boolean },
  ): string {
    return createCmuxSplitSurface(name, direction, fromSurface).surface;
  },

  closeSurface(surface: string): void {
    execSync(`cmux close-surface --surface ${shellEscape(surface)}`, { encoding: "utf8" });
  },

  sendCommand(surface: string, command: string): void {
    execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(command + "\n")}`, {
      encoding: "utf8",
    });
  },

  sendEscape(surface: string): void {
    execFileSync("cmux", ["send", "--surface", surface, "\x1b"], { encoding: "utf8" });
  },

  readScreen(surface: string, lines = 50): string {
    return execSync(`cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`, {
      encoding: "utf8",
    });
  },

  async readScreenAsync(surface: string, lines = 50): Promise<string> {
    const { stdout } = await execFileAsync(
      "cmux",
      ["read-screen", "--surface", surface, "--lines", String(lines)],
      { encoding: "utf8" },
    );
    return stdout;
  },

  renameCurrentTab(title: string): void {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
    execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, {
      encoding: "utf8",
    });
  },

  renameWorkspace(title: string): void {
    execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, {
      encoding: "utf8",
    });
  },
};
