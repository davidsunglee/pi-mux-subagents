**Reviewer:** openai-codex/gpt-5.5 via pi

### Outcome

**Verdict:** Approved

**Reasoning:** The plan covers the inline Codex backend requirements across launch-spec normalization, headless and pane routing, MCP completion, policy/model/thinking mapping, docs, and gated tests. Dependencies are explicit and build order is workable; no Critical or Important structural issues were found.

### Strengths

- Tasks 1, 2, 4, and 5 give concrete function names, command arguments, environment variables, and old→new branch edits, making the implementation directly actionable.
- Task 7 covers both real-cost headless and mux-pane Codex flows with gating, plus resume behavior when session IDs are or are not emitted.
- The dependency graph correctly orders the Codex stream/MCP/launch-spec primitives before pane/headless integration, and notes the Task 4 dependency on the warning helper introduced in Task 5.
- Acceptance criteria are paired one-to-one with specific `Verify:` recipes, including commands or file/grep success conditions.
- The Risk Assessment clearly documents version-sensitive JSONL parsing, MCP injection fragility, and the intentional Claude sentinel compatibility deviation.

### Issues

#### Critical (Must Fix)

_None._

#### Important (Should Fix)

_None._

#### Minor (Nice to Have)

- **Task 2: Plugin test verification count is slightly inaccurate**
  - **What:** The acceptance verify text says to confirm the original four `PI_CLAUDE_SENTINEL` `it(...)` blocks are still present, but the current `test/plugin-mcp.test.ts` has five existing MCP-server cases that use the Claude sentinel environment path.
  - **Why it matters:** This is unlikely to block execution because Task 2 also says to leave existing cases intact, but the hard-coded count could confuse a worker during final verification.
  - **Recommendation:** Change the verify text to require that all existing `PI_CLAUDE_SENTINEL` cases remain present and passing, without naming a count.

### Recommendations

- Keep the implementation sequence from the Dependencies section; Task 5 should not be attempted before Tasks 1–3 because the pane branch consumes all three outputs.
