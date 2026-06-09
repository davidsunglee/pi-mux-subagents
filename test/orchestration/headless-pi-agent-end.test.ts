import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("runPiHeadless agent_end race-closer", () => {
  let backendModule: any;
  let root: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "headless-pi-agent-end-"));
    backendModule = await import("../../src/backends/headless.ts");
    backendModule.__test__.setSpawn(((_cmd: string, _args: string[], _opts: any) => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => true;
      queueMicrotask(() => {
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text: "OK" }],
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens: 10,
            cost: { total: 0.123 },
          },
          stopReason: "stop",
        };
        // Simulate a stdout race where close observes agent_end but the final
        // assistant message_end line never reaches the parser. The runner must
        // still treat agent_end as terminal and backfill the assistant output.
        proc.stdout.emit("data", Buffer.from(JSON.stringify({
          type: "agent_end",
          messages: [assistant],
          willRetry: false,
        }) + "\n"));
        proc.emit("exit", 0);
        proc.emit("close", 0);
      });
      return proc;
    }) as any);
  });

  after(() => {
    backendModule.__test__.restoreSpawn();
    rmSync(root, { recursive: true, force: true });
  });

  it("uses agent_end as a terminal completion event and backfills the assistant message", async () => {
    const backend = backendModule.makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(root, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => root,
      } as any,
      cwd: root,
    });

    const handle = await backend.launch({ name: "t", task: "Reply OK", cli: "pi" }, false);
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0);
    assert.equal(result.error, undefined);
    assert.equal(result.finalMessage, "OK");
    assert.equal(result.usage?.turns, 1);
    assert.equal(result.transcript?.at(-1)?.role, "assistant");
  });

  it("deduplicates the final assistant message when message_end and agent_end disagree on metadata", async () => {
    backendModule.__test__.setSpawn(((_cmd: string, _args: string[], _opts: any) => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => true;
      queueMicrotask(() => {
        const assistantFromMessageEnd = {
          role: "assistant",
          timestamp: "2026-06-09T19:00:00.000Z",
          content: [{ type: "text", text: "OK" }],
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens: 10,
            cost: { total: 0.123 },
          },
          stopReason: "stop",
        };
        const assistantFromAgentEnd = {
          role: "assistant",
          content: [{ type: "text", text: "OK" }],
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens: 10,
            cost: { total: 0.123 },
          },
          stopReason: "stop",
        };
        proc.stdout.emit("data", Buffer.from(JSON.stringify({
          type: "message_end",
          message: assistantFromMessageEnd,
        }) + "\n"));
        proc.stdout.emit("data", Buffer.from(JSON.stringify({
          type: "agent_end",
          messages: [assistantFromAgentEnd],
          willRetry: false,
        }) + "\n"));
        proc.emit("exit", 0);
        proc.emit("close", 0);
      });
      return proc;
    }) as any);

    const backend = backendModule.makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(root, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => root,
      } as any,
      cwd: root,
    });

    const handle = await backend.launch({ name: "t", task: "Reply OK", cli: "pi" }, false);
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0);
    assert.equal(result.error, undefined);
    assert.equal(result.finalMessage, "OK");
    assert.equal(result.usage?.turns, 1);
    assert.equal(result.transcript?.filter((msg: any) => msg.role === "assistant").length, 1);
  });
});
