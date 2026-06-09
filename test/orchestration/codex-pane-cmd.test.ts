import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCodexPaneCmdParts } from "../../src/index.ts";
import { buildCodexMcpOverrideArgs } from "../../src/backends/codex-mcp.ts";

describe("buildCodexPaneCmdParts (pane Codex command)", () => {
  it("builds a guarded interactive command with policy flags, MCP overrides, and prompt after --", () => {
    const mcpOverrideArgs = buildCodexMcpOverrideArgs({ sentinelFile: "/tmp/pi-codex-abc-done" });
    const parts = buildCodexPaneCmdParts({
      model: "gpt-5.4-mini",
      effectiveThinking: "high",
      executionPolicy: "guarded",
      mcpOverrideArgs,
      task: "do the thing",
      cwd: "/private/tmp/pi-integ-xyz",
    });
    const joined = parts.join(" ");

    // Per-launch project trust override for the cwd (avoids the interactive prompt).
    assert.ok(
      joined.includes('projects={"/private/tmp/pi-integ-xyz"={trust_level="trusted"}}'),
      `expected project trust override for cwd; got: ${joined}`,
    );

    // Policy flags (guarded pane).
    assert.ok(joined.includes("--sandbox"), `expected --sandbox; got: ${joined}`);
    assert.ok(joined.includes("workspace-write"), `expected workspace-write; got: ${joined}`);
    assert.ok(joined.includes("--ask-for-approval"), `expected --ask-for-approval; got: ${joined}`);
    assert.ok(joined.includes("on-request"), `expected on-request; got: ${joined}`);

    // MCP completion-server overrides (the three -c tokens).
    assert.ok(joined.includes("mcp_servers.pi_subagent.command"), `expected command override; got: ${joined}`);
    assert.ok(joined.includes("mcp_servers.pi_subagent.args"), `expected args override; got: ${joined}`);
    assert.ok(joined.includes("mcp_servers.pi_subagent.env"), `expected env override; got: ${joined}`);

    // Prompt appears after the `--` separator.
    const sepIndex = parts.indexOf("--");
    assert.ok(sepIndex !== -1, `expected a -- separator; got: ${joined}`);
    const afterSep = parts.slice(sepIndex + 1).join(" ");
    assert.ok(afterSep.includes("do the thing"), `expected prompt after --; got: ${afterSep}`);
  });

  it("builds an unrestricted command with the bypass flag and no --sandbox", () => {
    const parts = buildCodexPaneCmdParts({
      executionPolicy: "unrestricted",
      mcpOverrideArgs: buildCodexMcpOverrideArgs({ sentinelFile: "/tmp/s" }),
      task: "go",
    });
    const joined = parts.join(" ");
    assert.ok(
      joined.includes("--dangerously-bypass-approvals-and-sandbox"),
      `expected bypass flag; got: ${joined}`,
    );
    assert.ok(!joined.includes("--sandbox"), `expected no --sandbox in unrestricted; got: ${joined}`);
  });
});
