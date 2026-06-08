**Reviewer:** openai-codex/gpt-5.5 via codex

### Outcome

**Verdict:** Approved

**Reasoning:** The implementation models identity delivery as an explicit backend policy and applies it consistently to Codex pane and headless prompts while preserving Claude and pi routing. Focused regression coverage, typecheck, lint, and the main test suite all pass.

### Strengths

- The new identity-delivery table is total over `PaneBackend` and cleanly encodes the three required policies without launch-site special casing (`src/launch/identity-delivery.ts:62-98`).
- `resolveLaunchSpec` derives `identityInSystemPrompt` from the backend policy, which keeps Codex identity in `neutralCore`/`fullTask` for `system-prompt: append|replace` and leaves pi/Claude behavior policy-driven (`src/launch/launch-spec.ts:668-702`).
- Codex pane and headless paths both consume the policy-derived prompt bodies, and `system-prompt: replace` warnings are emitted through the existing Codex unsupported-feature path (`src/index.ts:968-985`, `src/index.ts:1131-1150`, `src/backends/headless.ts:739-783`).
- Regression tests cover the identity seam, Codex pane prompt composition, Codex `replace` warning, and launch-spec prompt bodies for append/replace and test-runner-shaped artifact contracts (`test/orchestration/identity-delivery.test.ts:1-44`, `test/orchestration/launch-spec.test.ts:437-557`, `test/orchestration/codex-pane-completion.test.ts:130-165`, `test/orchestration/codex-skills-warning.test.ts:57-82`).

### Issues

#### Critical (Must Fix)

_None._

#### Important (Should Fix)

_None._

#### Minor (Nice to Have)

_None._

### Recommendations

- Keep the headless backend discriminator aligned with `PaneBackend` if a future non-pi/Claude/Codex backend is added, so the identity-delivery totality guarantee remains meaningful outside the current legacy unknown-CLI pi fallback.
