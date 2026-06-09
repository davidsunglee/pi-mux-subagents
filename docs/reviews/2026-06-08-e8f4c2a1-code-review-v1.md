**Reviewer:** openai-codex/gpt-5.5 via codex

### Outcome

**Verdict:** Approved

**Reasoning:** The implementation matches the requested diagnostics architecture, preserves existing human warning behavior, and threads structured collectors through bare and orchestration launch paths without introducing regressions. `pnpm run lint`, `pnpm run typecheck`, and `pnpm test` all pass.

### Strengths

- `src/diagnostics/diagnostics.ts:68-76`: The dispatcher cleanly centralizes human UI/stderr routing and structured collection while keeping the module leaf-like and easy to test.
- `src/index.ts:951-993`: The migrated Claude/Codex warning producers preserve the existing message strings and add stable diagnostic codes plus structured audience routing.
- `src/index.ts:2035-2152` and `src/index.ts:2157-2259`: Bare `subagent` launches now create a collector for both headless and pane paths and expose launch warnings additively in `details.warnings`.
- `src/orchestration/run-serial.ts:122-190` and `src/orchestration/run-parallel.ts:122-199`: Per-task collectors are threaded through launch and carried into terminal and blocked task results, including the async blocked paths.
- `test/orchestration/diagnostics-dispatch.test.ts:15-67`, `test/orchestration/structured-warnings.test.ts:53-121`, `test/orchestration/pane-warning-ui-routing.test.ts:9-175`, and `test/orchestration/headless-child-runner-stderr.test.ts:37-71`: Coverage exercises the main dispatcher, structured warnings, UI vs stderr delivery, and non-migrated headless stderr preservation.

### Issues

#### Critical (Must Fix)

_None._

#### Important (Should Fix)

_None._

#### Minor (Nice to Have)

_None._

### Recommendations

_None._
