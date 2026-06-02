# Plan: Support Codex CLI for Subagent Execution

**Source:** IDEA-4af1b8bf

> This plan was generated from the inline idea task and aligned against the committed spec `docs/specs/2026-06-02-4af1b8bf.md`, whose `## Approach` section fixes the implementation strategy (per-launch `codex -c` MCP injection, no `CODEX_HOME` fallback, reuse the existing MCP server via a CLI-neutral sentinel env var, mechanical third-branch routing). Deviations from the spec are recorded under `## Risk Assessment`.

## Goal

Add the Codex CLI as a third subagent execution backend selectable as `cli: "codex"`, with parity to the Claude backend across both transports (headless `codex exec`, interactive mux-pane `codex`). Parity covers direct launches, serial/parallel orchestration, completion semantics, cancellation/error handling, model/thinking mapping, resume, and guarded-vs-unrestricted execution policy mapped onto Codex sandbox/approval controls. Existing `pi` and `claude` behavior is preserved unchanged, and the user's persistent `~/.codex/config.toml` is never mutated.

## Architecture summary

The backend layer is two-tiered: `resolveLaunchSpec()` (`src/launch/launch-spec.ts`) normalizes a launch into a CLI-agnostic `ResolvedLaunchSpec` (`effectiveCli`, `effectiveModel`, `effectiveThinking`, `effectiveExecutionPolicy`, cwd/session placement, identity). Two transports consume the spec: `makeHeadlessBackend()` (`src/backends/headless.ts`) spawns child processes and parses JSON streams; `makePaneBackend()` (`src/backends/pane.ts`) delegates to `launchSubagent()`/`watchSubagent()` (`src/index.ts`) which drive mux panes. `selectBackend()` chooses transport independent of CLI. Each transport branches on `effectiveCli`.

Codex slots in as a third branch in each transport:

