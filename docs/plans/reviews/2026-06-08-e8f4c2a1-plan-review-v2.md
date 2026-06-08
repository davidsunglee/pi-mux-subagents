**Reviewer:** openai-codex/gpt-5.5 via codex

### Outcome

**Verdict:** Approved

**Reasoning:** The plan fully covers the on-disk spec, the dependency chain is coherent, and every acceptance criterion has an adjacent concrete `Verify:` recipe. I found no Critical or Important structural issues that would block an implementation agent.

### Strengths

- Task 1 clearly isolates the diagnostics module as a leaf and documents the import-cycle constraint that matters for `index.ts`, `select.ts`, and backend modules.
- Tasks 2 through 6 preserve the spec's staged buildability: producers migrate first, signatures and collector plumbing follow, and tool-result surfacing is added without requiring all changes in one task.
- Task 7 explicitly verifies non-goal behavior for raw headless child-runner diagnostics and the named headless Claude integration regression, closing the prior review concern.
- Acceptance criteria are consistently paired one-to-one with `Verify:` lines naming artifacts, commands, and expected success conditions.

### Issues

#### Critical (Must Fix)

_None._

#### Important (Should Fix)

_None._

#### Minor (Nice to Have)

_None._

### Recommendations

_None._
