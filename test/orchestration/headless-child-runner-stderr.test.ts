import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { BackendResult } from "../../src/backends/types.ts";

const ctx = {
  sessionManager: {
    getSessionFile: () => "/tmp/parent.jsonl",
    getSessionId: () => "parent",
    getSessionDir: () => "/tmp",
  } as any,
  cwd: "/tmp",
};

describe("headless child-runner stderr diagnostics preserved (non-migrated)", () => {
  let backendModule: any;
  let lastFakeProc: any;

  function makeFakeProc() {
    const ee = new EventEmitter() as any;
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.killed = false;
    ee.kill = () => true;
    ee._send = (line: string) => ee.stdout.emit("data", Buffer.from(line + "\n"));
    ee._close = (code: number) => { ee.emit("exit", code); ee.emit("close", code); };
    lastFakeProc = ee;
    return ee;
  }

  before(async () => {
    backendModule = await import("../../src/backends/headless.ts");
    backendModule.__test__.setSpawn(() => makeFakeProc());
  });
  after(() => backendModule.__test__.restoreSpawn());

  it("a clean claude stream with no system/init event writes the shortened raw stderr warning byte-for-byte", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    let stderr = "";
    (process.stderr as any).write = (c: any) => { stderr += typeof c === "string" ? c : c.toString(); return true; };
    try {
      const backend = backendModule.makeHeadlessBackend(ctx);
      const handle = await backend.launch({ name: "diag", task: "t", cli: "claude" } as any, false);
      await new Promise((r) => setImmediate(r));
      const watchPromise = backend.watch(handle);
      await new Promise((r) => setImmediate(r));

      // Terminal `result` event but NO `system`/`init` event: sessionId stays
      // null, so the close handler hits the non-migrated warning (headless.ts:677).
      lastFakeProc._send(JSON.stringify({
        type: "result", subtype: "success", result: "OK",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        total_cost_usd: 0, num_turns: 1,
      }));
      await new Promise((r) => setImmediate(r));
      lastFakeProc._close(0);
      const result: BackendResult = await watchPromise;

      assert.equal(result.exitCode, 0, `clean close expected; error=${result.error}`);
      assert.equal(result.transcriptPath, null, "no sessionId -> transcriptPath stays null");
      assert.ok(
        stderr.includes(
          "[subagents] diag: no Claude session id; transcript not saved\n",
        ),
        `expected the shortened raw stderr warning; got ${JSON.stringify(stderr)}`,
      );
    } finally {
      (process.stderr as any).write = orig;
    }
  });

  it("a missing Claude archive file uses a short transcript warning", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    let stderr = "";
    (process.stderr as any).write = (c: any) => { stderr += typeof c === "string" ? c : c.toString(); return true; };
    const sessionId = `pi-test-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const backend = backendModule.makeHeadlessBackend(ctx);
      const handle = await backend.launch({ name: "archive", task: "t", cli: "claude" } as any, false);
      await new Promise((r) => setImmediate(r));
      const watchPromise = backend.watch(handle);
      await new Promise((r) => setImmediate(r));

      lastFakeProc._send(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
      lastFakeProc._send(JSON.stringify({
        type: "result", subtype: "success", result: "OK",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        total_cost_usd: 0, num_turns: 1,
      }));
      await new Promise((r) => setImmediate(r));
      lastFakeProc._close(0);
      const result: BackendResult = await watchPromise;

      assert.equal(result.exitCode, 0, `clean close expected; error=${result.error}`);
      assert.equal(result.transcriptPath, null, "missing archive -> transcriptPath stays null");
      assert.ok(
        stderr.includes(`[subagents] Claude transcript not found for ${sessionId}; transcript not saved\n`),
        `expected shortened archive warning; got ${JSON.stringify(stderr)}`,
      );
    } finally {
      (process.stderr as any).write = orig;
    }
  });
});
