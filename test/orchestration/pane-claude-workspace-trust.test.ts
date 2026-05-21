import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCmdParts } from "../../src/index.ts";

/**
 * Workspace-trust bypass for pane-spawned Claude subagents.
 *
 * Background: Claude shows an interactive "Quick safety check: Is this a project
 * you trust?" dialog the first time it starts in a directory whose absolute
 * path is not already marked `hasTrustDialogAccepted: true` in `~/.claude.json`
 * (or whose ancestor isn't). `--dangerously-skip-permissions` bypasses tool
 * permission checks but does NOT bypass the trust dialog. The headless Claude
 * backend dodges it by running with `-p` (per the CLI's `--print` documentation:
 * "The workspace trust dialog is skipped when Claude is run in non-interactive
 * mode (via -p, or when stdout is not a TTY)").
 *
 * The pane backend cannot use `-p` — it's an interactive REPL. Without a
 * symmetric bypass, pi-spawned Claude pane subagents in fresh directories
 * (notably integration-test temp dirs from `mkdtempSync`) stall on the trust
 * dialog: the driver waits for a question marker that never appears because
 * the dialog is on screen, then times out.
 *
 * The Claude binary's `checkHasTrustDialogAccepted` short-circuits to `true`
 * when `CLAUDE_CODE_SANDBOXED` is set (verified by inspecting the v2.1.143
 * binary: `if(xH(process.env.CLAUDE_CODE_SANDBOXED)) return true`). We export
 * that env var in the pane launch prefix so pi-spawned pane subagents behave
 * symmetrically to the headless `-p` path: the conversation we already
 * authorize via `--dangerously-skip-permissions` is also treated as a trusted
 * workspace.
 */

function findEnvAssignment(parts: string[], name: string): string | null {
  // The launch prefix consists of bare `KEY=value` tokens that precede the
  // `claude` binary name. shellEscape wraps the value in quotes for sentinel
  // paths; the literal `CLAUDE_CODE_SANDBOXED=1` value is shell-safe so we
  // accept both quoted and unquoted forms.
  const claudeIdx = parts.indexOf("claude");
  if (claudeIdx < 0) return null;
  for (let i = 0; i < claudeIdx; i++) {
    const tok = parts[i];
    if (tok.startsWith(`${name}=`)) {
      return tok.slice(name.length + 1).replace(/^'|'$/g, "");
    }
  }
  return null;
}

describe("buildClaudeCmdParts injects CLAUDE_CODE_SANDBOXED=1 to bypass workspace trust", () => {
  it("emits CLAUDE_CODE_SANDBOXED=1 as a launch env var so pane Claude bypasses the trust dialog", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/sentinel-trust-1",
      pluginDir: "/tmp/plugin",
      model: "sonnet",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do something",
    });
    const value = findEnvAssignment(parts, "CLAUDE_CODE_SANDBOXED");
    assert.equal(
      value,
      "1",
      "expected CLAUDE_CODE_SANDBOXED=1 to be emitted before `claude` so the workspace trust dialog is auto-accepted",
    );
  });

  it("keeps the trust env var ordered before the claude binary (env-prefix contract)", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/sentinel-trust-2",
      pluginDir: undefined,
      model: undefined,
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do",
    });
    const sandboxIdx = parts.findIndex((p) => p.startsWith("CLAUDE_CODE_SANDBOXED="));
    const claudeIdx = parts.indexOf("claude");
    assert.ok(sandboxIdx >= 0, "CLAUDE_CODE_SANDBOXED env var must be emitted");
    assert.ok(claudeIdx >= 0, "claude binary token must be present");
    assert.ok(
      sandboxIdx < claudeIdx,
      `CLAUDE_CODE_SANDBOXED must precede the claude binary so the shell exports it for that process; got sandboxIdx=${sandboxIdx}, claudeIdx=${claudeIdx}`,
    );
  });
});
