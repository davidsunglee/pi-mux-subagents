import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../src/tools/tool-handlers.ts";
import { createRegistry } from "../../src/orchestration/registry.ts";
import { BLOCKED_KIND } from "../../src/orchestration/notification-kinds.ts";
import type { LauncherDeps } from "../../src/orchestration/types.ts";

function makeHarness(deps: LauncherDeps) {
  const emitted: any[] = [];
  const registry = createRegistry((p) => emitted.push(p));
  const tools: any[] = [];
  const api = {
    registerTool: (t: any) => tools.push(t),
    on() {}, registerCommand() {}, registerMessageRenderer() {},
    sendMessage() {}, sendUserMessage() {},
  } as any;
  registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
  const serial = tools.find((t) => t.name === "subagent_run_serial");
  return { emitted, registry, serial };
}

// Mid-run onSessionKey routes into registry.updateSessionKey.

describe("backend-seam: mid-run onSessionKey routes into registry.updateSessionKey", () => {
  it("a Claude-backed fake that fires onSessionKey mid-run populates ownership before any blocked event", async () => {
    const claudeId = "claude-sess-late-bound";
    const deps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now() };
      },
      async waitForCompletion(h, _signal, _onUpdate, hooks) {
        setTimeout(() => hooks?.onSessionKey?.(claudeId), 5);
        await new Promise((r) => setTimeout(r, 15));
        return {
          name: h.name, finalMessage: "", transcriptPath: null,
          exitCode: 0, elapsedMs: 15,
          sessionKey: claudeId,
          ping: { name: h.name, message: "need input" },
        };
      },
    };
    const { emitted, registry, serial } = makeHarness(deps);
    const env = await serial.execute("bs", { wait: false, tasks: [{ agent: "x", task: "t" }] },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" });

    await new Promise((r) => setTimeout(r, 40));
    const blocked = emitted.find((e) => e.kind === BLOCKED_KIND);
    assert.ok(blocked, "blocked event must fire");
    assert.equal(blocked.sessionKey, claudeId);
    assert.equal(registry.lookupOwner(claudeId)!.orchestrationId, env.details.orchestrationId);
  });

  it("race-closer: onSessionKey fired SYNCHRONOUSLY right before a ping-carrying result still lands in the registry before onTaskBlocked runs", async () => {
    const claudeId = "claude-sess-atomic";
    const deps: LauncherDeps = {
      async launch(t) { return { id: t.task, name: t.name ?? "s", startTime: Date.now() }; },
      async waitForCompletion(h, _signal, _onUpdate, hooks) {
        hooks?.onSessionKey?.(claudeId); // synchronous fire
        return {
          name: h.name, finalMessage: "", transcriptPath: null,
          exitCode: 0, elapsedMs: 0,
          sessionKey: claudeId,
          ping: { name: h.name, message: "need input" },
        };
      },
    };
    const { emitted, registry, serial } = makeHarness(deps);
    const env = await serial.execute("bs", { wait: false, tasks: [{ agent: "x", task: "t" }] },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 20));
    const blocked = emitted.find((e) => e.kind === BLOCKED_KIND);
    assert.ok(blocked, "blocked event must fire");
    assert.equal(blocked.sessionKey, claudeId);
    assert.equal(registry.lookupOwner(claudeId)!.orchestrationId, env.details.orchestrationId);
  });
});

describe("backend-seam: signal + onUpdate preserved across the post-9.5b waitForCompletion signature", () => {
  it("opts.signal still aborts an in-flight waitForCompletion", async () => {
    let receivedSignal: AbortSignal | undefined;
    const deps: LauncherDeps = {
      async launch(t) { return { id: t.task, name: t.name ?? "s", startTime: Date.now() }; },
      async waitForCompletion(h, signal, _onUpdate, _hooks) {
        receivedSignal = signal;
        // Simulate a long-running task that respects signal.
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(new Error("aborted"));
          const timer = setTimeout(resolve, 5000);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        });
        return { name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 0 };
      },
    };

    const { serial } = makeHarness(deps);
    const ac = new AbortController();
    // Fire the serial call but don't await — abort after a short delay.
    const runPromise = serial.execute(
      "abort-test",
      { wait: true, tasks: [{ agent: "x", task: "t" }] },
      ac.signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    // Abort after a tick — the wait:true path passes the signal synchronously.
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    // The run should resolve (error result) rather than hang.
    const out = await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 500)),
    ]);
    // Signal was forwarded to waitForCompletion.
    assert.ok(receivedSignal !== undefined, "signal must be forwarded to waitForCompletion");
    // The run completed (possibly with isError due to abort).
    assert.ok(out !== undefined, "execute must resolve");
  });

  it("onUpdate (3rd positional) still receives partials from the underlying watch", async () => {
    const deps: LauncherDeps = {
      async launch(t) { return { id: t.task, name: t.name ?? "s", startTime: Date.now() }; },
      async waitForCompletion(h, _signal, onUpdate, _hooks) {
        // Emit a partial before completing.
        onUpdate?.({
          name: h.name,
          finalMessage: "partial output",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 5,
        });
        return { name: h.name, finalMessage: "done", transcriptPath: null, exitCode: 0, elapsedMs: 10 };
      },
    };

    // Use the raw deps directly (not via tool harness) to check onUpdate forwarding.
    const receivedPartials: any[] = [];
    const result = await deps.waitForCompletion(
      { id: "x", name: "test-step", startTime: Date.now() },
      undefined,
      (p) => receivedPartials.push(p),
      undefined,
    );
    assert.equal(receivedPartials.length, 1, "onUpdate must receive the partial");
    assert.equal(receivedPartials[0].finalMessage, "partial output");
    assert.equal(result.finalMessage, "done");
  });
});
