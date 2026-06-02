import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv,
  PI_TIMEOUT, SLOW_LANE_OPT_IN,
  type TestEnv,
} from "./harness.ts";
import { __test__ as subagentsTestHooks } from "../../src/index.ts";
import { runSerial } from "../../src/orchestration/run-serial.ts";
import { runParallel } from "../../src/orchestration/run-parallel.ts";
import { makeDefaultDeps } from "../../src/orchestration/default-deps.ts";

const CODEX_AVAILABLE = (() => {
  try { execSync("which codex", { stdio: "pipe" }); return true; }
  catch { return false; }
})();
const backends = getAvailableBackends();
const SHOULD_SKIP = !CODEX_AVAILABLE || backends.length === 0 || !SLOW_LANE_OPT_IN;
if (SHOULD_SKIP) {
  console.log(
    `⚠️  orchestration-codex-pane skipped: CODEX=${CODEX_AVAILABLE} BACKENDS=${backends.length} SLOW=${SLOW_LANE_OPT_IN}`,
  );
}

async function waitForRunningSubagent(
  predicate: (r: { name: string; surface?: string; backend: string }) => boolean,
  timeoutMs: number,
): Promise<{ surface: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const r of subagentsTestHooks.getRunningSubagents().values()) {
      if (r.backend === "pane" && r.surface && predicate(r)) {
        return { surface: r.surface };
      }
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error("no matching RunningSubagent appeared within timeout");
}

for (const backend of backends) {
  describe(`orchestration-codex-pane-serial [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    it("runSerial with 2 cli=codex tasks: each reaches completed state with exitCode 0", async () => {
      const deps = makeDefaultDeps({
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => env.dir,
        } as any,
        cwd: env.dir,
      });

      const driver = (async () => {
        const { surface } = await waitForRunningSubagent(
          (r) => r.name === "codex-serial-1",
          20_000,
        );
        env.surfaces.push(surface);
      })();

      const out = await runSerial(
        [
          {
            name: "codex-serial-1",
            agent: "test-codex-interactive",
            task: "Reply with exactly: CODEX_SERIAL_1. Then call subagent_done with message='CODEX_SERIAL_1'.",
            cli: "codex",
          },
          {
            name: "codex-serial-2",
            agent: "test-codex-interactive",
            task: "Reply with exactly: CODEX_SERIAL_2. Then call subagent_done with message='CODEX_SERIAL_2'.",
            cli: "codex",
          },
        ],
        {},
        deps,
      );
      await driver;

      assert.equal(out.results.length, 2, "expected 2 task results");
      assert.equal(out.isError, false, "aggregated result must not be error (steer-back fired cleanly)");

      const r1 = out.results[0];
      const r2 = out.results[1];
      assert.equal(r1.state, "completed", `task 1 state must be 'completed', got: ${r1.state}`);
      assert.equal(r1.exitCode, 0, `task 1 exitCode must be 0, got: ${r1.exitCode}`);
      assert.equal(r2.state, "completed", `task 2 state must be 'completed', got: ${r2.state}`);
      assert.equal(r2.exitCode, 0, `task 2 exitCode must be 0, got: ${r2.exitCode}`);
    });
  });

  describe(`orchestration-codex-pane-parallel [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    it("runParallel with 2 cli=codex tasks: each reaches completed state with exitCode 0", async () => {
      const deps = makeDefaultDeps({
        sessionManager: {
          getSessionFile: () => join(env.dir, "session-parallel.jsonl"),
          getSessionId: () => "parent-parallel",
          getSessionDir: () => env.dir,
        } as any,
        cwd: env.dir,
      });

      const driveOne = async (childName: "codex-para-alpha" | "codex-para-beta") => {
        const start = Date.now();
        let surface: string | undefined;
        while (Date.now() - start < 30_000) {
          for (const r of subagentsTestHooks.getRunningSubagents().values()) {
            if (r.backend === "pane" && r.surface && r.name === childName) {
              surface = r.surface;
              break;
            }
          }
          if (surface) break;
          await new Promise((res) => setTimeout(res, 200));
        }
        if (!surface) throw new Error(`no surface found for ${childName}`);
        env.surfaces.push(surface);
      };
      const driver = Promise.all([driveOne("codex-para-alpha"), driveOne("codex-para-beta")]);

      const out = await runParallel(
        [
          {
            name: "codex-para-alpha",
            agent: "test-codex-interactive",
            task: "Reply with exactly: CODEX_PARA_ALPHA. Then call subagent_done with message='CODEX_PARA_ALPHA'.",
            cli: "codex",
          },
          {
            name: "codex-para-beta",
            agent: "test-codex-interactive",
            task: "Reply with exactly: CODEX_PARA_BETA. Then call subagent_done with message='CODEX_PARA_BETA'.",
            cli: "codex",
          },
        ],
        {},
        deps,
      );
      await driver;

      assert.equal(out.results.length, 2, "expected 2 task results");
      assert.equal(out.isError, false, "aggregated result must not be error (steer-back fired cleanly)");

      const byName = Object.fromEntries(out.results.map((r) => [r.name, r]));
      for (const name of ["codex-para-alpha", "codex-para-beta"] as const) {
        const r = byName[name];
        assert.ok(r, `result for ${name} must exist`);
        assert.equal(r.state, "completed", `${name} state must be 'completed', got: ${r.state}`);
        assert.equal(r.exitCode, 0, `${name} exitCode must be 0, got: ${r.exitCode}`);
      }
    });
  });
}
