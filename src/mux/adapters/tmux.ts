import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { MuxAdapter } from "../types.ts";
import { hasCommand } from "../shell.ts";

const execFileAsync = promisify(execFile);

/**
 * Build the argv passed to `tmux split-window` for `createSurfaceSplit`.
 * Pure helper, exported for regression coverage of the detached-launch
 * contract: `opts.detach` must include `-d` so tmux does not transfer focus
 * onto the new pane.
 */
export function buildTmuxSplitArgs(
  direction: "left" | "right" | "up" | "down",
  fromSurface: string | undefined,
  opts: { detach?: boolean } | undefined,
): string[] {
  const args = ["split-window"];
  if (opts?.detach) args.push("-d");
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");
  return args;
}

/**
 * Whether the tmux backend should follow the split with a `select-pane -T`
 * title call. That call re-activates the target pane as a side-effect, so we
 * skip it for detached launches (which must leave focus on the parent agent).
 */
export function shouldSetTmuxPaneTitle(opts: { detach?: boolean } | undefined): boolean {
  return !opts?.detach;
}

export const tmuxAdapter: MuxAdapter = {
  name: "tmux",

  isAvailable(): boolean {
    return !!process.env.TMUX && hasCommand("tmux");
  },

  setupHint(): string {
    return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
  },

  createSurface(name: string, opts?: { detach?: boolean }): string {
    return this.createSurfaceSplit(name, "right", process.env.TMUX_PANE, opts);
  },

  createSurfaceSplit(
    name: string,
    direction: "left" | "right" | "up" | "down",
    fromSurface?: string,
    opts?: { detach?: boolean },
  ): string {
    const args = buildTmuxSplitArgs(direction, fromSurface, opts);

    const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
    if (!pane.startsWith("%")) {
      throw new Error(`Unexpected tmux split-window output: ${pane}`);
    }

    // Set the tmux pane title only when we are not asked to detach focus.
    // `select-pane -T name` re-activates the targeted pane as a side-effect,
    // which would re-steal focus from the parent agent and defeat the
    // detached launch contract used by orchestration wrappers (focus: false).
    // Upstream PR #36 dropped this cosmetic call entirely; we keep it for the
    // default `focus: true` path so existing UX is unchanged.
    if (shouldSetTmuxPaneTitle(opts)) {
      try {
        execFileSync("tmux", ["select-pane", "-t", pane, "-T", name], { encoding: "utf8" });
      } catch {
        // Optional.
      }
    }
    return pane;
  },

  closeSurface(surface: string): void {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  },

  sendCommand(surface: string, command: string): void {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
  },

  sendEscape(surface: string): void {
    execFileSync("tmux", ["send-keys", "-t", surface, "Escape"], { encoding: "utf8" });
  },

  readScreen(surface: string, lines = 50): string {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      {
        encoding: "utf8",
      },
    );
  },

  async readScreenAsync(surface: string, lines = 50): Promise<string> {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  },

  renameCurrentTab(title: string): void {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") {
      return;
    }
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
  },

  renameWorkspace(title: string): void {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") {
      return;
    }

    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const sessionId = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{session_id}"],
      {
        encoding: "utf8",
      },
    ).trim();
    execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
  },
};
