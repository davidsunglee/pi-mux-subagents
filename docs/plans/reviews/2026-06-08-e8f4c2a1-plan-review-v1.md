**Reviewer:** openai-codex/gpt-5.5 via codex

### Outcome

**Verdict:** Approved with concerns

**Reasoning:** The plan is buildable, dependency ordering is coherent, and every task acceptance criterion has a paired concrete `Verify:` recipe. Waiving Important finding "Task 7 missing existing headless integration wording-test verification" because the plan adds focused unit/behavioral coverage for the affected paths and the integration test is environment-dependent, but adding that recipe would improve confidence.

### Strengths

- Task 1 defines the diagnostics module as a leaf and explicitly documents the import-cycle constraint, which matches the central dispatcher architecture.
- Tasks 2, 3, 4, and 5 sequence the refactor safely: producer migration first, launch-context threading next, then orchestration and bare-tool structured warning surfacing.
- Task 6 preserves the zero-argument `selectBackend()` contract and dedupe behavior while explaining how ambient UI routing is tested without importing `index.ts`.
- Task 7 deliberately protects non-goal raw-stderr headless child-runner diagnostics with both inspection and a behavioral fake-spawn test.
- Acceptance criteria are generally objective and paired one-to-one with `Verify:` recipes.

### Issues

#### Critical (Must Fix)

_None._

#### Important (Should Fix)

- **Task 7: Missing existing headless integration wording-test verification**
  - **What:** The spec context lists `test/integration/headless-claude-skills-warning.test.ts` as an existing byte-for-byte/routing regression, but the plan's final verification only runs `pnpm test`, `pnpm typecheck`, and `pnpm lint`. `pnpm test` does not include `test/integration/*.test.ts`.
  - **Why it matters:** The headless Claude skills-warning path is intentionally changed to go through the dispatcher. Without including the existing integration test, an executor could satisfy the plan while skipping one of the original spec's named regression checks.
  - **Recommendation:** Add a Task 7 acceptance criterion or verification step to run the specific integration test, for example `pnpm run test:integration -- test/integration/headless-claude-skills-warning.test.ts` if the project script supports forwarding, or document the exact project-supported command for that file. Note that the test is already skip-gated when Claude is unavailable.

#### Minor (Nice to Have)

_None._

### Recommendations

- Consider replacing grep-against-test-output recipes with direct targeted test commands where practical; the current recipes are usable, but direct commands reduce dependence on TAP output phrasing.