- **Headless:** a new `runCodexHeadless()` runner spawns `codex exec [resume <id>]` with `--json --output-last-message <file> --cd <cwd> --skip-git-repo-check`, delivers the prompt via stdin, tees the JSONL stream to an archive file, and parses session id / transcript / usage / final message. Completion = process close + final-message file + JSONL terminal event.
- **Pane:** a new `launchSubagent()` Codex branch runs interactive `codex` with policy flags and a `subagent_done` MCP completion server registered via **per-launch `codex -c mcp_servers.<name>.{command,args,env}` overrides** (the spec's sole, verified injection mechanism — writes nothing to disk). A new `watchSubagent()` Codex branch reuses `pollForExit()`'s existing `sentinelFile` plumbing for completion and reads the sentinel content (written by the MCP `subagent_done` tool) as the summary, with a screen-scrape fallback — mirroring the Claude pane path minus the `--plugin-dir`/Stop-hook machinery.

Several existing `cli === "claude"` / `cli !== "claude"` branch sites are generalized so the "non-pi process-spawn CLI" behavior (no pi session file, no pi activity snapshot, late/absent session key, time-based status) is shared by Claude and Codex: those `!== "claude"` / `=== "claude"` checks that actually mean "pi-only" / "non-pi" are flipped to `=== "pi"` / `!== "pi"`, and the explicit Claude-only branches gain a parallel Codex branch.

The same stdio MCP `subagent_done` server under `src/claude-plugin/mcp/` serves both CLIs: it is generalized to read a CLI-neutral sentinel env var (`PI_SUBAGENT_DONE_SENTINEL`) with a back-compat fallback to `PI_CLAUDE_SENTINEL`. Codex passes the neutral var through the `-c mcp_servers.<name>.env` table; the Claude path is left exactly as-is (still exports `PI_CLAUDE_SENTINEL`, hooks unchanged).

## Tech stack

- **Language/runtime:** TypeScript (ESM, `"type": "module"`), Node.js (built-in `node --test` runner), pnpm.
- **Key deps:** `typebox` (tool parameter schemas), `@modelcontextprotocol/sdk` (stdio MCP completion server), `@earendil-works/pi-coding-agent` / `pi-tui` (peer), esbuild + tsc (builds: `build:plugin` compiles `src/claude-plugin` → `mcp/server.js`).
- **New external dependency (runtime, optional/gated):** the `codex` binary on `PATH` (Codex CLI ≥ the locally installed `0.136.0`). No npm dependency, no binary-path override, no version gate.

## File Structure

```
- `src/backends/codex-stream.ts` (Create) — Codex command construction (headless argv + pane parts) and JSONL stream parsing: buildCodexExecArgs, buildCodexPaneCmdParts, parseCodexEvent, parseCodexResult, extractCodexSessionId, codexReasoningEffort, codexSandboxArgs.
- `src/backends/codex-mcp.ts` (Create) — Pane-only MCP completion-server injection: resolveCodexMcpServerPath, buildCodexMcpOverrideArgs, CODEX_COMPLETION_SERVER_NAME, CODEX_SENTINEL_ENV.
- `src/backends/headless.ts` (Modify) — Flip pi-only gates to `=== "pi"`; add runCodexHeadless; route `effectiveCli === "codex"`.
- `src/backends/pane.ts` (Modify) — Flip claude gates to `=== "pi"` so Codex shares the late/absent-session-key path.
- `src/index.ts` (Modify) — Codex pane launch branch (launchSubagent); Codex completion branch + onTick restructure (watchSubagent); widget label, observeRunningSubagent, handleSubagentInterrupt include codex; warnCodexUnsupportedFeatures helper; export buildCodexPaneCmdParts for tests.
- `src/launch/launch-spec.ts` (Modify) — Add codexModelArg (reuse provider-strip); warnGuardedPolicyUnsupported early-returns for codex; update SubagentParams.cli / thinking / executionPolicy descriptions.
- `src/orchestration/types.ts` (Modify) — OrchestrationTaskSchema.cli / thinking descriptions mention codex.
- `src/orchestration/default-deps.ts` (Modify) — Status `source` selection: codex → claude semantics (no activity file).
- `src/claude-plugin/mcp/server.ts` (Modify) — Read CLI-neutral PI_SUBAGENT_DONE_SENTINEL with fallback to PI_CLAUDE_SENTINEL; update error text.
- `src/claude-plugin/mcp/server.js` (Modify, generated) — Rebuilt from server.ts via `pnpm run build:plugin`.
- `test/integration/harness.ts` (Modify) — Add getTestModel(cli) with per-CLI defaults + global PI_TEST_MODEL override; re-point TEST_MODEL consumers.
- `package.json` (Modify) — Add Codex slow-lane integration test files to the `test:integration:slow` script.
- `README.md` (Modify) — Codex usage examples; promote execution-policy table row to implemented with per-mode rows; document sandbox-not-classifier and never-mutate-config guarantees.
- `test/orchestration/codex-command-construction.test.ts` (Create) — Unit: headless argv + pane parts (flags, model, thinking, policy, resume, cwd, json/output-last-message, MCP overrides).
- `test/orchestration/codex-stream-parsing.test.ts` (Create) — Unit: JSONL event → transcript, result shaping, session-id extraction, usage, defensive parsing.
- `test/orchestration/codex-routing.test.ts` (Create) — Unit: headless routes codex via injected runner seam; missing-binary error wording.
- `test/orchestration/codex-skills-warning.test.ts` (Create) — Unit: warnCodexUnsupportedFeatures warns and ignores skills/tools.
- `test/plugin-mcp.test.ts` (Modify) — Add cases for PI_SUBAGENT_DONE_SENTINEL and fallback precedence.
- `test/integration/headless-codex-enoent.test.ts` (Create) — Integration (ungated): missing codex → clear error.
- `test/integration/headless-codex-smoke.test.ts` (Create) — Integration (gated: which codex + PI_RUN_SLOW): unique-marker headless run.
- `test/integration/pane-codex-interactive.test.ts` (Create) — Integration (gated): pane MCP subagent_done completion; persistent config unchanged.
- `test/integration/orchestration-codex-pane.test.ts` (Create) — Integration (gated): serial + parallel Codex pane orchestration.
```

Design principles applied: command construction + stream parsing live together in one focused module (`codex-stream.ts`) mirroring `claude-stream.ts`; pane-only MCP injection is isolated in `codex-mcp.ts` so it is unit-testable without spawning Codex; routing edits stay inside the existing transport files; no new transport abstraction is introduced (see Risk Assessment for the CLI-seam decision).

---

## Tasks

### Task 1 — Codex command builder + JSONL stream parsing (`codex-stream.ts`)

**Files:**
- Create: `src/backends/codex-stream.ts`
- Test: `test/orchestration/codex-command-construction.test.ts`, `test/orchestration/codex-stream-parsing.test.ts`

**Steps:**

- [ ] **Step 1: Create the module skeleton and mapping helpers.** Create `src/backends/codex-stream.ts` importing `TranscriptContent, TranscriptMessage, UsageStats` from `./types.ts`, `ResolvedLaunchSpec` from `../launch/launch-spec.ts`, and `shellEscape` from `../mux/shell.ts`. Add the supported reasoning-effort set and mapper:
  ```ts
  const CODEX_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
  export function codexReasoningEffort(thinking: string | undefined): string | undefined {
    if (!thinking) return undefined;
    const v = thinking.toLowerCase().trim();
    return CODEX_REASONING_EFFORTS.has(v) ? v : undefined; // "off"/unknown → omitted
  }
  ```
- [ ] **Step 2: Add the sandbox/approval policy mapper.** Add `codexSandboxArgs(policy: "guarded" | "unrestricted", transport: "headless" | "pane"): string[]`:
  ```ts
  export function codexSandboxArgs(policy, transport) {
    if (policy === "unrestricted") return ["--dangerously-bypass-approvals-and-sandbox"];
    // guarded:
    return transport === "headless"
      ? ["--sandbox", "workspace-write", "-c", 'approval_policy="never"']   // non-interactive: cannot answer prompts
      : ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]; // interactive: a human can answer
  }
  ```
- [ ] **Step 3: Add the headless argv builder.** Add `buildCodexExecArgs(spec: ResolvedLaunchSpec, opts: { outputLastMessageFile: string; cwd: string }): string[]` returning raw argv (no shell escaping; spawned with `shell:false`). Order: subcommand, resume, then flags. The prompt is NOT included (delivered via stdin by the runner).
  ```ts
  export function buildCodexExecArgs(spec, opts) {
    const args: string[] = ["exec"];
    if (spec.resumeSessionId) args.push("resume", spec.resumeSessionId);
    args.push("--json", "--output-last-message", opts.outputLastMessageFile,
              "--cd", opts.cwd, "--skip-git-repo-check");
    if (spec.codexModelArg) args.push("--model", spec.codexModelArg);
    const effort = codexReasoningEffort(spec.effectiveThinking);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    args.push(...codexSandboxArgs(spec.effectiveExecutionPolicy, "headless"));
    return args;
  }
  ```
- [ ] **Step 4: Add the pane parts builder.** Add `buildCodexPaneCmdParts(input: { model?: string; effectiveThinking?: string; executionPolicy: "guarded" | "unrestricted"; mcpOverrideArgs: string[]; task: string }): string[]` returning shell-escaped parts for the pane command (mirroring `buildClaudeCmdParts`). It appends `--`, then the escaped prompt:
  ```ts
  export function buildCodexPaneCmdParts(input) {
    const parts: string[] = ["codex"];
    parts.push(...codexSandboxArgs(input.executionPolicy, "pane").map(shellEscape));
    if (input.model) parts.push("--model", shellEscape(input.model));
    const effort = codexReasoningEffort(input.effectiveThinking);
    if (effort) parts.push("-c", shellEscape(`model_reasoning_effort="${effort}"`));
    parts.push(...input.mcpOverrideArgs.map(shellEscape));   // already raw `-c key=value` tokens
    if (input.task !== "") { parts.push("--"); parts.push(shellEscape(input.task)); }
    return parts;
  }
  ```
  Note: `codexSandboxArgs` already returns alternating `-c` / value tokens for guarded-headless, but the pane variant returns `--sandbox workspace-write --ask-for-approval on-request`; map each token through `shellEscape` individually so they stay separate argv words.
- [ ] **Step 5: Add JSONL event → transcript projection.** Add `parseCodexEvent(event: Record<string, unknown>): TranscriptMessage[] | undefined`. Codex `--json` emits SDK-shaped `ThreadEvent` lines; the load-bearing one is `item.completed` carrying an `item` with a `type`. Project defensively:
  ```ts
  export function parseCodexEvent(event) {
    if (event.type !== "item.completed") return undefined;
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return undefined;
    if (item.type === "agent_message" && typeof item.text === "string")
      return [{ role: "assistant", content: [{ type: "text", text: item.text }] }];
    if (item.type === "reasoning" && typeof item.text === "string")
      return [{ role: "assistant", content: [{ type: "thinking", thinking: item.text }] }];
    if (item.type === "command_execution" || item.type === "tool_call" || item.type === "mcp_tool_call")
      return [{ role: "assistant", content: [{ type: "toolCall",
        id: String(item.id ?? ""), name: String((item.name ?? item.command ?? item.type)).toLowerCase(),
        arguments: (item as any).arguments ?? (item as any).command ?? {} }] }];
    return undefined; // unknown item types are skipped, not fabricated
  }
  ```
- [ ] **Step 6: Add session-id extraction and result/usage parsing.** Add:
  ```ts
  export function extractCodexSessionId(event): string | undefined {
    // Defensive: the id field name is version-sensitive. Check the known carriers.
    if (event.type === "thread.started") {
      const e: any = event;
      const id = e.thread_id ?? e.threadId ?? e.session_id ?? e.sessionId ?? e.thread?.id;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    }
    return undefined;
  }
  export interface CodexUsageDelta { usage: UsageStats; }
  export function parseCodexUsage(event): UsageStats | undefined {
    if (event.type !== "turn.completed") return undefined;
    const u = ((event as any).usage ?? {}) as Record<string, number>;
    const input = u.input_tokens ?? u.input ?? 0;
    const output = u.output_tokens ?? u.output ?? 0;
    const cacheRead = u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0;
    return { input, output, cacheRead, cacheWrite: 0, cost: 0,
             contextTokens: input + output + cacheRead, turns: 0 };
  }
  ```
  (`cost` defaults to `0` — Codex JSONL does not report per-call USD; `turns` is incremented by the runner per assistant event, matching `runClaudeHeadless`.)
- [ ] **Step 7: Write command-construction unit tests.** In `test/orchestration/codex-command-construction.test.ts` assert: headless guarded argv contains `exec`, `--json`, `--output-last-message`, `--cd`, `--skip-git-repo-check`, `--sandbox workspace-write`, and `approval_policy="never"`, and does NOT contain `--dangerously-bypass-approvals-and-sandbox`; headless unrestricted contains `--dangerously-bypass-approvals-and-sandbox` and no `--sandbox`; `resumeSessionId` set → argv starts `exec resume <id>`; `codexModelArg` → `--model <bare>`; thinking `high` → `-c model_reasoning_effort="high"`; thinking `off` → no `model_reasoning_effort` token. For pane parts: guarded → `--ask-for-approval on-request`; unrestricted → bypass flag; `mcpOverrideArgs` tokens are present; prompt is after `--`.
- [ ] **Step 8: Write stream-parsing unit tests.** In `test/orchestration/codex-stream-parsing.test.ts` assert: `item.completed` with `agent_message` → one assistant text message; `reasoning` → thinking; `command_execution` → toolCall; unknown item type → `undefined`; `thread.started` with each of `thread_id`/`session_id` → extracted id; `thread.started` without any id field → `undefined`; `turn.completed` usage maps `input_tokens`/`output_tokens`/`cached_input_tokens` and leaves `cost: 0`.

**Acceptance criteria:**

- `buildCodexExecArgs` emits the documented headless flags for both policies and the resume subcommand.
  Verify: run `node --test test/orchestration/codex-command-construction.test.ts` and confirm exit code 0 with no `FAIL`/`not ok` lines.
- JSONL parsing projects known event/item types and refuses to fabricate unknown ones or missing session ids.
  Verify: run `node --test test/orchestration/codex-stream-parsing.test.ts` and confirm exit code 0; additionally `grep -n "thread.started" src/backends/codex-stream.ts` returns a match inside `extractCodexSessionId`.
- The module type-checks against existing `BackendResult`/`TranscriptMessage` types.
  Verify: run `pnpm typecheck` and confirm exit code 0 (no errors referencing `src/backends/codex-stream.ts`).

**Model recommendation:** standard

---

### Task 2 — Codex MCP completion-server injection (`codex-mcp.ts`) + generalize the shared MCP server

**Files:**
- Create: `src/backends/codex-mcp.ts`
- Modify: `src/claude-plugin/mcp/server.ts`, `src/claude-plugin/mcp/server.js` (regenerated)
- Test: `test/orchestration/codex-mcp-injection.test.ts` (Create), `test/plugin-mcp.test.ts` (Modify)

**Steps:**

- [ ] **Step 1: Generalize the MCP server sentinel env var.** In `src/claude-plugin/mcp/server.ts`, change the sentinel read from `const sentinel = process.env.PI_CLAUDE_SENTINEL;` to:
  ```ts
  const sentinel = process.env.PI_SUBAGENT_DONE_SENTINEL ?? process.env.PI_CLAUDE_SENTINEL;
  ```
  Update the not-set error text (line ~62) to: `"Neither sentinel env var is set: PI_SUBAGENT_DONE_SENTINEL is unset and PI_CLAUDE_SENTINEL is not set — subagent_done is only valid in pi-spawned Claude/Codex sessions."`. This new text MUST keep the exact substring `PI_CLAUDE_SENTINEL is not set` so the existing unset-env assertion in `test/plugin-mcp.test.ts` (`assert.match(text, /PI_CLAUDE_SENTINEL is not set/)`) keeps matching with that test left unmodified — do not rephrase or drop that substring. Do NOT remove the `PI_CLAUDE_SENTINEL` fallback (the Claude pane path and its hooks still set only that var).
- [ ] **Step 2: Rebuild the server bundle.** Run `pnpm run build:plugin` so `src/claude-plugin/mcp/server.js` is regenerated from the edited `server.ts`. (The pane Codex path and `plugin-mcp.test.ts` both load `server.js`.)
- [ ] **Step 3: Create the injection helper.** Create `src/backends/codex-mcp.ts`:
  ```ts
  import { dirname, join } from "node:path";
  import { fileURLToPath } from "node:url";

  export const CODEX_COMPLETION_SERVER_NAME = "pi_subagent"; // TOML key segment: [a-z0-9_]
  export const CODEX_SENTINEL_ENV = "PI_SUBAGENT_DONE_SENTINEL";

  export function resolveCodexMcpServerPath(): string {
    // src/backends/codex-mcp.ts -> src/claude-plugin/mcp/server.js
    return join(dirname(fileURLToPath(import.meta.url)), "..", "claude-plugin", "mcp", "server.js");
  }

  // Returns RAW `-c key=value` tokens (no shell escaping). The pane caller
  // shell-escapes each token. The value portion is parsed by Codex as TOML.
  export function buildCodexMcpOverrideArgs(input: { sentinelFile: string; serverPath?: string }): string[] {
    const name = CODEX_COMPLETION_SERVER_NAME;
    const serverPath = input.serverPath ?? resolveCodexMcpServerPath();
    return [
      "-c", `mcp_servers.${name}.command="node"`,
      "-c", `mcp_servers.${name}.args=["${serverPath}"]`,
      "-c", `mcp_servers.${name}.env.${CODEX_SENTINEL_ENV}="${input.sentinelFile}"`,
    ];
  }
  ```
  Constraint: the server name must be a TOML-bare-key-safe identifier (`[a-z0-9_]+`) — use `pi_subagent` (underscore), not `pi-subagent`, because dotted `-c` paths split on `.` and a hyphen is fine but underscore avoids any quoting ambiguity. The `args` array value must be valid TOML (`["..."]`), and the path must not contain `"`; paths under the package install root never do.
- [ ] **Step 4: Write MCP-injection unit tests.** In `test/orchestration/codex-mcp-injection.test.ts` assert: `buildCodexMcpOverrideArgs({ sentinelFile: "/tmp/s" })` returns exactly six tokens, three `-c` flags interleaved with `mcp_servers.pi_subagent.command="node"`, `mcp_servers.pi_subagent.args=[...server.js...]`, and `mcp_servers.pi_subagent.env.PI_SUBAGENT_DONE_SENTINEL="/tmp/s"`; `resolveCodexMcpServerPath()` ends with `claude-plugin/mcp/server.js`.
- [ ] **Step 5: Extend the plugin-mcp test for the neutral env var.** In `test/plugin-mcp.test.ts`, add a case `subagent_done writes to PI_SUBAGENT_DONE_SENTINEL when set` (driving `withClient({ PI_SUBAGENT_DONE_SENTINEL: sentinel })` and asserting the file content), and a precedence case: when BOTH `PI_SUBAGENT_DONE_SENTINEL` and `PI_CLAUDE_SENTINEL` are set to different paths, the write lands at the `PI_SUBAGENT_DONE_SENTINEL` path. Leave the existing `PI_CLAUDE_SENTINEL` cases intact (they must still pass via the fallback).

**Acceptance criteria:**

- The shared MCP server writes the sentinel from the neutral var, falling back to `PI_CLAUDE_SENTINEL`, with the neutral var taking precedence.
  Verify: run `pnpm run build:plugin` then `node --test test/plugin-mcp.test.ts` and confirm exit code 0 with the new `PI_SUBAGENT_DONE_SENTINEL` and precedence cases present and passing.
- `buildCodexMcpOverrideArgs` produces three `-c` overrides registering command/args/env for one MCP server, and never writes to disk.
  Verify: run `node --test test/orchestration/codex-mcp-injection.test.ts` and confirm exit code 0; additionally `grep -n "writeFileSync\\|mkdirSync\\|CODEX_HOME" src/backends/codex-mcp.ts` returns no matches.
- Existing Claude plugin-mcp cases remain unchanged and passing.
  Verify: open `test/plugin-mcp.test.ts` and confirm the original four `PI_CLAUDE_SENTINEL` `it(...)` blocks are still present and unmodified, then confirm they pass in the `node --test test/plugin-mcp.test.ts` run above.

**Model recommendation:** standard

---

### Task 3 — Launch-spec Codex integration (model projection, guarded-policy recognition, schema docs)

**Files:**
- Modify: `src/launch/launch-spec.ts`, `src/orchestration/types.ts`
- Test: `test/orchestration/codex-launch-spec.test.ts` (Create)

**Steps:**

- [ ] **Step 1: Add `codexModelArg` to the resolved spec.** In `src/launch/launch-spec.ts`, reuse the existing provider-prefix stripper. Rename `projectModelForClaude` is NOT required — call it for Codex too. Add the field to `ResolvedLaunchSpec`:
  ```ts
  /** Codex-only projection of `effectiveModel`: strips a leading `<provider>/` prefix (same contract as claudeModelArg). */
  codexModelArg: string | undefined;
  ```
  and in `resolveLaunchSpec()` compute `const codexModelArg = projectModelForClaude(effectiveModel);` next to `claudeModelArg`, and include `codexModelArg` in the returned object.
- [ ] **Step 2: Recognize Codex as guarded-capable.** In `warnGuardedPolicyUnsupported()`, add an early return so Codex never triggers the "no guarded mode" warning. Change the guard block to:
  ```ts
  if (spec.effectiveCli === "claude" || spec.effectiveCli === "codex") return;
  ```
  (Codex implements guarded via sandbox/approval flags; only pi lacks a guarded mode.)
- [ ] **Step 3: Update tool-parameter descriptions.** In `SubagentParams` (`launch-spec.ts`), update the `cli` description to: `"CLI to launch for this subagent. One of 'pi' (default), 'claude', or 'codex'. Overrides the agent frontmatter `cli` field."`. Update the `thinking` description to append: `"For Codex: mapped to -c model_reasoning_effort=<minimal|low|medium|high|xhigh>; unsupported values (e.g. off) are omitted."`. Update the `executionPolicy` description to append a Codex clause: `"For Codex: guarded → --sandbox workspace-write with non-interactive approval_policy=never (headless) / --ask-for-approval on-request (pane); unrestricted → --dangerously-bypass-approvals-and-sandbox."`.
- [ ] **Step 4: Update orchestration schema descriptions.** In `src/orchestration/types.ts`, change the `OrchestrationTaskSchema.cli` description to `"'pi' (default), 'claude', or 'codex'. Free-form string; unknown values fall back to the pi path."` and append to the `thinking` description: `"For Codex, mapped to model_reasoning_effort; unsupported values dropped."` and append to `executionPolicy` a brief Codex note mirroring Step 3.
- [ ] **Step 5: Write launch-spec unit tests.** In `test/orchestration/codex-launch-spec.test.ts`: resolve a spec with `cli: "codex"`, `model: "openai-codex/gpt-5.4-mini"` against a minimal ctx stub (copy the ctx-stub shape from `test/orchestration/default-deps.test.ts` or construct `getSessionId/getSessionDir/getSessionFile`), and assert `spec.codexModelArg === "gpt-5.4-mini"` and `spec.effectiveCli === "codex"`. Assert that `warnGuardedPolicyUnsupported({ effectiveCli: "codex", effectiveExecutionPolicy: "guarded", executionPolicySource: "params", name: "x" }, write)` invokes the injected `write` ZERO times, while the same call with `effectiveCli: "pi"` invokes it once.

**Acceptance criteria:**

- A `cli: "codex"` launch resolves `codexModelArg` by stripping the provider prefix, with bare names passing through.
  Verify: run `node --test test/orchestration/codex-launch-spec.test.ts` and confirm exit code 0 and the `codexModelArg === "gpt-5.4-mini"` assertion passes.
- Codex never emits a spurious guarded-unsupported warning while pi still does.
  Verify: in the same test run, confirm the two `warnGuardedPolicyUnsupported` assertions (codex: 0 writes; pi: 1 write) pass; additionally `grep -n 'effectiveCli === "codex"' src/launch/launch-spec.ts` returns a match inside `warnGuardedPolicyUnsupported`.
- Tool/orchestration schemas advertise `codex` as a valid `cli`.
  Verify: `grep -n "codex" src/launch/launch-spec.ts src/orchestration/types.ts` shows the updated `cli` descriptions in both `SubagentParams` and `OrchestrationTaskSchema`.

**Model recommendation:** cheap

---

### Task 4 — Headless Codex runner and routing

**Files:**
- Modify: `src/backends/headless.ts`
- Test: `test/orchestration/codex-routing.test.ts` (Create), `test/integration/headless-codex-enoent.test.ts` (Create)

**Steps:**

- [ ] **Step 1: Flip pi-only gates to `=== "pi"`.** In `makeHeadlessBackend().launch()`, change the activity-file guard `if (spec.effectiveCli !== "claude") {` (around the `piActivityFile` block) to `if (spec.effectiveCli === "pi") {` — only pi children write the pi activity snapshot. Change the launch-handle spread `...(spec.effectiveCli !== "claude" ? { sessionKey: spec.subagentSessionFile, activityFile: piActivityFile } : {})` to `...(spec.effectiveCli === "pi" ? { sessionKey: spec.subagentSessionFile, activityFile: piActivityFile } : {})`. In `makeAbortedResult()`, change `...(spec.effectiveCli !== "claude" ? { sessionKey: spec.subagentSessionFile } : {})` to `...(spec.effectiveCli === "pi" ? { sessionKey: spec.subagentSessionFile } : {})`. This ensures Codex (like Claude) carries no early pi session key / activity file.
- [ ] **Step 2: Route the codex runner.** Change the runner dispatch in `launch()` from the two-way ternary to a three-way:
  ```ts
  entry.promise =
    spec.effectiveCli === "claude"
      ? runClaudeHeadless({ id, spec, startTime, abort: abort.signal, ctx, emitPartial: emit })
      : spec.effectiveCli === "codex"
        ? runCodexHeadless({ id, spec, startTime, abort: abort.signal, ctx, emitPartial: emit })
        : runPiHeadless({ id, spec, startTime, abort: abort.signal, ctx, emitPartial: emit });
  ```
- [ ] **Step 2.5: Add a codex __test__ runner seam.** Extend the existing `__test__.makeHeadlessBackendWithRunner` usage is unchanged; additionally export the codex runner indirection so `codex-routing.test.ts` can assert dispatch. Simplest: add `let runCodexHeadlessImpl = runCodexHeadless;` is unnecessary — instead, the routing test injects via the existing `__test__.makeHeadlessBackendWithRunner` (which bypasses CLI routing). For routing assertion, use `__test__.setSpawn` to capture the spawned binary name (see Step 7). No new seam required.
- [ ] **Step 3: Implement `runCodexHeadless` — setup.** Add an `async function runCodexHeadless(p: RunParams): Promise<BackendResult>` mirroring `runClaudeHeadless`'s structure. Setup:
  ```ts
  const { id, spec, startTime, abort, ctx, emitPartial: emit } = p;
  const transcript: TranscriptMessage[] = [];
  const usage: UsageStats = emptyUsage();
  let hasRealUsage = false;
  let stderr = "";
  let sessionId: string | undefined;
  let sawTerminal = false;
  const rawLines: string[] = []; // teed JSONL for archival
  warnCodexUnsupportedFeatures(spec.name, spec.effectiveSkills, spec.effectiveTools); // from index.ts re-export
  const cwd = spec.effectiveCwd ?? ctx.cwd;
  const outFile = join(spec.artifactDir, "codex", `${id}-last-message.txt`);
  mkdirSync(dirname(outFile), { recursive: true });
  const args = buildCodexExecArgs(spec, { outputLastMessageFile: outFile, cwd });
  // Resume requires a session id; if resumeSessionId is empty string, fail deterministically.
  if (spec.resumeSessionId !== undefined && spec.resumeSessionId.trim() === "") {
    return { name: spec.name, finalMessage: "", transcriptPath: null, exitCode: 1,
             elapsedMs: Date.now() - startTime, error: "codex resume requested without a session id" };
  }
  if (abort.aborted) return makeAbortedResult(spec, startTime, transcript, usage);
  ```
  Import `buildCodexExecArgs`, `parseCodexEvent`, `parseCodexUsage`, `extractCodexSessionId` from `./codex-stream.ts`, and `warnCodexUnsupportedFeatures` from `../index.ts`.
- [ ] **Step 4: Implement `runCodexHeadless` — spawn + stream.** Spawn `spawnImpl("codex", args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...spec.configRootEnv } })`. Deliver the prompt via stdin: `proc.stdin!.write(spec.fullTask); proc.stdin!.end();` (Codex uses `spec.fullTask`, which carries the identity roleBlock — Codex has no system-prompt flag). Wire `LineBuffer` on stdout: for each line push to `rawLines`, `JSON.parse` defensively, then: `extractCodexSessionId` → set `sessionId`; `parseCodexEvent` → push messages, and on any assistant message increment `usage.turns`, set `hasRealUsage`, and `emit` a partial (mirror `runClaudeHeadless`'s assistant-event emit, including `sessionId`); `parseCodexUsage` → merge token fields into `usage`, set `hasRealUsage`; mark `sawTerminal = true` on `turn.completed`. Reuse the existing `makeAbortHandler`, `proc.on("error", ...)` (ENOENT → `"codex CLI not found on PATH"`), and the `settled`/`settle` guard pattern from `runClaudeHeadless`.
- [ ] **Step 5: Implement `runCodexHeadless` — close handler.** On `close`, flush the line buffer, compute `elapsedMs`/`exitCode`. Read the final message: `let finalMessage = ""; try { finalMessage = readFileSync(outFile, "utf8").trim(); } catch {}`; if empty, fall back to `getFinalOutput(transcript)`. Archive the teed JSONL: write `rawLines.join("\n")` to `~/.pi/agent/sessions/codex-cli/<sessionId|id>.jsonl` (via `mkdirSync` + `writeFileSync`; wrap in try/catch and set `transcriptPath` to the archived path or `null` on failure). Resolve `BackendResult` with the same precedence as `runClaudeHeadless`: aborted → exitCode 1 error "aborted"; `exitCode !== 0` → error `stderr.trim() || "codex exited with code <n>"`; `!sawTerminal` → exitCode 1 error `"child exited without completion event"`; else success. Always include `sessionId`, `sessionKey: sessionId`, `usage` (when `hasRealUsage`), `transcript`, `transcriptPath`. If `exitCode === 0` and no `sessionId` was seen, write a one-line stderr warning `"[pi-interactive-subagent] <name>: no thread.started session id seen — resume will be unavailable (Codex JSON format may have changed)"` (mirrors the Claude no-init warning; never fabricate an id).
- [ ] **Step 6: Write the routing unit test.** In `test/orchestration/codex-routing.test.ts`, use `__test__.setSpawn` to install a fake spawn that records the binary name and returns a stub child (mirror the fake-spawn pattern; emit a `thread.started` then `turn.completed` JSON line on stdout, then `close` with code 0). Launch with `{ task: "t", cli: "codex" }` through `makeHeadlessBackend` and assert the recorded spawn binary is `"codex"` and the argv contains `exec` and `--json`. Restore with `__test__.restoreSpawn()` in `afterEach`.
- [ ] **Step 7: Write the ENOENT integration test.** Create `test/integration/headless-codex-enoent.test.ts` mirroring `test/integration/headless-enoent.test.ts` exactly but with `{ task: "nop", cli: "codex" }` and asserting `result.exitCode === 1` and `result.error` matches `/codex CLI not found on PATH/` (set `process.env.PATH = "/nonexistent"` in `before`, restore in `after`).

**Acceptance criteria:**

- `cli: "codex"` headless launches spawn the `codex` binary with `exec --json` argv.
  Verify: run `node --test test/orchestration/codex-routing.test.ts` and confirm exit code 0 and the spawn-binary assertion (`"codex"`) passes.
- A missing `codex` binary yields `codex CLI not found on PATH`.
  Verify: run `node --test test/integration/headless-codex-enoent.test.ts` and confirm exit code 0 (the `/codex CLI not found on PATH/` assertion passes).
- Codex headless never writes a pi activity file and carries no early pi session key.
  Verify: open `src/backends/headless.ts` and confirm the activity-file guard, the launch-handle spread, and the `makeAbortedResult` spread all read `spec.effectiveCli === "pi"` (not `!== "claude"`).
- The runner type-checks and integrates with `BackendResult`.
  Verify: run `pnpm typecheck` and confirm exit code 0 with no errors referencing `runCodexHeadless`.

**Model recommendation:** capable

---

### Task 5 — Pane Codex launch, watch completion, and shared-branch generalization

**Files:**
- Modify: `src/index.ts`, `src/backends/pane.ts`, `src/orchestration/default-deps.ts`
- Test: `test/orchestration/codex-skills-warning.test.ts` (Create), `test/orchestration/codex-pane-cmd.test.ts` (Create)

**Steps:**

- [ ] **Step 1: Add `warnCodexUnsupportedFeatures` and re-export.** In `src/index.ts`, add next to `warnClaudeSkillsDropped`:
  ```ts
  export function warnCodexUnsupportedFeatures(
    subagentName: string, effectiveSkills: string | undefined, effectiveTools: string | undefined,
  ): void {
    if (effectiveSkills && effectiveSkills.trim() !== "")
      process.stderr.write(`[pi-interactive-subagent] ${subagentName}: ignoring skills=${effectiveSkills} on Codex path — not supported in v1\n`);
    if (effectiveTools && effectiveTools.trim() !== "")
      process.stderr.write(`[pi-interactive-subagent] ${subagentName}: ignoring tools=${effectiveTools} on Codex path — pi tool allowlists are not applied (the internal subagent_done MCP tool is always available)\n`);
  }
  ```
- [ ] **Step 2: Add the pane builder import + Codex launch branch.** In `src/index.ts`, import `buildCodexPaneCmdParts` from `./backends/codex-stream.ts` and `buildCodexMcpOverrideArgs` from `./backends/codex-mcp.ts`, and add `buildClaudeCompletionAddendum` to the existing `./launch/launch-spec.ts` import block in `src/index.ts` (it is exported from `src/launch/launch-spec.ts` but is not yet imported there; `spec.autoExit` is a `boolean` field already on `ResolvedLaunchSpec`, so `buildClaudeCompletionAddendum(spec.autoExit)` type-checks once the import is added). In `launchSubagent()`, after the Claude branch (`if (spec.effectiveCli === "claude") { ... return running; }`), add a Codex branch before the Pi path:
  ```ts
  if (spec.effectiveCli === "codex") {
    const sentinelFile = `/tmp/pi-codex-${id}-done`;
    warnCodexUnsupportedFeatures(params.name, spec.effectiveSkills, spec.effectiveTools);
    const addendum = buildClaudeCompletionAddendum(spec.autoExit); // CLI-neutral text ("call subagent_done")
    const promptBody = `${spec.fullTask}\n\n${addendum}`;            // identity is already in spec.fullTask
    const mcpOverrideArgs = buildCodexMcpOverrideArgs({ sentinelFile });
    const cmdParts = buildCodexPaneCmdParts({
      model: spec.codexModelArg,
      effectiveThinking: spec.effectiveThinking,
      executionPolicy: spec.effectiveExecutionPolicy,
      mcpOverrideArgs,
      task: promptBody,
    });
    const cdPrefix = buildPaneCdPrefix(spec.effectiveCwd, ctx.cwd);
    const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
    lastLaunchCommand = command;
    const launchScriptName = `${safeScriptName(params.name, "subagent")}-${id}.sh`;
    const launchScriptFile = join(spec.artifactDir, "subagent-scripts", launchScriptName);
    if (surfaceOverrides?.sendLongCommand) surfaceOverrides.sendLongCommand(surface, command);
    else sendLongCommand(surface, command, { scriptPath: launchScriptFile, scriptPreamble: [
      `# Codex subagent launch script for ${params.name}`, `# Generated: ${new Date().toISOString()}`, `# Surface: ${surface}`,
    ].join("\n") });
    const running: RunningSubagent = {
      id, name: params.name, task: params.task, agent: params.agent, backend: "pane",
      surface, startTime, sessionFile: spec.subagentSessionFile, launchScriptFile,
      cli: "codex", sentinelFile, interactive: spec.effectiveInteractive,
      statusState: createStatusState({ source: "claude", startTimeMs: startTime }), // codex shares claude (no activity file) status semantics
    };
    runningSubagents.set(id, running);
    startWidgetRefresh();
    if (piForRegistry) startStatusRefresh(piForRegistry);
    return running;
  }
  ```
  Set `lastLaunchCommand = command;` before send so `__test__.getLastLaunchCommand()` can assert argv (the Claude branch sets it via `sendLongCommand`; for parity in tests, set it explicitly here as shown).
- [ ] **Step 3: Generalize widget label for codex.** In `renderSubagentWidgetLines()`, change `} else if (agent.cli === "claude") {` (the `" running… "` label branch) to `} else if (agent.cli === "claude" || agent.cli === "codex") {`.
- [ ] **Step 4: Generalize `observeRunningSubagent` for codex.** Change `if (running.cli === "claude") return; // claude has no activity file` to `if (running.cli === "claude" || running.cli === "codex") return; // claude/codex have no activity file`.
- [ ] **Step 5: Generalize `handleSubagentInterrupt` for codex.** Change `if (running.cli === "claude") {` to `if (running.cli === "claude" || running.cli === "codex") {` and update its message to `"Turn-only Escape interrupt is currently supported only for pane-Pi subagents. Claude/Codex-backed semantics have not been verified yet."`.
- [ ] **Step 6: Restructure `watchSubagent` tick + final branches.** In `watchSubagent()`:
  - Change the tailStartLine seek guard `opts.tailStartLine && ... && running.cli !== "claude" && sessionFile` to `... && running.cli === "pi" && sessionFile`.
  - Change `if (running.cli !== "claude") maybeFire(running.sessionFile);` to `if (running.cli === "pi") maybeFire(running.sessionFile);`.
  - In `onTick`, change `if (running.cli !== "claude") { drainPiTail(); } else { /* claude tail */ }` to a three-way: `if (running.cli === "pi") { drainPiTail(); } else if (running.cli === "claude") { /* existing claude tail */ } /* codex: no-op on tick */`.
  - Change the final post-loop pi drain guard `if (running.cli !== "claude") { drainPiTail(); }` to `if (running.cli === "pi") { drainPiTail(); }`.
- [ ] **Step 7: Add the Codex completion block in `watchSubagent`.** Immediately after the closing `}` of the `if (running.cli === "claude") { ... return {...}; }` block (and before the Pi fall-through), add:
  ```ts
  if (running.cli === "codex") {
    // Codex pane completion: the MCP subagent_done tool wrote the summary to the
    // sentinel file (detected by pollForExit's sentinelFile option). Transcript /
    // sessionId are best-effort and omitted in v1 (resume is headless-only).
    let summary = "";
    if (running.sentinelFile) { try { summary = readFileSync(running.sentinelFile, "utf-8").trim(); } catch {} }
    if (!summary) summary = readScreen(surface, 200).replace(/__SUBAGENT_DONE_\d+__/, "").trimEnd();
    if (!summary) summary = result.exitCode !== 0 ? `Codex exited with code ${result.exitCode}` : "Codex exited without output";
    if (running.sentinelFile) { try { unlinkSync(running.sentinelFile); } catch {} }
    closeSurface(surface);
    runningSubagents.delete(running.id);
    return { name, task, summary, exitCode: result.exitCode, elapsed, transcriptPath: null,
             transcript: [...transcript], usage: { ...usage } };
  }
  ```
  Note: the `pollForExit(...)` call already passes `sentinelFile: running.sentinelFile`, so no change is needed there — Codex's sentinel is detected exactly like Claude's.
- [ ] **Step 8: Flip pane backend session-key gates.** In `src/backends/pane.ts`: change `running.cli === "claude" ? undefined : running.sessionFile` → `running.cli === "pi" ? running.sessionFile : undefined`; change `if (running.cli !== "claude" && running.sessionFile)` → `if (running.cli === "pi" && running.sessionFile)`; change the partial `running.cli === "claude" ? partial.claudeSessionId : running.sessionFile` → `running.cli === "pi" ? running.sessionFile : partial.claudeSessionId`; change the final `running.cli === "claude" ? sub.claudeSessionId : running.sessionFile` → `running.cli === "pi" ? running.sessionFile : sub.claudeSessionId`. For Codex these yield `undefined` (it never sets `claudeSessionId`), which is the intended "no pane resume key in v1".
- [ ] **Step 9: Set the status source for codex in default-deps.** In `src/orchestration/default-deps.ts`, change `const source = task.cli === "claude" ? "claude" : "pi";` to `const source = task.cli === "claude" || task.cli === "codex" ? "claude" : "pi";` so Codex headless rows use the no-activity-file status semantics while pi tasks keep the pi activity-file semantics. Do NOT invert to `task.cli === "pi" ? "pi" : "claude"`: `cli` is optional and `'pi'` is the documented default, so an omitted or unknown `cli` must fall through to the `"pi"` source (matching Task 3's schema note that unknown values fall back to the pi path) — inverting would regress existing no-`cli` orchestration tasks off pi status semantics.
- [ ] **Step 10: Export `buildCodexPaneCmdParts` for tests.** Ensure `buildCodexPaneCmdParts` is exported from `src/backends/codex-stream.ts` and (optionally) re-exported from `src/index.ts` next to `buildClaudeCmdParts` for symmetry. Write `test/orchestration/codex-pane-cmd.test.ts`: build pane parts with guarded policy + MCP overrides + a task, then assert the joined string contains `--sandbox`, `workspace-write`, `--ask-for-approval`, `on-request`, the three `mcp_servers.pi_subagent.*` tokens, and that the prompt appears after `--`. Add an unrestricted case asserting `--dangerously-bypass-approvals-and-sandbox` and absence of `--sandbox`.
- [ ] **Step 11: Write the skills/tools warning unit test.** In `test/orchestration/codex-skills-warning.test.ts`, mirror `test/orchestration/claude-skills-warning.test.ts`: capture `process.stderr.write`, call `warnCodexUnsupportedFeatures("worker", "research", "read,bash")`, and assert two warnings fired (one mentioning `skills=research`, one mentioning `tools=read,bash`); call with both undefined and assert zero writes.

**Acceptance criteria:**

- A `cli: "codex"` pane launch builds an interactive `codex` command with policy flags, MCP completion overrides, and the prompt after `--`.
  Verify: run `node --test test/orchestration/codex-pane-cmd.test.ts` and confirm exit code 0 with the guarded and unrestricted assertions passing.
- Codex skills/tool allowlists are warned-and-ignored (except the MCP completion tool).
  Verify: run `node --test test/orchestration/codex-skills-warning.test.ts` and confirm exit code 0.
- All shared `cli` branch sites treat Codex like Claude (no activity file, late/absent session key, time-based status).
  Verify: `grep -n 'cli === "pi"\|cli === "claude" || .*cli === "codex"\|=== "codex"' src/index.ts src/backends/pane.ts src/orchestration/default-deps.ts` shows the flipped guards (widget label, observeRunningSubagent, handleSubagentInterrupt, watchSubagent tick/seek/drain, pane.ts session-key expressions, default-deps source).
- The pane Codex completion path returns a summary from the sentinel without depending on process exit, and the full unit suite stays green.
  Verify: open `src/index.ts` and confirm the `if (running.cli === "codex")` block in `watchSubagent` reads `running.sentinelFile`, then run `pnpm test` and confirm exit code 0 with no `FAIL`/`not ok` lines.

**Model recommendation:** capable

---

### Task 6 — Test-harness per-CLI default models

**Files:**
- Modify: `test/integration/harness.ts`
- Test: `test/orchestration/codex-test-model-defaults.test.ts` (Create)

**Steps:**

- [ ] **Step 1: Add `getTestModel(cli)`.** In `test/integration/harness.ts`, replace the constant `TEST_MODEL` with a function while keeping a back-compat export:
  ```ts
  const PER_CLI_DEFAULT_MODEL: Record<string, string> = {
    pi: "anthropic/claude-haiku-4-5",   // unchanged: matches the current TEST_MODEL default
    claude: "claude-haiku-4-5",
    codex: "gpt-5.4-mini",              // Codex-specific default added by this change
  };
  /** Per-CLI default test model. A set PI_TEST_MODEL overrides globally regardless of cli. */
  export function getTestModel(cli: "pi" | "claude" | "codex" = "pi"): string {
    return process.env.PI_TEST_MODEL ?? PER_CLI_DEFAULT_MODEL[cli] ?? PER_CLI_DEFAULT_MODEL.pi;
  }
  /** @deprecated use getTestModel(cli); retained for existing call sites (pi default). */
  export const TEST_MODEL = getTestModel("pi");
  ```
- [ ] **Step 2: Re-point the pi command builder.** In `buildPiCommand()`, change `const model = opts?.model ?? TEST_MODEL;` to `const model = opts?.model ?? getTestModel("pi");` so the pi lane picks up the per-CLI default at call time (honoring a late-set `PI_TEST_MODEL`).
- [ ] **Step 3: Write the model-defaults unit test.** Create `test/orchestration/codex-test-model-defaults.test.ts` importing `getTestModel` from `../integration/harness.ts`. With `PI_TEST_MODEL` deleted: assert `getTestModel("pi") === "anthropic/claude-haiku-4-5"`, `getTestModel("claude") === "claude-haiku-4-5"`, `getTestModel("codex") === "gpt-5.4-mini"`. With `PI_TEST_MODEL = "x/y"`: assert all three return `"x/y"`. Save/restore `process.env.PI_TEST_MODEL` in `before`/`after`.

**Acceptance criteria:**

- Per-CLI default models resolve correctly and `PI_TEST_MODEL` overrides globally.
  Verify: run `node --test test/orchestration/codex-test-model-defaults.test.ts` and confirm exit code 0.
- The pi command builder resolves its model at call time.
  Verify: open `test/integration/harness.ts` and confirm `buildPiCommand` calls `getTestModel("pi")` rather than referencing the `TEST_MODEL` constant.

**Model recommendation:** cheap

---

### Task 7 — Gated real Codex integration tests + slow-lane wiring

**Files:**
- Create: `test/integration/headless-codex-smoke.test.ts`, `test/integration/pane-codex-interactive.test.ts`, `test/integration/orchestration-codex-pane.test.ts`
- Modify: `package.json`

**Steps:**

- [ ] **Step 1: Headless smoke test.** Create `test/integration/headless-codex-smoke.test.ts` mirroring `test/integration/headless-claude-smoke.test.ts`. Gate with both probes:
  ```ts
  const CODEX_AVAILABLE = (() => { try { execSync("which codex", { stdio: "pipe" }); return true; } catch { return false; } })();
  import { SLOW_LANE_OPT_IN, getTestModel } from "./harness.ts";
  describe("headless-codex-smoke", { skip: !CODEX_AVAILABLE || !SLOW_LANE_OPT_IN, timeout: 180_000 }, () => { ... });
  ```
  In `before`, set `process.env.PI_SUBAGENT_MODE = "headless"`. Launch through `makeHeadlessBackend` with `{ task: `Reply with exactly: ${marker}`, cli: "codex", model: getTestModel("codex") }` where `marker = \`HEADLESS_CODEX_SMOKE_${randomUUID()}\``. Assert `result.exitCode === 0`, `result.finalMessage.includes(marker)`, `result.transcript.length > 0`, `result.transcriptPath` exists under `~/.pi/agent/sessions/codex-cli/`, and (soft) that `result.sessionId` is a non-empty string when present (do not hard-fail if the installed Codex omits it — assert `typeof result.sessionId === "string" || result.sessionId === undefined`).
- [ ] **Step 2: Resume-coverage assertion in the smoke test.** Add a second `it(...)` in the same file (same gate): run the marker task, capture `result.sessionId`; if `result.sessionId` is a string, launch a follow-up with `{ task: "Reply with the single word DONE", cli: "codex", resumeSessionId: result.sessionId, model: getTestModel("codex") }` and assert `exitCode === 0`; if `result.sessionId` is `undefined`, launch with `{ ..., resumeSessionId: "" }` and assert the deterministic error `result.exitCode === 1` and `/codex resume requested without a session id/`. This covers both the resumable and unsupported paths per Requirement 9.
- [ ] **Step 3: Pane interactive test.** Create `test/integration/pane-codex-interactive.test.ts` mirroring `test/integration/pane-claude-interactive.test.ts`'s structure (mux + `SLOW_LANE_OPT_IN` + `which codex` gating). Launch a `cli: "codex"` pane subagent with an auto-exit agent task that the model can finish in one turn, watch it via `watchSubagent`, and assert the resolved `SubagentResult.summary` is non-empty and `exitCode === 0`. After completion, assert the user's persistent config is unchanged: snapshot `~/.codex/config.toml` bytes (or its absence) in `before` and assert byte-identical (or still-absent) in the assertion. Use `getAvailableBackends()`/`createTestEnv()` from the harness for mux selection; self-skip when no mux is available.
- [ ] **Step 4: Orchestration test.** Create `test/integration/orchestration-codex-pane.test.ts` mirroring `test/integration/orchestration-claude-pane-serial.test.ts` and `...-parallel.test.ts` (gated identically). Drive a 2-task serial run and a 2-task parallel run with `cli: "codex"` through `registerOrchestrationTools` + `makeDefaultDeps`, asserting each task reaches a terminal `completed` state with `exitCode === 0` and the aggregated steer-back fires.
- [ ] **Step 5: Wire the slow lane.** In `package.json`, append the three new files to the `test:integration:slow` script's file list: `test/integration/headless-codex-smoke.test.ts test/integration/pane-codex-interactive.test.ts test/integration/orchestration-codex-pane.test.ts`. Do NOT add `headless-codex-enoent.test.ts` here (it is ungated and already runs under `test:integration`).

**Acceptance criteria:**

- The gated headless smoke test runs a unique-marker task on `gpt-5.4-mini` and self-skips without `codex`/slow opt-in.
  Verify: run `node --test test/integration/headless-codex-smoke.test.ts` (without `PI_RUN_SLOW`) and confirm it reports the suite as skipped (no failures); the `describe` skip predicate is `!CODEX_AVAILABLE || !SLOW_LANE_OPT_IN`.
- Resume coverage exercises both the resumable and deterministic-unsupported paths.
  Verify: open `test/integration/headless-codex-smoke.test.ts` and confirm the second `it(...)` branches on `result.sessionId` and asserts `/codex resume requested without a session id/` in the unsupported branch.
- The pane test asserts persistent Codex config is unchanged after a run.
  Verify: open `test/integration/pane-codex-interactive.test.ts` and confirm it snapshots `~/.codex/config.toml` before the run and asserts byte-equality (or continued absence) after.
- The slow lane includes the three gated Codex files.
  Verify: `grep -n "headless-codex-smoke.test.ts" package.json` returns a match inside the `test:integration:slow` script value, alongside `pane-codex-interactive.test.ts` and `orchestration-codex-pane.test.ts`.

**Model recommendation:** standard

---

### Task 8 — Documentation

**Files:**
- Modify: `README.md`

**Steps:**

- [ ] **Step 1: Add Codex to CLI selection.** In the `### CLI selection` section, add a `codex` example line and a sentence: change the closing line from "designed to support additional CLIs (codex, opencode) in the future" to note Codex is now implemented:
  ```
  { "name": "codex worker", "task": "...", "cli": "codex" }
  ```
  and a paragraph: `"cli: \"codex\" runs the Codex CLI in headless (codex exec) or pane mode. Like Claude, it trades pi lifecycle features (skills, caller_ping/block-resume) for native Codex tooling; pi skills and tool allowlists are warned-and-ignored. Pane completion is signaled by an in-band subagent_done MCP tool injected per-launch via codex -c overrides — the user's persistent ~/.codex/config.toml is never modified."`
- [ ] **Step 2: Promote the execution-policy table row.** In the `#### Future backend mappings` table, replace the single `**Codex** (future)` row with implemented per-mode rows. Update the table (or add a focused sub-table) so Codex reads: guarded headless → `--sandbox workspace-write` + `-c approval_policy="never"`; guarded pane → `--sandbox workspace-write --ask-for-approval on-request`; unrestricted (both) → `--dangerously-bypass-approvals-and-sandbox`. Rename the heading from "Future backend mappings" to "Backend mappings" (Claude and Codex now implemented; OpenCode/pi-guarded remain future).
- [ ] **Step 3: Document Codex guarded semantics + never-mutate guarantee.** Add a short prose note under the table: `"Codex guarded mode is sandbox-enforced (workspace-write filesystem + approval policy) but, unlike Claude's --permission-mode auto, is not classifier-backed — there is no per-action risk classifier, only the sandbox boundary and approval policy. Codex configuration (MCP completion server, policy, model, thinking) is applied exclusively through per-launch codex -c overrides; pi-mux-subagents never writes to ~/.codex/config.toml or other persistent Codex state."`
- [ ] **Step 4: Update the package description / headline mention.** In `README.md` line 3 (the intro paragraph), change "for pi and Claude Code" to "for pi, Claude Code, and Codex" so the multi-CLI claim matches reality. (Optional: mirror in `package.json` `description` — note it but leave to reviewer discretion to avoid churn in a published field.)

**Acceptance criteria:**

- README documents `cli: "codex"` usage including the never-mutate-config guarantee.
  Verify: `grep -n "cli: \"codex\"\|codex -c\|never\b.*~/.codex\|~/.codex/config.toml" README.md` returns matches in the CLI-selection and execution-policy sections.
- The execution-policy table lists Codex as implemented with the per-mode flags.
  Verify: open `README.md` and confirm the backend-mappings table row(s) for Codex show `--sandbox workspace-write`, `approval_policy="never"`, `--ask-for-approval on-request`, and `--dangerously-bypass-approvals-and-sandbox`, and that Codex is no longer labeled "(future)".
- The headline names Codex as a supported backend.
  Verify: `grep -n "Codex" README.md` shows the intro paragraph (line ~3) naming Codex alongside pi and Claude Code.

**Model recommendation:** cheap

---

## Dependencies

```
- Task 1 depends on: (none)
- Task 2 depends on: (none)
- Task 3 depends on: (none)
- Task 4 depends on: Task 1, Task 3, Task 5        (runner uses codex-stream builders + codexModelArg; imports warnCodexUnsupportedFeatures from src/index.ts, created in Task 5 Step 1)
- Task 5 depends on: Task 1, Task 2, Task 3 (pane branch uses pane parts + MCP overrides + codexModelArg)
- Task 6 depends on: (none)
- Task 7 depends on: Task 4, Task 5, Task 6 (real runs exercise both transports + per-CLI test model)
- Task 8 depends on: Task 4, Task 5         (document the actually-implemented flags/behavior)
```

Tasks 1, 2, 3, 6 can run in parallel first. Then Task 5 (after 1, 2, 3), which creates `warnCodexUnsupportedFeatures` in `src/index.ts`. Then Task 4 (after 1, 3, 5 — its headless runner imports `warnCodexUnsupportedFeatures` from `src/index.ts`). Then Task 7 and Task 8.

## Risk Assessment

- **Codex JSONL event/field names are version-sensitive (Open Question).** The exact carrier for the session/thread id (`thread.started.thread_id` vs `session_id` vs nested `thread.id`) and the usage field names on the installed `codex` may differ from the SDK-shaped names this plan assumes. *Mitigation:* `extractCodexSessionId`/`parseCodexUsage` check multiple known field names and degrade gracefully (no id → `sessionId: undefined` + one-line warning, never a fabricated id), mirroring the Claude stream-format-drift handling. The gated `headless-codex-smoke` test pins the real shape; if names differ, only `codex-stream.ts` parsing constants change. No runtime version gate is added (per spec Constraint).

- **Deviation from spec Requirement 5 wording on the sentinel env-var rename.** The spec says the sentinel env var should be "updated on both the server and `buildClaudeCmdParts`." This plan instead has the MCP server read the neutral `PI_SUBAGENT_DONE_SENTINEL` **with a fallback** to `PI_CLAUDE_SENTINEL`, and leaves the Claude path (`buildClaudeCmdParts` + the `on-stop.sh`/`on-session-start.sh` hooks, which also read `PI_CLAUDE_SENTINEL`) **unchanged**. Reason: the spec's rename did not account for the two Claude Stop/SessionStart hooks that read `PI_CLAUDE_SENTINEL`; renaming only the server + `buildClaudeCmdParts` would break the hook-written `.transcript` pointer. Dual-read achieves the spec's actual goal ("one server serves both CLIs" via a CLI-neutral var) while guaranteeing Claude's observable pane-completion behavior is byte-for-byte unchanged and its existing plugin tests pass verbatim. Codex uses the neutral var exclusively.

- **`-c` MCP injection must survive shell escaping in the pane command.** The `mcp_servers.<name>.args=["<path>"]` and `.env.<VAR>="<path>"` tokens contain quotes and brackets that must reach Codex's TOML parser intact through the bash launch script. *Mitigation:* each `-c key=value` token is passed through the existing `shellEscape` (single-quote wrapping) in `buildCodexPaneCmdParts`, exactly as `buildClaudeCmdParts` escapes its values; the `codex-pane-cmd` unit test asserts the tokens are present, and the gated `pane-codex-interactive` test confirms Codex registers the server end-to-end. The spec records this `-c` mechanism as already probe-verified on the installed Codex (`codex mcp list` listed the injected server as enabled).

- **Pane Codex omits transcript/sessionId/resume in v1.** Interactive `codex` has no `--json` stream to tail and no Stop-hook transcript pointer, so the pane path returns `transcriptPath: null` and no session id. *Mitigation:* this matches the spec's pane acceptance (completion + summary only; resume is headless-only via `codex exec resume`). Documented as a v1 limitation; the summary comes from the MCP `subagent_done` payload (sentinel content) with a screen-scrape fallback, mirroring Claude's fallback chain.

- **`subagent_resume` tool does not route Codex session ids.** The `subagent_resume` tool's `sessionId` branch assumes Claude; a Codex session id passed there would be misrouted. *Mitigation:* out of scope for v1 (the spec's resume requirement is satisfied by the launch-time `resumeSessionId` param on `cli: "codex"` headless launches → `codex exec resume <id>`). Left unchanged to avoid touching the Claude resume path; noted here so a follow-up can add a Codex resume branch deliberately.

- **Per-CLI test-model defaults preserve the existing pi and Claude lanes.** The pi integration lane keeps its current default `anthropic/claude-haiku-4-5` and the Claude lane keeps `claude-haiku-4-5`; only a Codex-specific default `gpt-5.4-mini` is added. `PI_TEST_MODEL` remains a single global override across all lanes. *Mitigation:* existing pi and Claude integration tests continue to run unchanged without requiring new (OpenAI/Codex) credentials by default; the change is confined to `getTestModel`/`buildPiCommand` (`buildPiCommand` resolves `getTestModel("pi")` at call time), and gated real Codex tests self-skip when `codex` is absent.

- **CLI-seam refactor deliberately deferred (answers the in-flight design question).** Adding Codex as a third `if/else` branch increases CLI-conditional sites. The spec's fixed `## Approach` mandates "mechanical third-branch" routing and "exactly one code path to build, document, and test," and the hard constraint is "preserve pi and claude behavior unchanged." Introducing a per-CLI backend-strategy seam concurrently would couple a broad refactor (touching the working pi+claude paths) to a feature addition, against both the spec and the risk budget. *Mitigation / partial consolidation:* where cheap, this plan flips `=== "claude"` / `!== "claude"` checks that actually mean "pi-only" / "non-pi" to `=== "pi"` / `!== "pi"`, so the "non-pi process-spawn CLI" behavior is shared by Claude and Codex rather than duplicated. A full CLI-seam extraction is best done as a **follow-up** once three concrete implementations (pi, claude, codex) exist to generalize from (rule of three) — that follow-up can refactor without feature risk because the behavior will already be pinned by this change's tests.

## Test Command

```bash
pnpm test
```

(Unit/contract suite. New unit tests under `test/orchestration/*.test.ts` and the modified `test/plugin-*.test.ts` are picked up by the globs in the `test` script. Run `pnpm run build:plugin` first if `src/claude-plugin/mcp/server.js` was changed, since `plugin-mcp.test.ts` loads the built `server.js`. Ungated integration: `pnpm test:integration`. Gated real-Codex integration: `PI_RUN_SLOW=1 pnpm test:integration:slow` with `codex` on `PATH`.)

## Self-Review

**Spec coverage** (against `docs/specs/2026-06-02-4af1b8bf.md` Requirements 1–14):

1. Accept `cli: "codex"` everywhere → Tasks 3 (schemas), 4 (headless route), 5 (pane route); orchestration passes `cli` through unchanged.
2. Discover only `codex` on PATH, clear missing-binary error → Task 4 (Steps 4, 7).
3. Command builder + routing branch in both transports → Tasks 1, 4, 5.
4. Headless `codex exec --json --output-last-message --cd`, result fields → Task 4 (Steps 3–5), Task 1 (parsing).
5. Pane MCP `subagent_done` via `-c` overrides, reuse server, CLI-neutral sentinel, no persistent writes → Tasks 2, 5.
6. Per-mode policy mapping + no spurious guarded warning → Task 1 (Step 2), Task 3 (Step 2).
7. Model provider-strip to `--model` → Task 3 (Step 1), Task 1 (uses `codexModelArg`).
8. Thinking → `-c model_reasoning_effort=<v>`, omit unsupported → Task 1 (Step 1).
9. Resume via `codex exec resume <id>`, deterministic error when no id, defensive parse, no version gate → Task 1 (Step 6), Task 4 (Steps 3, 5), Task 7 (Step 2).
10. Warn-and-ignore skills/tools except MCP completion tool → Task 5 (Steps 1, 11).
11. Preserve pi/claude behavior incl. Claude plugin/sentinel → Task 2 (dual-read fallback, deviation noted), shared-gate flips keep pi/claude semantics; full unit suite green (Task 5 Step 11 acceptance).
12. Docs → Task 8.
13. Per-CLI test-model defaults + global override → Task 6.
14. Unit/contract + gated integration tests; existing tests pass → Tasks 1, 2, 3, 4, 5, 6, 7.

No requirement is left without an owning task.

**Placeholder scan:** No "TBD"/"TODO"/"implement later"/"similar to Task N" present; each step shows concrete argv/flags, function signatures, exact old→new edits, or test assertions. Every acceptance criterion is immediately followed by its own `Verify:` line naming a command or a file + check; no `Verify:` line is a bare "check it works".

**Type consistency:** `BackendResult` fields (`exitCode`, `finalMessage`, `transcript`, `transcriptPath`, `sessionId`, `sessionKey`, `usage`, `error`) are reused unchanged; `runCodexHeadless` returns the same shape as `runClaudeHeadless`. `codexModelArg` is added to `ResolvedLaunchSpec` alongside `claudeModelArg` (same `string | undefined` type, same producer `projectModelForClaude`). `UsageStats`/`TranscriptMessage`/`TranscriptContent` are imported from `src/backends/types.ts` in `codex-stream.ts`. `RunningSubagent.cli` is the existing optional string, set to `"codex"`. Builder signatures (`buildCodexExecArgs`, `buildCodexPaneCmdParts`, `buildCodexMcpOverrideArgs`, `codexReasoningEffort`, `codexSandboxArgs`, `warnCodexUnsupportedFeatures`, `getTestModel`) are consistent across their definition task and consuming tasks.

PLAN_ARTIFACT: /Users/david/Code/pi-mux-subagents/docs/plans/2026-06-02-support-codex-cli-for-subagent-execution.md
