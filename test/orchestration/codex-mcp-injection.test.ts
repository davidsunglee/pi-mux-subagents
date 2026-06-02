import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCodexMcpOverrideArgs, resolveCodexMcpServerPath } from "../../src/backends/codex-mcp.ts";

describe("buildCodexMcpOverrideArgs", () => {
  it("returns exactly eight tokens with four -c flags interleaved with mcp_servers.pi_subagent overrides", () => {
    const args = buildCodexMcpOverrideArgs({ sentinelFile: "/tmp/s" });
    assert.equal(args.length, 8, "expected exactly 8 tokens");
    assert.equal(args[0], "-c");
    assert.equal(args[1], 'mcp_servers.pi_subagent.command="node"');
    assert.equal(args[2], "-c");
    assert.match(args[3], /^mcp_servers\.pi_subagent\.args=\[".+server\.js"\]$/);
    assert.equal(args[4], "-c");
    assert.equal(args[5], 'mcp_servers.pi_subagent.env.PI_SUBAGENT_DONE_SENTINEL="/tmp/s"');
    assert.equal(args[6], "-c");
    assert.equal(args[7], 'mcp_servers.pi_subagent.tools.subagent_done.approval_mode="approve"');
  });

  it("auto-approves only the subagent_done completion tool (preserving guarded approval for everything else)", () => {
    // The internal completion tool MUST run without human approval so the pane
    // watcher receives the sentinel in unattended runs. The override is scoped
    // to mcp_servers.pi_subagent.tools.subagent_done — it does NOT relax the
    // top-level sandbox/approval policy for shell commands or other tools.
    const args = buildCodexMcpOverrideArgs({ sentinelFile: "/tmp/s" });
    const joined = args.join(" ");
    assert.ok(
      joined.includes('mcp_servers.pi_subagent.tools.subagent_done.approval_mode="approve"'),
      `expected subagent_done auto-approval override; got: ${joined}`,
    );
    // Must not blanket-approve the whole server or the global approval policy.
    assert.ok(
      !/mcp_servers\.pi_subagent\.approval_mode/.test(joined),
      `must not set a server-wide approval_mode; got: ${joined}`,
    );
    assert.ok(
      !/^approval_policy|[^.]approval_policy/.test(joined),
      `must not override the global approval_policy; got: ${joined}`,
    );
  });

  it("uses a custom serverPath when provided", () => {
    const args = buildCodexMcpOverrideArgs({ sentinelFile: "/tmp/done", serverPath: "/custom/server.js" });
    assert.equal(args[3], 'mcp_servers.pi_subagent.args=["/custom/server.js"]');
  });

  it("uses the resolved server path when no serverPath is provided", () => {
    const args = buildCodexMcpOverrideArgs({ sentinelFile: "/tmp/s" });
    assert.match(args[3], /claude-plugin\/mcp\/server\.js/);
  });
});

describe("resolveCodexMcpServerPath", () => {
  it("ends with claude-plugin/mcp/server.js", () => {
    const p = resolveCodexMcpServerPath();
    assert.ok(
      p.endsWith("claude-plugin/mcp/server.js"),
      `expected path to end with claude-plugin/mcp/server.js, got: ${p}`,
    );
  });
});
