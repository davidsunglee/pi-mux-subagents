**Reviewer:** openai-codex/gpt-5.5 via codex

### Outcome

**Verdict:** Approved

**Reasoning:** The implementation matches the planned backend-specific, tool-first Codex pane completion protocol while preserving the Claude/pi/headless prompt surfaces. The seam, launch dispatch, MCP description, and tests are production-ready, and full automated verification plus a minimal Codex MCP smoke passed.

### Strengths

- `src/launch/pane-completion-protocol.ts` provides the requested typed table over `PaneBackend x PaneExecutionMode`, shared composer, ordering derivation, unsupported-pair throws, runtime tuples, and `assertNever` dispatch guard.
- `src/launch/launch-spec.ts` cleanly separates `neutralCore` from legacy `fullTask`/`claudeTaskBody`, projects `paneBackend` from `effectiveCli`, and sources Claude addendum text through the seam without changing the byte-identity expectations covered by tests.
- `src/index.ts` dispatches pane launches through finite `spec.paneBackend`, composes Codex pane prompts from `neutralCore` plus the Codex protocol variant, preserves pi direct passthrough, and closes dispatch with `return assertNever(spec.paneBackend)`.
- The MCP `subagent_done` description is now tool-first in both `server.ts` and regenerated `server.js`, with tests guarding against the old final-message-before-tool framing.
- Test coverage is targeted and meaningful: seam totality, Claude byte identity, Codex composer and launch argv behavior, launch-spec fields, and MCP source/generated descriptions are all exercised.
- Verification passed: `pnpm run typecheck`, `pnpm run lint`, `pnpm run build:plugin`, `pnpm test`, and an escalated minimal `codex exec` smoke that called `pi_subagent.subagent_done` and wrote `smoke-ok` to the sentinel.

### Issues

#### Critical (Must Fix)

_None._

#### Important (Should Fix)

_None._

#### Minor (Nice to Have)

_None._

### Recommendations

_None._
