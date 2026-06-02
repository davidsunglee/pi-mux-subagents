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
    let configSnapshotBefore: Buffer | null;

    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
      // Snapshot the persistent Codex config (or record its absence) before launching
      configSnapshotBefore = existsSync(CODEX_CONFIG_PATH)
        ? readFileSync(CODEX_CONFIG_PATH)
        : null;
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

    it("pane subagent completes via subagent_done and leaves ~/.codex/config.toml unchanged", async () => {
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

      // Assert the persistent Codex config is byte-identical (or still absent)
      if (configSnapshotBefore === null) {
        assert.equal(
          existsSync(CODEX_CONFIG_PATH),
          false,
          `~/.codex/config.toml must remain absent after the run (pi-mux-subagents must never write it)`,
        );
      } else {
        assert.ok(existsSync(CODEX_CONFIG_PATH), "~/.codex/config.toml must still exist after the run");
        const configAfter = readFileSync(CODEX_CONFIG_PATH);
        assert.ok(
          configSnapshotBefore.equals(configAfter),
          "~/.codex/config.toml must be byte-identical after the run (pi-mux-subagents must never mutate it)",
        );
      }
    });
  });
}
