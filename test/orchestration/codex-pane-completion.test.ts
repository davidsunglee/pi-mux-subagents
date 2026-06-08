import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composePanePrompt,
  PANE_COMPLETION_PROTOCOLS,
} from "../../src/launch/pane-completion-protocol.ts";
import { __test__, launchSubagent } from "../../src/index.ts";

describe("Codex pane prompt — composer", () => {
  it("autonomous prompt is tool-first with no Claude final-message wording", () => {
    const { taskPrompt } = composePanePrompt({
      neutralCore: "DO THE TASK",
      protocol: PANE_COMPLETION_PROTOCOLS.codex.autonomous,
    });
    assert.ok(taskPrompt.includes("DO THE TASK"));
    assert.ok(taskPrompt.includes("subagent_done(message="));
    assert.ok(taskPrompt.includes("before sending any final answer"));
    assert.ok(taskPrompt.includes("no further output"));
    assert.ok(taskPrompt.includes("without asking the user questions"));
    assert.doesNotMatch(taskPrompt, /FINAL assistant message/);
    assert.doesNotMatch(taskPrompt, /summarize what you accomplished/);
    assert.doesNotMatch(taskPrompt, /then call `subagent_done` to end the session/);
  });

  it("interactive prompt is tool-first and invites clarifying questions", () => {
    const { taskPrompt } = composePanePrompt({
      neutralCore: "DO THE TASK",
      protocol: PANE_COMPLETION_PROTOCOLS.codex.interactive,
    });
    assert.ok(taskPrompt.includes("DO THE TASK"));
    assert.ok(taskPrompt.includes("subagent_done(message="));
    assert.ok(taskPrompt.includes("before sending any final answer"));
    assert.ok(taskPrompt.includes("no further output"));
    assert.ok(taskPrompt.includes("clarifying questions"));
    assert.doesNotMatch(taskPrompt, /FINAL assistant message/);
    assert.doesNotMatch(taskPrompt, /summarize what you accomplished/);
    assert.doesNotMatch(taskPrompt, /then call `subagent_done` to end the session/);
  });
});

describe("Codex pane prompt — launch argv", () => {
  before(() => {
    __test__.setSurfaceOverrides({
      createSurface: () => "fake-surface",
      sendLongCommand: () => {},
    } as any);
  });
  after(() => {
    __test__.setSurfaceOverrides(null);
  });

  /**
   * Seed a Codex agent fixture under a temp `ctxCwd/.pi/agents/<name>.md` so
   * the agent's frontmatter (auto-exit, cli) is honored, dispatch the pane
   * subagent through the fake surface, and return the captured launch command.
   */
  async function captureCodexLaunchCommand(name: string, agentBody: string): Promise<string> {
    const sessionDir = mkdtempSync(join(tmpdir(), "codex-pane-"));
    const ctxCwd = mkdtempSync(join(tmpdir(), "codex-pane-ctx-"));
    // Redirect the global agent-config root to a writable temp dir so
    // resolveLaunchSpec does not touch `~/.pi/agent` (which raises EPERM in
    // sandboxed/CI workspaces) and the test stays hermetic.
    const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(sessionDir, "agent-config");
    // Snapshot any command captured by a prior call so we can tell whether this
    // launch actually produced a new command before any error was thrown.
    const baselineCmd = __test__.getLastLaunchCommand();
    try {
      const agentsDir = join(ctxCwd, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, `${name}.md`), agentBody);
      try {
        await launchSubagent(
          { cli: "codex", name, task: "ECHO_TASK", agent: name } as any,
          {
            sessionManager: {
              getSessionFile: () => join(sessionDir, "parent.jsonl"),
              getSessionId: () => "parent",
              getSessionDir: () => sessionDir,
            },
            cwd: ctxCwd,
          } as any,
          { surface: "fake-surface" },
        );
      } catch (err) {
        // Only tolerate the expected fake-surface dispatch boundary, which can
        // only be reached after this launch has captured a fresh command. If no
        // new command was captured, the failure is an unexpected setup error
        // (e.g. EPERM on the agent-config root) and must surface, not be hidden.
        if (__test__.getLastLaunchCommand() === baselineCmd) {
          throw err;
        }
      }
      const cmd = __test__.getLastLaunchCommand();
      assert.ok(cmd, "expected a captured launch command");
      assert.notEqual(cmd, baselineCmd, "expected a freshly captured launch command");
      return cmd!;
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(ctxCwd, { recursive: true, force: true });
      if (previousConfigDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousConfigDir;
      }
    }
  }

  it("autonomous Codex pane command is tool-first with no Claude/modeHint wording", async () => {
    const cmd = await captureCodexLaunchCommand(
      "codex-auto",
      "---\nauto-exit: true\ncli: codex\n---\nbody",
    );
    assert.ok(cmd.includes("subagent_done(message="));
    assert.ok(cmd.includes("before sending any final answer"));
    assert.doesNotMatch(cmd, /FINAL assistant message/);
    assert.doesNotMatch(cmd, /summarize what you accomplished/);
    assert.doesNotMatch(cmd, /Complete your task autonomously\./);
  });

  it("interactive Codex pane command invites clarifying questions and is tool-first", async () => {
    const cmd = await captureCodexLaunchCommand(
      "codex-interactive",
      "---\nauto-exit: false\ncli: codex\n---\nbody",
    );
    assert.ok(cmd.includes("clarifying questions"));
    assert.ok(cmd.includes("subagent_done(message="));
    assert.doesNotMatch(cmd, /FINAL assistant message/);
  });

  it("includes the agent body in the pane command even when system-prompt: append is set (identity not dropped)", async () => {
    const cmd = await captureCodexLaunchCommand(
      "codex-append-identity",
      "---\nauto-exit: true\ncli: codex\nsystem-prompt: append\n---\nCODEX_PANE_BODY_MARKER_7f3a2",
    );
    assert.ok(
      cmd.includes("CODEX_PANE_BODY_MARKER_7f3a2"),
      `Codex pane command must carry the agent body when system-prompt: append is set; got: ${cmd}`,
    );
    // Composes with the completion seam: identity + tool-first completion wording.
    assert.ok(cmd.includes("subagent_done(message="));
  });

  it("delivers a test-runner-shaped artifact contract into the pane command body", async () => {
    const body = [
      "Emit your result in EXACTLY this format:",
      "COMMAND: <cmd>",
      "EXIT_CODE: <code>",
      "BEGIN_FAILING_IDENTIFIERS",
      "END_FAILING_IDENTIFIERS",
      "--- RAW RUN OUTPUT BELOW ---",
    ].join("\n");
    const cmd = await captureCodexLaunchCommand(
      "codex-test-runner-pane",
      `---\nauto-exit: true\ncli: codex\nsystem-prompt: append\n---\n${body}`,
    );
    for (const marker of ["COMMAND:", "EXIT_CODE:", "END_FAILING_IDENTIFIERS", "RAW RUN OUTPUT BELOW"]) {
      assert.ok(cmd.includes(marker), `pane command must include artifact marker ${JSON.stringify(marker)}; got: ${cmd}`);
    }
  });
});
