import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { __test__, makeHeadlessBackend } from "../../src/backends/headless.ts";
import type { BackendResult } from "../../src/backends/types.ts";

const ctx = {
  sessionManager: {
    getSessionFile: () => "/tmp/parent.jsonl",
    getSessionId: () => "sess-test",
    getSessionDir: () => "/tmp",
  } as any,
  cwd: "/tmp",
};

describe("headless backend routes cli: codex to the codex binary", () => {
  afterEach(() => {
    __test__.restoreSpawn();
  });

  it("spawns 'codex' with exec --json argv and completes on turn.completed", async () => {
    let recordedBinary: string | undefined;
    let recordedArgs: string[] = [];

    __test__.setSpawn(((binary: string, args: string[]) => {
      recordedBinary = binary;
      recordedArgs = args;
      const ee = new EventEmitter() as any;
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.stdin = { write: () => true, end: () => {} };
      ee.killed = false;
      ee.kill = () => true;
      // Emit a thread.started then a turn.completed JSON line, then close 0.
      setImmediate(() => {
        ee.stdout.emit("data", Buffer.from(JSON.stringify({ type: "thread.started", thread_id: "codex-abc" }) + "\n"));
        ee.stdout.emit("data", Buffer.from(JSON.stringify({ type: "turn.completed", usage: {} }) + "\n"));
        ee.emit("exit", 0);
        ee.emit("close", 0);
      });
      return ee;
    }) as any);

    const backend = makeHeadlessBackend(ctx);
    const handle = await backend.launch({ name: "C", task: "t", cli: "codex" } as any, false);
    const result: BackendResult = await backend.watch(handle);

    assert.equal(recordedBinary, "codex", "must spawn the 'codex' binary");
    assert.ok(recordedArgs.includes("exec"), "argv must contain 'exec'");
    assert.ok(recordedArgs.includes("--json"), "argv must contain '--json'");
    assert.equal(result.exitCode, 0, "clean turn.completed must yield exitCode 0");
  });
});
