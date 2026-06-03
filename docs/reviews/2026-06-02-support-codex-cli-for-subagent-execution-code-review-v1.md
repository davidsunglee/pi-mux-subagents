**Reviewer:** openai-codex/gpt-5.5 via pi

### Outcome

**Verdict:** Approved

**Reasoning:** The Codex backend implementation covers the planned headless and pane routes, policy/model/thinking mappings, MCP sentinel completion, orchestration wiring, and preservation of pi/Claude behavior. I found no blocking production-readiness issues; `pnpm typecheck && pnpm test` passes.

### Strengths

- Codex command construction and JSONL parsing are isolated in focused modules with good unit coverage.
- Pane completion uses per-launch `codex -c` MCP overrides and avoids mutating persistent `~/.codex/config.toml`.
- Headless Codex handles missing binaries, aborts, structured error events, terminal-event validation, transcript archiving, and resume argument ordering defensively.
- Shared branch sites correctly treat Codex as a non-pi backend for status/session-key/activity semantics while preserving unknown-CLI fallback to pi.
- Slow real-Codex integrations are gated, and the ungated ENOENT path is covered.

### Issues

#### Critical (Must Fix)

_None._

#### Important (Should Fix)

_None._

#### Minor (Nice to Have)

- **src/launch/launch-spec.ts:106 and src/orchestration/types.ts:24: `resumeSessionId` descriptions remain Claude-only**
  - **What:** The tool/schema descriptions still describe `resumeSessionId` as resuming a Claude Code session, even though this change also supports headless Codex resume via `codex exec resume <id>`.
  - **Why it matters:** The runtime behavior is correct, but users relying on generated tool docs may not discover Codex resume support or may assume it is unsupported.
  - **Recommendation:** Update both descriptions to mention Claude and headless Codex resume semantics, including that pane Codex resume is not available in v1.

### Recommendations

- Run `PI_RUN_SLOW=1 pnpm test:integration:slow` in an environment with authenticated Codex before release to exercise the real Codex headless/pane/orchestration paths.
