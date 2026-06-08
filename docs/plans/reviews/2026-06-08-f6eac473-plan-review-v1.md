**Reviewer:** openai-codex/gpt-5.5 via codex

### Outcome

**Verdict:** Approved with concerns

**Reasoning:** Waiving the Important Task 1 finding about the Codex-named derived ordering sentence because it does not block the current pi/Claude/Codex implementation, but it weakens the future-backend no-silent-inheritance guarantee and should be tightened before adding another terminal-final-answer backend.

### Strengths

- Task 1 defines the required pane-scoped seam with explicit backend/mode variants, mandatory protocol slots, runtime totality coverage, and compile-time negative assertions.
- Tasks 2 and 3 preserve `fullTask`/`claudeTaskBody` for existing consumers while routing the Codex pane prompt through `neutralCore` plus the Codex seam variant, matching the spec's intended behavioral boundary.
- Task 4 updates both the MCP source and generated runtime artifact and adds a regression test over both files, directly covering the shared description drift risk.
- Dependencies are correctly declared: Task 2 depends on the seam, Task 3 depends on the seam plus `neutralCore`, Task 4 is independent, and Task 5 depends on all implementation tasks.
- Acceptance criteria are consistently paired one-to-one with concrete `Verify:` recipes, and the recipes name the checked artifact or command plus an objective success condition.

### Issues

#### Critical (Must Fix)

_None._

#### Important (Should Fix)

- **Task 1: Tool-first ordering sentence is Codex-specific despite being selected only by terminality**
  - **What:** `resolveOrderingSentence(posture, _carrier)` derives the tool-first branch from `terminality`/posture, but the mandated string starts with `In Codex...`. A future backend with `terminality: "final-answer-terminal"` could add its required table entries and still inherit a Codex-named instruction. The unused `_carrier` also means future summary-carrier combinations would not be forced through an explicit wording decision.
  - **Why it matters:** The current plan satisfies today's three backends, but it partially undermines the spec's future-backend guarantee that no backend can silently inherit another backend's completion semantics once it has been added to the protocol table.
  - **Recommendation:** Make the derived tool-first sentence backend-neutral, or pass the full protocol/backend into the resolver and make backend-specific wording explicit. Also consider an exhaustive switch over the supported posture/carrier combinations so unsupported future combinations fail visibly.

#### Minor (Nice to Have)

_None._

### Recommendations

_None._
