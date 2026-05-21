import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { join } from "node:path";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv,
  PI_TIMEOUT, SLOW_LANE_OPT_IN,
  type TestEnv,
} from "./harness.ts";
import { runSerial } from "../../src/orchestration/run-serial.ts";
import { makeDefaultDeps } from "../../src/orchestration/default-deps.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();
const PLUGIN_BUILT = existsSync(
  join(new URL("../../src/claude-plugin", import.meta.url).pathname, "mcp", "server.js"),
);
const backends = getAvailableBackends();
const SHOULD_SKIP = !CLAUDE_AVAILABLE || !PLUGIN_BUILT || backends.length === 0 || !SLOW_LANE_OPT_IN;
if (SHOULD_SKIP) {
  console.log(`⚠️  orchestration-claude-pane-spec-designer-e2e skipped: CLAUDE=${CLAUDE_AVAILABLE} PLUGIN_BUILT=${PLUGIN_BUILT} BACKENDS=${backends.length} SLOW=${SLOW_LANE_OPT_IN}`);
}

for (const backend of backends) {
  describe(`orchestration-claude-pane-spec-designer-e2e [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 4 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    it("spec-designer existing-spec-branch emits absolute SPEC_ARTIFACT marker for relative input path", async () => {
      // Canonicalize env.dir: on macOS, `mkdtempSync` returns paths under
      // `/var/folders/...` but `/var` is a symlink to `/private/var`, so
      // Claude's resolved cwd reports `/private/var/folders/...`. The model
      // emits its SPEC_ARTIFACT marker using the resolved cwd path, not the
      // symlink we passed via `cd`. Without realpath here, the expected
      // absolute path string never matches the model's emission even though
      // the marker is correct on both sides.
      const WORKING_DIR = realpathSync(env.dir);
      const RELATIVE_SPEC_PATH = 'docs/specs/test-relative-input-fixture.md';
      const EXPECTED_ABS_PATH = path.resolve(WORKING_DIR, RELATIVE_SPEC_PATH);

      fs.mkdirSync(path.dirname(EXPECTED_ABS_PATH), { recursive: true });
      fs.writeFileSync(EXPECTED_ABS_PATH, '# Test Spec\n\nFixture for relative-input absolute-marker e2e test.\n');

      const deps = makeDefaultDeps({
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => env.dir,
        } as any,
        cwd: WORKING_DIR,
      });

      try {
        const taskPrompt =
          `Open the existing spec at the relative path "${RELATIVE_SPEC_PATH}" (relative to your current working directory). ` +
          `Add a "## Notes" section to its end containing a single line "Updated by relative-input e2e test." ` +
          `Then emit your SPEC_ARTIFACT marker per the spec-design procedure (Step 9 / subagent branch), ` +
          `which mandates the marker line carries the absolute path of the written file even when the input path was relative. ` +
          `As your terminal tool action, call subagent_done with the SPEC_ARTIFACT marker line as the message argument.`;

        const out = await runSerial(
          [{
            name: "spec-designer",
            agent: "test-claude-spec-designer", cli: "claude",
            task: taskPrompt,
          }],
          {},
          deps,
        );

        assert.equal(out.results.length, 1);
        assert.equal(out.isError, false);
        const r = out.results[0];

        assert.match(r.finalMessage, /SPEC_ARTIFACT: \/[^\n]*\/docs\/specs\/test-relative-input-fixture\.md\b/);
        assert.ok(r.finalMessage.includes(`SPEC_ARTIFACT: ${EXPECTED_ABS_PATH}`), 'final message must contain marker with the absolute fixture path');
        assert.ok(!/SPEC_ARTIFACT: docs\/specs\//.test(r.finalMessage), 'final message must not contain a relative-path SPEC_ARTIFACT marker');
      } finally {
        fs.rmSync(EXPECTED_ABS_PATH, { force: true });
      }
    });
  });
}
