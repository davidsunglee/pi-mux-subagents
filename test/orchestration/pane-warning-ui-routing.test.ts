import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { launchSubagent } from "../../src/index.ts";

describe("pane launch warnings", () => {
  it("routes Codex unsupported-feature warnings through UI notify instead of raw stderr", async () => {
    type ExtensionHandler = (event: unknown, ctx: unknown) => void;
    const handlers: Record<string, ExtensionHandler> = {};
    subagentsExtension({
      registerTool: () => {},
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      sendUserMessage: () => {},
      sendMessage: () => {},
      on: (event: string, handler: ExtensionHandler) => {
        handlers[event] = handler;
      },
    } as any);

    const notifications: Array<{ message: string; level: string | undefined }> = [];
    handlers.session_start?.({}, {
      hasUI: true,
      ui: {
        notify: (message: string, level?: string) => {
          notifications.push({ message, level });
        },
        setWidget: () => {},
      },
    } as any);

    let stderr = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string | Buffer): boolean => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };

    const sessionDir = mkdtempSync(join(tmpdir(), "pi-pane-warning-ui-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "pi-pane-warning-project-"));
    mkdirSync(join(projectRoot, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".pi", "agents", "plan-reviewer.md"),
      "---\ntools: read, write, grep, find, ls\n---\n\nPlan reviewer fixture.\n",
      "utf8",
    );
    const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(sessionDir, "agent-config");
    try {
      await launchSubagent(
        {
          name: "step-1",
          task: "ignored; test only reaches pane command construction",
          agent: "plan-reviewer",
          cli: "codex",
          cwd: projectRoot,
        } as any,
        {
          sessionManager: {
            getSessionFile: () => join(sessionDir, "parent.jsonl"),
            getSessionId: () => "parent",
            getSessionDir: () => sessionDir,
          },
          cwd: projectRoot,
        } as any,
        { surface: "pi-test-fake-surface" },
      ).catch(() => {
        /* mux-less sendCommand throws after the warning path; ignored */
      });
    } finally {
      (process.stderr as any).write = origWrite;
      handlers.session_shutdown?.({}, {} as any);
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
      if (previousConfigDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousConfigDir;
      }
    }

    assert.equal(
      stderr.includes("[pi-interactive-subagent]"),
      false,
      `interactive pane warnings must not write raw stderr because it corrupts the active TUI editor; got ${JSON.stringify(stderr)}`,
    );
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "warning");
    assert.ok(
      notifications[0].message.includes("step-1"),
      `expected subagent name in UI warning; got ${JSON.stringify(notifications[0].message)}`,
    );
    assert.ok(
      notifications[0].message.includes("ignoring tools=read, write, grep, find, ls"),
      `expected tools warning in UI notification; got ${JSON.stringify(notifications[0].message)}`,
    );
  });

  it("falls back to raw stderr when hasUI is false (no notify, warning on stderr)", async () => {
    type ExtensionHandler = (event: unknown, ctx: unknown) => void;
    const handlers: Record<string, ExtensionHandler> = {};
    subagentsExtension({
      registerTool: () => {},
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      sendUserMessage: () => {},
      sendMessage: () => {},
      on: (event: string, handler: ExtensionHandler) => {
        handlers[event] = handler;
      },
    } as any);

    const notifications: Array<{ message: string; level: string | undefined }> = [];
    handlers.session_start?.({}, {
      hasUI: false,
      ui: {
        notify: (message: string, level?: string) => {
          notifications.push({ message, level });
        },
        setWidget: () => {},
      },
    } as any);

    let stderr = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string | Buffer): boolean => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };

    const sessionDir = mkdtempSync(join(tmpdir(), "pi-pane-warning-noui-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "pi-pane-warning-noui-project-"));
    mkdirSync(join(projectRoot, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".pi", "agents", "plan-reviewer.md"),
      "---\ntools: read, write, grep, find, ls\n---\n\nPlan reviewer fixture.\n",
      "utf8",
    );
    const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(sessionDir, "agent-config");
    try {
      await launchSubagent(
        {
          name: "step-1",
          task: "ignored; test only reaches pane command construction",
          agent: "plan-reviewer",
          cli: "codex",
          cwd: projectRoot,
        } as any,
        {
          sessionManager: {
            getSessionFile: () => join(sessionDir, "parent.jsonl"),
            getSessionId: () => "parent",
            getSessionDir: () => sessionDir,
          },
          cwd: projectRoot,
        } as any,
        { surface: "pi-test-fake-surface" },
      ).catch(() => {
        /* mux-less sendCommand throws after the warning path; ignored */
      });
    } finally {
      (process.stderr as any).write = origWrite;
      handlers.session_shutdown?.({}, {} as any);
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
      if (previousConfigDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousConfigDir;
      }
    }

    assert.equal(notifications.length, 0, "no UI present -> must not notify");
    assert.ok(
      stderr.includes("ignoring tools=read, write, grep, find, ls"),
      `expected codex tools warning on stderr; got ${JSON.stringify(stderr)}`,
    );
    assert.ok(stderr.includes("step-1"));
  });
});
