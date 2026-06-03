import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv,
  PI_TIMEOUT, SLOW_LANE_OPT_IN,
  type TestEnv,
} from "./harness.ts";
import { launchSubagent, watchSubagent } from "../../src/index.ts";

const CODEX_AVAILABLE = (() => {
  try { execSync("which codex", { stdio: "pipe" }); return true; }
  catch { return false; }
})();
const backends = getAvailableBackends();
const SHOULD_SKIP = !CODEX_AVAILABLE || backends.length === 0 || !SLOW_LANE_OPT_IN;
if (SHOULD_SKIP) {
  console.log(
    `⚠️  pane-codex-interactive skipped: CODEX=${CODEX_AVAILABLE} BACKENDS=${backends.length} SLOW=${SLOW_LANE_OPT_IN}`,
  );
}

const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

for (const backend of backends) {
  describe(`pane-codex-interactive [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 2 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;

    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
    });

    after(() => {
      cleanupTestEnv(env);
      restoreBackend(prevMux);
    });

    function ctx() {
      return {
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "test-session",
          getSessionDir: () => env.dir,
        },
        cwd: env.dir,
      };
    }

    it("pane subagent completes via subagent_done without persisting pi-mux Codex config", async () => {
      const running = await launchSubagent(
        {
          name: "codex-auto",
          cli: "codex",
          task: "Reply with exactly: CODEX_PANE_OK. Then call subagent_done with message='CODEX_PANE_OK'.",
        },
        ctx(),
      );
      env.surfaces.push(running.surface);

      const result = await watchSubagent(running, new AbortController().signal);

      assert.equal(
        result.exitCode,
        0,
        `exitCode must be 0; error=${result.error}; summary=${result.summary}`,
      );
      assert.ok(result.summary && result.summary.length > 0, "summary must be non-empty");

      // pi-mux-subagents applies its Codex configuration (MCP completion server,
      // policy, model, thinking) exclusively through per-launch `-c` overrides and
      // must never persist any of it to ~/.codex/config.toml. We do NOT require the
      // file to be byte-identical: Codex itself may update unrelated project-trust
      // metadata (e.g. a [projects."..."] entry) as a side effect, which is fine.
      // What must never appear is pi-mux's own injected MCP/sentinel config.
      if (existsSync(CODEX_CONFIG_PATH)) {
        const configAfter = readFileSync(CODEX_CONFIG_PATH, "utf8");
        assert.ok(
          !configAfter.includes("mcp_servers.pi_subagent") && !configAfter.includes("[mcp_servers.pi_subagent]"),
          "pi-mux MCP server config (pi_subagent) must not leak into ~/.codex/config.toml",
        );
        assert.ok(
          !configAfter.includes("PI_SUBAGENT_DONE_SENTINEL"),
          "pi-mux completion sentinel env must not leak into ~/.codex/config.toml",
        );
        assert.ok(
          !configAfter.includes("pi-codex-") && !configAfter.includes("subagent_done"),
          "pi-mux sentinel path / subagent_done config must not leak into ~/.codex/config.toml",
        );
      }
    });
  });
}
