// Slow real-backend headless block/resume coverage. Resume requires a mux,
// and the test cancels in finally so failures do not leave orphaned children.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  copyTestAgents,
  getAvailableBackends,
  BLOCK_WAIT_MS,
  PI_TIMEOUT,
  SLOW_LANE_OPT_IN,
  waitForSentMessage,
  summarizeSentMessages,
  tryCancelOrchestration,
} from "./harness.ts";
import subagentsExtension, { __test__ as subagentsTest } from "../../src/index.ts";
import {
  BLOCKED_KIND, ORCHESTRATION_COMPLETE_KIND,
} from "../../src/orchestration/notification-kinds.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
const backends = getAvailableBackends();
// Resume requires a mux backend — skip if no mux available.
// Also skip unless the slow lane is opted into (real-backend suite).
const SHOULD_SKIP = !PI_AVAILABLE || backends.length === 0 || !SLOW_LANE_OPT_IN;

function makeFakePi() {
  const tools = new Map<string, any>();
  const sentMessages: Array<{ message: any; opts?: any }> = [];
  return {
    tools, sentMessages,
    api: {
      registerTool(spec: any) { tools.set(spec.name, spec); },
      registerCommand() {},
      registerMessageRenderer() {},
      sendUserMessage() {},
      sendMessage(message: any, opts?: any) { sentMessages.push({ message, opts }); },
      on() {},
    },
  };
}

describe("orchestration-headless-block-backend", {
  skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 2,
}, () => {
  let prevMode: string | undefined;
  let dir: string;

  before(() => {
    prevMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-integ-headless-block-"));
    copyTestAgents(dir);
    subagentsTest.resetRegistry();
  });

  after(() => {
    if (prevMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = prevMode;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    subagentsTest.resetRegistry();
  });

  it("headless: caller_ping from real child → BLOCKED → subagent_resume (pane) → ORCHESTRATION_COMPLETE", async () => {
    const fake = makeFakePi();
    subagentsExtension(fake.api as any);

    const serial = fake.tools.get("subagent_run_serial");
    const resume = fake.tools.get("subagent_resume");
    const cancelTool = fake.tools.get("subagent_run_cancel");
    assert.ok(serial, "subagent_run_serial must be registered");
    assert.ok(resume, "subagent_resume must be registered");
    assert.ok(cancelTool, "subagent_run_cancel must be registered");

    const sessionFile = join(dir, "session.jsonl");
    const ctx = {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "headless-block-session",
        getSessionDir: () => dir,
      },
      cwd: dir,
    };

    let orchestrationId: string | undefined;
    try {
      const envelope = await serial.execute(
        "headless-block",
        { wait: false, tasks: [{ name: "h1", agent: "test-ping-resumable", task: "hello-headless" }] },
        new AbortController().signal,
        () => {},
        ctx,
      );
      orchestrationId = envelope.details.orchestrationId;
      assert.ok(orchestrationId, "orchestrationId must be present");

      // Wait for the BLOCKED_KIND steer-back from the headless ping sidecar.
      const blocked = await waitForSentMessage(fake.sentMessages, BLOCKED_KIND, BLOCK_WAIT_MS);
      if (!blocked) {
        assert.fail(
          `expected BLOCKED sendMessage within ${BLOCK_WAIT_MS}ms ` +
          `(orchestrationId=${orchestrationId}). ` +
          `Sent messages: ${summarizeSentMessages(fake.sentMessages)}`,
        );
      }

      const sessionKey = blocked!.message.details.sessionKey;
      assert.ok(sessionKey, "sessionKey must be present in blocked details");

      // Verify the session file exists on disk
      assert.ok(existsSync(sessionKey), `sessionKey path must exist on disk: ${sessionKey}`);

      // The ping sidecar should be removed after propagation.
      assert.equal(existsSync(sessionKey + ".exit"), false,
        "the .exit sidecar file must have been cleaned up after ping propagation");

      // Now resume via the pane backend (resume tool requires mux)
      await resume.execute(
        "headless-resume",
        { sessionPath: sessionKey, message: "please finish" },
        new AbortController().signal,
        () => {},
        ctx,
      );

      // Wait for ORCHESTRATION_COMPLETE_KIND
      const complete = await waitForSentMessage(fake.sentMessages, ORCHESTRATION_COMPLETE_KIND, BLOCK_WAIT_MS);
      if (!complete) {
        assert.fail(
          `expected orchestration_complete within ${BLOCK_WAIT_MS}ms after resume ` +
          `(orchestrationId=${orchestrationId}, sessionKey=${sessionKey}). ` +
          `Sent messages: ${summarizeSentMessages(fake.sentMessages)}`,
        );
      }
      assert.equal(complete!.message.details.results[0].state, "completed",
        `task 0 should be completed, got: ${complete!.message.details.results[0].state}`);
    } finally {
      // Deterministic teardown: cancel on any path (pass or fail) so a stuck
      // test doesn't leave the registry holding live children.
      await tryCancelOrchestration(cancelTool, orchestrationId, ctx);
    }
  });
});
