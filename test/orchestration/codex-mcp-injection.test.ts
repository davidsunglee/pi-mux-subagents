import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCodexMcpOverrideArgs, resolveCodexMcpServerPath } from "../../src/backends/codex-mcp.ts";

describe("buildCodexMcpOverrideArgs", () => {
  it("returns exactly six tokens with three -c flags interleaved with mcp_servers.pi_subagent overrides", () => {
    const args = buildCodexMcpOverrideArgs({ sentinelFile: "/tmp/s" });
    assert.equal(args.length, 6, "expected exactly 6 tokens");
    assert.equal(args[0], "-c");
    assert.equal(args[1], 'mcp_servers.pi_subagent.command="node"');
    assert.equal(args[2], "-c");
    assert.match(args[3], /^mcp_servers\.pi_subagent\.args=\[".+server\.js"\]$/);
    assert.equal(args[4], "-c");
    assert.equal(args[5], 'mcp_servers.pi_subagent.env.PI_SUBAGENT_DONE_SENTINEL="/tmp/s"');
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
