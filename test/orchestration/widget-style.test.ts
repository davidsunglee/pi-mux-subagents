import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../../src/index.ts";

const testApi = (subagentsModule as any).__test__;

const NORD10_BLUE = "\x1b[38;2;94;129;172m";

describe("subagents widget style", () => {
  it("renders the title lowercase and borders in Nord10 muted blue", () => {
    const lines: string[] = testApi.renderSubagentWidgetLines(
      [
        {
          id: "style-1",
          name: "Worker",
          task: "",
          backend: "pane",
          startTime: Date.now() - 1_000,
        },
      ],
      48,
    );

    assert.ok(lines[0].includes("─ subagents "), `expected lowercase title in top border, got: ${lines[0]}`);
    assert.ok(!lines[0].includes("Subagents"), `expected no uppercase widget title, got: ${lines[0]}`);

    for (const [index, line] of lines.entries()) {
      assert.ok(
        line.startsWith(NORD10_BLUE),
        `line ${index} should start with Nord10 border color ${JSON.stringify(NORD10_BLUE)}, got: ${JSON.stringify(line)}`,
      );
    }
  });
});
