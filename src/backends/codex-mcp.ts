import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_COMPLETION_SERVER_NAME = "pi_subagent"; // TOML key segment: [a-z0-9_]
export const CODEX_SENTINEL_ENV = "PI_SUBAGENT_DONE_SENTINEL";

export function resolveCodexMcpServerPath(): string {
  // src/backends/codex-mcp.ts -> src/claude-plugin/mcp/server.js
  return join(dirname(fileURLToPath(import.meta.url)), "..", "claude-plugin", "mcp", "server.js");
}

// Returns RAW `-c key=value` tokens (no shell escaping). The pane caller
// shell-escapes each token. The value portion is parsed by Codex as TOML.
export function buildCodexMcpOverrideArgs(input: { sentinelFile: string; serverPath?: string }): string[] {
  const name = CODEX_COMPLETION_SERVER_NAME;
  const serverPath = input.serverPath ?? resolveCodexMcpServerPath();
  return [
    "-c", `mcp_servers.${name}.command="node"`,
    "-c", `mcp_servers.${name}.args=["${serverPath}"]`,
    "-c", `mcp_servers.${name}.env.${CODEX_SENTINEL_ENV}="${input.sentinelFile}"`,
    // Auto-approve ONLY the internal completion tool. Guarded pane mode runs with
    // `--ask-for-approval on-request`, so without this the unattended pane has no
    // human to approve the `subagent_done` MCP call — Codex cancels it ("user
    // cancelled MCP tool call") and the sentinel is never written, hanging the
    // watcher. Scoping the override to tools.subagent_done.approval_mode="approve"
    // (a recognized Codex field; variants: auto|prompt|approve) lets only the
    // completion tool run unattended while every shell command / other tool keeps
    // the guarded sandbox + approval policy. (Verified against Codex CLI 0.136.0.)
    "-c", `mcp_servers.${name}.tools.subagent_done.approval_mode="approve"`,
  ];
}
