import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { MuxAdapter } from "../types.ts";
import { hasCommand, tailLines } from "../shell.ts";

const execFileAsync = promisify(execFile);

export const weztermAdapter: MuxAdapter = {
  name: "wezterm",

  isAvailable(): boolean {
    return !!process.env.WEZTERM_UNIX_SOCKET && hasCommand("wezterm");
  },

  setupHint(): string {
    return "Start pi inside WezTerm.";
  },

  createSurface(name: string, opts?: { detach?: boolean }): string {
    return this.createSurfaceSplit(name, "right", undefined, opts);
  },

  createSurfaceSplit(
    name: string,
    direction: "left" | "right" | "up" | "down",
    fromSurface?: string,
    opts?: { detach?: boolean },
  ): string {
    const args = ["cli", "split-pane"];
    if (direction === "left") args.push("--left");
    else if (direction === "right") args.push("--right");
    else if (direction === "up") args.push("--top");
    else args.push("--bottom");
    args.push("--cwd", process.cwd());
    if (fromSurface) {
      args.push("--pane-id", fromSurface);
    }
    const paneId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
    if (!paneId || !/^\d+$/.test(paneId)) {
      throw new Error(`Unexpected wezterm split-pane output: ${paneId || "(empty)"}`);
    }
    try {
      execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], {
        encoding: "utf8",
      });
    } catch {
      // Optional — tab title is cosmetic.
    }
    void opts;
    return paneId;
  },

  closeSurface(surface: string): void {
    execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
      encoding: "utf8",
    });
  },

  sendCommand(surface: string, command: string): void {
    execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", command + "\n"], {
      encoding: "utf8",
    });
  },

  sendEscape(surface: string): void {
    execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", ""], { encoding: "utf8" });
  },

  readScreen(surface: string, lines = 50): string {
    const raw = execFileSync(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      { encoding: "utf8" },
    );
    return tailLines(raw, lines);
  },

  async readScreenAsync(surface: string, lines = 50): Promise<string> {
    const { stdout } = await execFileAsync(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      { encoding: "utf8" },
    );
    return tailLines(stdout, lines);
  },

  renameCurrentTab(title: string): void {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-tab-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    execFileSync("wezterm", args, { encoding: "utf8" });
  },

  renameWorkspace(title: string): void {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-window-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    try {
      execFileSync("wezterm", args, { encoding: "utf8" });
    } catch {
      // Optional — window title is cosmetic.
    }
  },
};
