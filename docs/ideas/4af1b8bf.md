{
  "id": "4af1b8bf",
  "title": "Support Codex CLI for subagent execution",
  "tags": [
    "subagents",
    "codex",
    "cli"
  ],
  "status": "closed",
  "created_at": "2026-06-02T19:13:27.631Z"
}

## Context
`pi-mux-subagents` currently supports subagents executed by `pi` and Claude Code. Claude support includes both pane execution with an MCP `subagent_done` sentinel and headless execution with streamed JSON result capture. README already names Codex as a likely future CLI backend.

Codex CLI documentation and local Codex CLI (`codex-cli 0.136.0`) help show the maintained binary is `codex` on `PATH`; the useful surfaces are interactive `codex`, non-interactive `codex exec`, `codex exec resume`, JSONL output via `--json`, final-message capture via `--output-last-message`, workspace selection via `--cd/-C`, model selection via `--model/-m`, config overrides via `-c key=value`, MCP server configuration, and safety controls through `--sandbox`, `approval_policy` / `--ask-for-approval`, and `--dangerously-bypass-approvals-and-sandbox`.

## Goal
Add Codex CLI as a third subagent execution backend, with parity to the existing Claude backend where Codex supports it: direct launches, serial/parallel orchestration, pane and headless modes, clear completion semantics, cancellation/error handling, model/thinking mapping, and guarded-vs-unrestricted execution policy behavior.

## Scope
- Add Codex to public launch/orchestration inputs as `cli: "codex"` only.
- Discover only the `codex` binary on `PATH`; do not introduce alternate CLI selectors, a separate binary override, or a `codex-cli` executable dependency.
- Implement a Codex command builder and backend routing alongside the existing `pi` and `claude` paths.
- Headless mode: run `codex exec` with `--json`, `--output-last-message <file>`, `--cd <cwd>`, and stdin/direct prompt delivery as appropriate; treat process exit plus the final-message file/JSONL stream as completion.
- Pane mode: run interactive `codex` in the mux pane and provide an explicit `subagent_done` completion path via Codex MCP support, mirroring the Claude sentinel behavior without mutating the user’s persistent Codex config if possible.
- Map execution policy to documented Codex safety controls:
  - guarded headless: workspace-write sandbox with non-interactive approval behavior (`approval_policy = "never"` via config override if `codex exec` does not accept `--ask-for-approval` directly);
  - guarded pane: workspace-write sandbox with `on-request` approvals;
  - unrestricted: `--dangerously-bypass-approvals-and-sandbox`, matching Claude’s bypass behavior for trusted/external-sandbox runs.
- Map `model` to Codex `--model` using Codex’s expected model name (for example `gpt-5.4-mini`); do not invent provider aliases. Provider selection remains Codex config/profile responsibility.
- Map supported `thinking` values to `-c model_reasoning_effort=<minimal|low|medium|high|xhigh>`; omit unsupported values rather than passing invalid flags.
- Support `resumeSessionId` through `codex exec resume <session-id>` once session/thread IDs are reliably parsed from JSONL output; otherwise fail clearly instead of silently starting a new session.
- Preserve existing `pi` and `claude` behavior, including Claude-specific plugin/sentinel compatibility.
- Warn and ignore pi-only `skills` and tool allowlists for Codex v1, except for the internal MCP completion tool required for pane completion.
- Update README/API docs and examples for Codex usage and safety-model differences.
- Add unit/contract tests for command construction, policy mapping, missing binary errors, JSONL parsing, result shaping, and routing; add gated real Codex integration tests for headless and mux-pane/orchestration flows.

## Acceptance Sketch
- `cli: "codex"` launches a Codex-backed subagent from the same public entry points that currently accept `pi` and `claude`.
- Missing `codex` on `PATH` fails with a clear actionable error.
- Guarded and unrestricted launches produce documented Codex flags/config overrides and mirror Claude’s safety-policy intent.
- Headless Codex runs return `exitCode`, `finalMessage`, `transcript`, `transcriptPath`, usage when present in JSONL, and a session/thread identifier when Codex emits one.
- Pane Codex runs can ask questions, accept user input, call `subagent_done`, and report completion to the parent without relying on process exit alone.
- Serial and parallel orchestration work with Codex tasks and report terminal states consistently with existing backends.
- A gated smoke/integration test can run a unique-marker task with a low-cost Codex model such as `gpt-5.4-mini`.
- Resume behavior is covered when Codex emits stable IDs; if unavailable for the installed Codex version, the unsupported path has a deterministic error and test coverage.
- Existing pi and Claude tests continue to pass unchanged.

## Open Questions
- What minimum Codex CLI version should be required for stable JSONL event names and session/thread ID extraction?
- Can the Codex MCP completion server be injected entirely via per-launch `-c` overrides/temp config, or is a temporary `CODEX_HOME`/profile layer needed?
- Which environment flag should gate real-cost Codex integration tests in CI/local runs?
Completed via plan: docs/plans/2026-06-02-support-codex-cli-for-subagent-execution.md
