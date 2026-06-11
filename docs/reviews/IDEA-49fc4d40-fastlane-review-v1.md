**Reviewer:** openai-codex/gpt-5.5 via codex

### Outcome

**Verdict:** Approved

**Reasoning:** The changes satisfy the project-trust requirements: Pi pane/headless/resume child launches receive per-run `--approve`, parent-side project-local `.pi/agents` discovery is gated by `ctx.isProjectTrusted()`, package metadata is aligned to Pi 0.79.1, and the added tests cover the key trust boundaries. No Critical or Important findings remain.

### Strengths

- **src/launch/launch-spec.ts:352** — `loadAgentDefaults()` now accepts an explicit `projectTrusted` option and skips only the project-local candidate when trust is false, preserving global and bundled agent fallback behavior while closing the untrusted-frontmatter path.
- **src/launch/launch-spec.ts:631** — Agent lookup uses the same pre-resolved target cwd logic that launch resolution uses, so `.pi/agents` discovery follows a caller-specified child cwd without letting agent-frontmatter `cwd` participate before trust is established.
- **src/index.ts:1214**, **src/backends/headless.ts:355**, **src/index.ts:2542** — Initial pane Pi launches, headless Pi launches, and Pi resume-by-session launches all route through the shared `buildPiProjectTrustArgs()` path and include `--approve`, covering the follow-up remediation item for resume.
- **src/index.ts:2379** — `subagents_list` now threads the runtime `ctx.isProjectTrusted()` decision into discovery, so untrusted project-local agents are absent from both rendered content and structured details.
- **src/orchestration/default-deps.ts:62** — Headless orchestration registration gates its secondary `loadAgentDefaults()` lookup using the same trust decision and project-root derivation as launch resolution, preventing untrusted frontmatter from skewing registry metadata such as `cli` or status source.
- **package.json:37** — Peer and dev dependencies are bumped to Pi 0.79.1, matching the new `ctx.isProjectTrusted()` runtime assumption.
- **test/orchestration/pi-project-trust.test.ts:75**, **test/orchestration/pi-project-trust.test.ts:157**, **test/orchestration/pi-project-trust.test.ts:217**, **test/orchestration/pi-project-trust.test.ts:259**, **test/orchestration/pi-project-trust.test.ts:333** — The tests cover headless, pane, resume, launch-spec trust gating, and listing trust gating with real filesystem fixtures.
- **README.md:144** — Documentation clearly separates project trust as input loading from `executionPolicy` as autonomy/sandbox behavior and documents backend-specific handling.

### Issues

#### Critical (Must Fix)

_None._

#### Important (Should Fix)

_None._

#### Minor (Nice to Have)

- **src/tools/tool-handlers.ts:109: `depsFactory` type omits `isProjectTrusted`**
  - **What:** `registerOrchestrationTools()` still types `depsFactory` as accepting only `{ sessionManager; cwd }`, even though the runtime `ctx` passed at `src/tools/tool-handlers.ts:240` carries `isProjectTrusted()` through to `makeDefaultDeps()`.
  - **Why it matters:** Current behavior is correct because the handler `ctx` is typed `any`, but the type contract does not document the trust dependency. A future cleanup that narrows handler context types could accidentally drop the method without TypeScript catching the trust-gate regression.
  - **Recommendation:** Extend the `depsFactory` context type to include `isProjectTrusted?: () => boolean`, matching `makeDefaultDeps()` and the Pi 0.79.1 contract.

### Recommendations

- Keep the `/subagent` slash-command validation path on the follow-up radar. It currently calls `loadAgentDefaults(agentName)` without a trust option at `src/index.ts:2809`; actual subagent launch remains gated later, but aligning validation with trusted discovery would make the command surface easier to reason about.
- Validation run during review: `pnpm run build` passed, and `pnpm test` passed with 821 tests.
