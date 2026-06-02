import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCodexEvent, extractCodexSessionId, parseCodexUsage } from "../../src/backends/codex-stream.ts";

describe("parseCodexEvent", () => {
  it("item.completed with agent_message → one assistant text message", () => {
    const result = parseCodexEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "Hello world" },
    });
    assert.ok(Array.isArray(result), "must return an array");
    assert.equal(result!.length, 1);
    const msg = result![0];
    assert.equal(msg.role, "assistant");
    assert.equal(msg.content.length, 1);
    assert.equal(msg.content[0].type, "text");
    if (msg.content[0].type === "text") assert.equal(msg.content[0].text, "Hello world");
  });

  it("item.completed with reasoning → assistant thinking message", () => {
    const result = parseCodexEvent({
      type: "item.completed",
      item: { type: "reasoning", text: "I am reasoning..." },
    });
    assert.ok(Array.isArray(result));
    assert.equal(result!.length, 1);
    const msg = result![0];
    assert.equal(msg.role, "assistant");
    assert.equal(msg.content[0].type, "thinking");
    if (msg.content[0].type === "thinking") assert.equal(msg.content[0].thinking, "I am reasoning...");
  });

  it("item.completed with command_execution → toolCall", () => {
    const result = parseCodexEvent({
      type: "item.completed",
      item: { type: "command_execution", id: "cmd-1", command: "ls -la", arguments: { cmd: "ls -la" } },
    });
    assert.ok(Array.isArray(result));
    assert.equal(result!.length, 1);
    const msg = result![0];
    assert.equal(msg.role, "assistant");
    assert.equal(msg.content[0].type, "toolCall");
    if (msg.content[0].type === "toolCall") {
      assert.equal(msg.content[0].id, "cmd-1");
    }
  });

  it("item.completed with tool_call → toolCall", () => {
    const result = parseCodexEvent({
      type: "item.completed",
      item: { type: "tool_call", id: "tc-1", name: "ReadFile", arguments: { path: "/tmp/x" } },
    });
    assert.ok(Array.isArray(result));
    const msg = result![0];
    assert.equal(msg.content[0].type, "toolCall");
    if (msg.content[0].type === "toolCall") {
      assert.equal(msg.content[0].name, "readfile", "name must be lowercased");
      assert.equal(msg.content[0].id, "tc-1");
    }
  });

  it("item.completed with mcp_tool_call → toolCall", () => {
    const result = parseCodexEvent({
      type: "item.completed",
      item: { type: "mcp_tool_call", id: "mcp-1", name: "subagent_done", arguments: { summary: "done" } },
    });
    assert.ok(Array.isArray(result));
    const msg = result![0];
    assert.equal(msg.content[0].type, "toolCall");
  });

  it("unknown item type → undefined", () => {
    const result = parseCodexEvent({
      type: "item.completed",
      item: { type: "some_future_item_type", text: "data" },
    });
    assert.equal(result, undefined, "unknown item types must return undefined, not be fabricated");
  });

  it("non item.completed events → undefined", () => {
    assert.equal(parseCodexEvent({ type: "thread.started", thread_id: "t1" }), undefined);
    assert.equal(parseCodexEvent({ type: "turn.completed", usage: {} }), undefined);
    assert.equal(parseCodexEvent({ type: "unknown_event" }), undefined);
  });

  it("item.completed with no item → undefined", () => {
    const result = parseCodexEvent({ type: "item.completed" });
    assert.equal(result, undefined);
  });
});

describe("extractCodexSessionId", () => {
  it("thread.started with thread_id → extracted id", () => {
    const id = extractCodexSessionId({ type: "thread.started", thread_id: "thread-abc-123" });
    assert.equal(id, "thread-abc-123");
  });

  it("thread.started with threadId → extracted id", () => {
    const id = extractCodexSessionId({ type: "thread.started", threadId: "thread-def-456" });
    assert.equal(id, "thread-def-456");
  });

  it("thread.started with session_id → extracted id", () => {
    const id = extractCodexSessionId({ type: "thread.started", session_id: "session-xyz" });
    assert.equal(id, "session-xyz");
  });

  it("thread.started with sessionId → extracted id", () => {
    const id = extractCodexSessionId({ type: "thread.started", sessionId: "session-qrs" });
    assert.equal(id, "session-qrs");
  });

  it("thread.started with thread.id → extracted id", () => {
    const id = extractCodexSessionId({ type: "thread.started", thread: { id: "nested-thread-id" } });
    assert.equal(id, "nested-thread-id");
  });

  it("thread.started without any id field → undefined", () => {
    const id = extractCodexSessionId({ type: "thread.started" });
    assert.equal(id, undefined, "must return undefined when no id field is present");
  });

  it("thread.started with empty string id → undefined", () => {
    const id = extractCodexSessionId({ type: "thread.started", thread_id: "" });
    assert.equal(id, undefined, "empty string id must return undefined");
  });

  it("non thread.started event → undefined regardless of id fields", () => {
    assert.equal(extractCodexSessionId({ type: "item.completed", thread_id: "t1" }), undefined);
    assert.equal(extractCodexSessionId({ type: "turn.completed", session_id: "s1" }), undefined);
  });
});

describe("parseCodexUsage", () => {
  it("turn.completed maps input_tokens, output_tokens, cached_input_tokens and leaves cost: 0", () => {
    const usage = parseCodexUsage({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cached_input_tokens: 200,
      },
    });
    assert.ok(usage !== undefined, "must return UsageStats for turn.completed");
    assert.equal(usage!.input, 100);
    assert.equal(usage!.output, 50);
    assert.equal(usage!.cacheRead, 200);
    assert.equal(usage!.cacheWrite, 0, "cacheWrite must be 0 (Codex does not report it)");
    assert.equal(usage!.cost, 0, "cost must default to 0 (Codex JSONL does not report USD)");
    assert.equal(usage!.contextTokens, 350, "contextTokens = input + output + cacheRead");
    assert.equal(usage!.turns, 0, "turns is managed by the runner, not the event");
  });

  it("also maps cache_read_input_tokens alternative field name", () => {
    const usage = parseCodexUsage({
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 30,
      },
    });
    assert.ok(usage !== undefined);
    assert.equal(usage!.cacheRead, 30);
  });

  it("maps fallback field names input and output", () => {
    const usage = parseCodexUsage({
      type: "turn.completed",
      usage: { input: 8, output: 4 },
    });
    assert.ok(usage !== undefined);
    assert.equal(usage!.input, 8);
    assert.equal(usage!.output, 4);
  });

  it("defaults missing fields to 0", () => {
    const usage = parseCodexUsage({ type: "turn.completed", usage: {} });
    assert.ok(usage !== undefined);
    assert.equal(usage!.input, 0);
    assert.equal(usage!.output, 0);
    assert.equal(usage!.cacheRead, 0);
  });

  it("non turn.completed event → undefined", () => {
    assert.equal(parseCodexUsage({ type: "thread.started" }), undefined);
    assert.equal(parseCodexUsage({ type: "item.completed", item: {} }), undefined);
  });
});
