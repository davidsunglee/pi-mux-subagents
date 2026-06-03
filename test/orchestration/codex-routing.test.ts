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

  it("prefers a structured turn.failed message over benign stderr on non-zero exit", async () => {
    __test__.setSpawn(((_binary: string, _args: string[]) => {
      const ee = new EventEmitter() as any;
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.stdin = { write: () => true, end: () => {} };
      ee.killed = false;
      ee.kill = () => true;
      setImmediate(() => {
        // Codex writes informational text to stderr while emitting the real
        // failure as a JSONL turn.failed event on stdout.
        ee.stderr.emit("data", Buffer.from("Reading prompt from stdin...\n"));
        ee.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({ type: "turn.failed", error: { message: "model 'gpt-nope' is not available" } }) + "\n",
          ),
        );
        ee.emit("exit", 1);
        ee.emit("close", 1);
      });
      return ee;
    }) as any);

    const backend = makeHeadlessBackend(ctx);
    const handle = await backend.launch({ name: "C", task: "t", cli: "codex" } as any, false);
    const result: BackendResult = await backend.watch(handle);

    assert.equal(result.exitCode, 1, "non-zero codex exit must surface exitCode 1");
    assert.match(
      result.error ?? "",
      /model 'gpt-nope' is not available/,
      `error must surface the structured turn.failed message; got: ${result.error}`,
    );
    assert.doesNotMatch(
      result.error ?? "",
      /Reading prompt from stdin/,
      `error must not be masked by benign stderr; got: ${result.error}`,
    );
  });

  it("prefers a structured error event message over benign stderr on non-zero exit", async () => {
    __test__.setSpawn(((_binary: string, _args: string[]) => {
      const ee = new EventEmitter() as any;
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.stdin = { write: () => true, end: () => {} };
      ee.killed = false;
      ee.kill = () => true;
      setImmediate(() => {
        ee.stderr.emit("data", Buffer.from("Reading prompt from stdin...\n"));
        ee.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ type: "error", message: "401 Unauthorized: check your API key" }) + "\n"),
        );
        ee.emit("exit", 1);
        ee.emit("close", 1);
      });
      return ee;
    }) as any);

    const backend = makeHeadlessBackend(ctx);
    const handle = await backend.launch({ name: "C", task: "t", cli: "codex" } as any, false);
    const result: BackendResult = await backend.watch(handle);

    assert.equal(result.exitCode, 1, "non-zero codex exit must surface exitCode 1");
    assert.match(
      result.error ?? "",
      /401 Unauthorized/,
      `error must surface the structured error event message; got: ${result.error}`,
    );
    assert.doesNotMatch(
      result.error ?? "",
      /Reading prompt from stdin/,
      `error must not be masked by benign stderr; got: ${result.error}`,
    );
  });
});

describe("headless backend treats unknown cli as the pi fallback path", () => {
  afterEach(() => {
    __test__.restoreSpawn();
  });

  function installNeverEmittingSpawn(): void {
    // Pi children spawn a child immediately at launch; give them a process
    // that never emits so we can inspect the synchronously-returned handle.
    __test__.setSpawn(((_binary: string, _args: string[]) => {
      const ee = new EventEmitter() as any;
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.stdin = { write: () => true, end: () => {} };
      ee.killed = false;
      ee.kill = () => true;
      return ee;
    }) as any);
  }

  it("returns sessionKey + activityFile in the handle for an unknown cli value", async () => {
    installNeverEmittingSpawn();

    const backend = makeHeadlessBackend(ctx);
    const handle = await backend.launch({ name: "U", task: "t", cli: "unknown" } as any, false);

    assert.equal(typeof handle.sessionKey, "string", "unknown cli must fall back to pi and expose a sessionKey");
    assert.ok(handle.sessionKey!.length > 0, "sessionKey must be non-empty");
    assert.equal(typeof handle.activityFile, "string", "unknown cli must expose an activityFile for status supervision");
    assert.ok(handle.activityFile!.length > 0, "activityFile must be non-empty");
  });

  it("omits early pi session/activity metadata for codex (negative control)", async () => {
    installNeverEmittingSpawn();

    const backend = makeHeadlessBackend(ctx);
    const handle = await backend.launch({ name: "C", task: "t", cli: "codex" } as any, false);

    assert.equal(handle.sessionKey, undefined, "codex must not expose a pi sessionKey at launch");
    assert.equal(handle.activityFile, undefined, "codex must not expose a pi activityFile at launch");
  });
});
