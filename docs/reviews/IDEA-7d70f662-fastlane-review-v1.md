**Reviewer:** openai-codex/gpt-5.5 via pi

### Outcome
**Verdict:** Approved
**Reasoning:** The full diff satisfies the stated requirements: Claude pane and headless launches now default to guarded permission mode, unrestricted remains an explicit escape hatch, the CLI-agnostic execution policy is exposed consistently across direct and orchestrated launches, unsupported guarded backends warn on explicit requests and continue, and documentation/tests were updated. I found no blocking or non-blocking production-readiness issues in the reviewed diff.

### Strengths
- Centralizing `executionPolicy` resolution in `src/launch/launch-spec.ts` keeps pane and headless backends aligned and avoids Claude-specific frontmatter.
- Claude pane and headless argument builders have clear, tested mappings for guarded vs. unrestricted execution.
- Orchestration task schema and backend launch params now carry the same policy surface as the bare `subagent` tool.
- README documentation clearly explains migration impact, the Claude mapping, `CLAUDE_CODE_SANDBOXED=1`, unsupported-backend behavior, and future backend mappings.
- Regression coverage was added for defaults, escape hatches, frontmatter parsing, warnings, and both Claude launch paths.

### Issues by Severity

#### Critical
- None.

#### Important
- None.

#### Minor
- None.

### Recommendations
- Continue to keep future backend policy mappings centralized in launch resolution and backend-specific argument builders as Codex/OpenCode support is added.
- Verification run during review: `pnpm run typecheck` and the repository test suite via `pnpm test` completed successfully.
