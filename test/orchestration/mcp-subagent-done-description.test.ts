import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const sourceFile = resolve(testDir, "../../src/claude-plugin/mcp/server.ts");
const builtFile = resolve(testDir, "../../src/claude-plugin/mcp/server.js");

describe("MCP subagent_done description — tool-first directive", () => {
  it("source (server.ts) does not contain banned 'final assistant message before this call' framing", () => {
    const text = readFileSync(sourceFile, "utf-8");
    assert.doesNotMatch(text, /final assistant message before this call/i);
  });

  it("source (server.ts) contains tool-first directive 'Provide your summary in the `message` argument'", () => {
    const text = readFileSync(sourceFile, "utf-8");
    assert.match(text, /Provide your summary in the `message` argument/);
  });

  it("source (server.ts) retains completion trigger 'Call this when your task is complete'", () => {
    const text = readFileSync(sourceFile, "utf-8");
    assert.match(text, /Call this when your task is complete/);
  });

  it("source (server.ts) includes tool-first no-trailing-output guidance 'send no further output afterward'", () => {
    const text = readFileSync(sourceFile, "utf-8");
    assert.match(text, /send no further output afterward/);
  });

  it("built (server.js) does not contain banned 'final assistant message before this call' framing", () => {
    const text = readFileSync(builtFile, "utf-8");
    assert.doesNotMatch(text, /final assistant message before this call/i);
  });

  it("built (server.js) contains tool-first directive 'Provide your summary in the `message` argument'", () => {
    const text = readFileSync(builtFile, "utf-8");
    assert.match(text, /Provide your summary in the `message` argument/);
  });

  it("built (server.js) retains completion trigger 'Call this when your task is complete'", () => {
    const text = readFileSync(builtFile, "utf-8");
    assert.match(text, /Call this when your task is complete/);
  });

  it("built (server.js) includes tool-first no-trailing-output guidance 'send no further output afterward'", () => {
    const text = readFileSync(builtFile, "utf-8");
    assert.match(text, /send no further output afterward/);
  });
});
