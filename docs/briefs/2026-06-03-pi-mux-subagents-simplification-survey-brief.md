# Scout Brief: pi-mux-subagents simplification survey
Generated at: 2026-06-03T02:03:23Z
Git SHA: 5d322e9f3fc18953a5fda1a768ab315525fefd7d
Model: anthropic/claude-sonnet-4-6

## Relevant Files

Primary complexity sites (ordered by estimated simplification value):

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 2805 | Extension entry point — pane launch, pane watch, resume tool, widget, registration |
| `src/backends/headless.ts` | 991 | Three headless runner functions (pi/claude/codex) |
| `src/tools/tool-handlers.ts` | ~550+ | Orchestration tool registration (serial/parallel async dispatch bodies) |
| `src/launch/launch-spec.ts` | 807 | Spec resolution — also contains frontmatter parser and `safeFileName` |
| `src/backends/pane.ts` | 156 | Pane backend adaptor — contains repeated `running.cli` guards |
| `src/orchestration/registry.ts` | 419 | Async orchestration lifecycle state machine |
| `src/orchestration/run-serial.ts` | 212 | Serial step runner |
| `src/orchestration/run-parallel.ts` | 261 | Parallel worker pool |
| `src/orchestration/default-deps.ts` | 125 | LauncherDeps factory — mapping layer |
| `src/launch/status.ts` | 250+ | Status state machine (self-contained, low complexity) |

Secondary / reference files relevant to call paths:
- `src/backends/types.ts` — `Backend`, `BackendResult`, `BackendLaunchParams`, `UsageStats`
- `src/orchestration/types.ts` — `OrchestrationResult`, `LauncherDeps`, `LaunchedHandle`
- `src/backends/claude-stream.ts`, `src/backends/codex-stream.ts` — per-CLI parsers
- `src/backends/pi-projection.ts` — pi JSONL → transcript projection

## Key Interfaces and Types

**Three parallel result shapes** (the triple-mapping chain is a simplification target):

1. `SubagentResult` (`src/index.ts:370–385`) — pane watcher output; fields: `summary`, `elapsed` (seconds), `sessionFile`, `claudeSessionId`
2. `BackendResult` (`src/backends/types.ts:30–42`) — backend interface result; fields: `finalMessage`, `elapsedMs`, `sessionId`, `sessionKey`
3. `OrchestrationResult` (`src/orchestration/types.ts:50–64`) — orchestration layer; same shape as `BackendResult` plus `state`, `index`

`SubagentResult → BackendResult` mapping: `pane.ts:108–149` (manual field copy, `summary → finalMessage`, `elapsed * 1000 → elapsedMs`)
`BackendResult → OrchestrationResult` mapping: `default-deps.ts:88–116` (another manual copy)

**CLI guard predicate** — `isPiLikeCli` exists in `headless.ts:290–292` but is private. The equivalent check `running.cli === "claude" || running.cli === "codex"` (negated: "is NOT pi-like") appears 10 times across `src/index.ts` and `src/backends/pane.ts` as an inline expression.

**`RunningSubagent`** (`src/index.ts:390–431`) — the pane-layer live state struct. The `backend`, `cli`, `sentinelFile`, `sessionFile`, and `activityFile` fields drive the tri-branch logic in `watchSubagent`.

**`ResolvedLaunchSpec`** (`src/launch/launch-spec.ts:143–199`) — fully resolved launch parameters consumed by both pane and headless backends. Large struct (32 fields) but coherent; the resolution logic in `resolveLaunchSpec` (line 577) is long but linear.

**Two frontmatter-to-defaults parsers**:
- `parseAgentDefinition` (`src/index.ts:268–300`) → `AgentDefinition` (adds `name`, `description`, `disableModelInvocation`)
- `parseAgentDefaultsFromContent` (`src/launch/launch-spec.ts:273–304`) → `AgentDefaults`

Both call the same `getFrontmatterValue` helper and parse the same YAML keys. The core extraction logic is duplicated.

## Dependency / Call Graph

```
subagentsExtension (index.ts:1923)
  ├─ subagent tool.execute
  │    ├─ selectBackend() → headless path
  │    │    └─ makeHeadlessBackend(ctx).launch / .watch (headless.ts)
  │    └─ pane path
  │         ├─ launchSubagent(params, ctx) (index.ts:1015)  [claude | codex | pi branch]
  │         └─ watchSubagent(running, signal) (index.ts:1348) [claude | codex | pi branch]
  ├─ subagent_resume tool.execute (index.ts:2405)
  │    ├─ isPiResume → pi command branch
  │    └─ !isPiResume → claude command branch
  │    └─ watchSubagent(running, signal) [same tri-branch function]
  └─ registerOrchestrationTools (tool-handlers.ts:107)
       ├─ subagent_run_serial.execute
       │    ├─ wait:false → registry.dispatchAsync + fire-and-forget runSerial
       │    └─ wait:true  → runSerial(tasks, opts, deps)
       └─ subagent_run_parallel.execute
            ├─ wait:false → registry.dispatchAsync + fire-and-forget runParallel
            └─ wait:true  → runParallel(tasks, opts, deps)

runSerial / runParallel
  └─ deps.launch() / deps.waitForCompletion()  [LauncherDeps interface]
       └─ makeDefaultDeps(ctx) (default-deps.ts)
            └─ Backend (pane or headless)
                 ├─ makePaneBackend(ctx) → launchSubagent / watchSubagent
                 └─ makeHeadlessBackend(ctx) → runPiHeadless | runClaudeHeadless | runCodexHeadless
```

`discoverAgentDefinitions` (index.ts:302) and `loadAgentDefaults` (launch-spec.ts:320) scan the same three agent directories independently with different result types.

## Patterns and Conventions

- **CLI dispatch by string value** — the codebase uses `spec.effectiveCli === "claude"` / `=== "codex"` and `running.cli === "claude" || running.cli === "codex"` as the branching primitive everywhere. There is no discriminated-union type on CLI variants.
- **`__test__` export convention** — each module that needs test seams exports a `__test__` object with `set*` / `restore*` / `get*` methods. The seams are module-scoped `let` bindings reassigned by tests.
- **Defensive try/catch everywhere** — callbacks and event handlers universally wrap in `try { … } catch { /* defensive */ }`. This is intentional noise suppression but makes it harder to see which paths are actually fallible.
- **Fire-and-forget `.then()/.catch()`** — async watchers and dispatchers use Promise chaining rather than `async/await` with `finally` blocks. This makes the control flow harder to follow.
- **Registry emitter as side-channel** — `registryEmitter` in index.ts (line 1844) is passed to `createRegistry` and fires UI/steer side-effects. Registry state logic and UI side-effects are coupled through this callback.

## Existing Tests and Test Patterns

Test count is large (90+ test files). Relevant patterns:

- **Unit tests** (`test/orchestration/*.test.ts`) — drive `__test__` seams, inject fake `LauncherDeps`, `BackendRunner`, spawn mocks. Do not touch real processes.
- **Integration tests** (`test/integration/*.test.ts`) — spawn real `pi` / `claude` / `codex` processes against real temp sessions. These are the tests most affected by backend dispatch logic.
- **`test/orchestration/backend-seam.test.ts`** — exercises the `Backend` interface via injected `makeHeadlessBackendWithRunner`. This is the key seam for headless backend simplification.
- **`test/orchestration/pane-*.test.ts`** — exercise the pane backend by overriding `launchSubagent` / `watchSubagent` via `PaneBackendOverrides`.
- **No test for `watchSubagent` directly** — `watchSubagent`'s complexity is covered indirectly by pane backend tests and integration tests. A direct unit test seam doesn't exist; simplification of `watchSubagent` would need care to not regress pane + headless coverage simultaneously.

## Risk Areas

### HIGH — `watchSubagent` refactor
`src/index.ts:1348–1796` is 450 lines. Splitting the three CLI branches into separate functions would improve readability but requires careful preservation of the following non-obvious behaviors:
- The `drainPiTail` final-drain after `pollForExit` returns (line 1560) — fixes a subtle race where a fast subagent finishes before the first tick.
- The bounded 2-second wait for the `.transcript` pointer file (line 1582–1589) — a race between the MCP sentinel write and the Stop hook.
- The post-mortem catch-up pass on the archived JSONL (line 1609–1663) — compensates for live-tail misses on one-turn runs.
- `maybeFire` / `firedSessionKey` idempotency guard shared across all branches.

These behaviors are not obvious from the code structure and are not documented by inline comments that survive a refactor.

### HIGH — Three parallel result types
Collapsing `SubagentResult` + `BackendResult` + `OrchestrationResult` into a single shape would eliminate the manual mapping in `pane.ts:108–149` and `default-deps.ts:88–116`, but it would be a sweeping rename that touches many tests. The `elapsed` (seconds) vs `elapsedMs` (milliseconds) discrepancy would need resolution.

### MEDIUM — Async dispatch duplication in `tool-handlers.ts`
The fire-and-forget + post-run-sweep body appears twice (serial ~lines 173–218, parallel ~lines 318–380). Extracting a `dispatchAsync(runFn, registry, orchestrationId)` helper is straightforward but must handle the `out.blocked` exit path that differs between serial and parallel.

### MEDIUM — `subagent_resume` inline name sanitization
`src/index.ts:2467`, `2493`, `2515` repeat the same `name.toLowerCase().replace(...)` chain that `safeScriptName` (line 981) already encapsulates. The inline versions differ only in the fallback string ("resume" vs "subagent"). Using `safeScriptName` directly would reduce 3 inline regexes to 3 function calls.

### LOW — `isPiLikeCli` export gap
`isPiLikeCli` in `headless.ts:290` is private. Exporting it and importing it in `index.ts` and `pane.ts` would replace the 10 inline `running.cli === "claude" || running.cli === "codex"` checks with a named predicate, making adding a third non-pi CLI (e.g. "opencode") a one-file change.

### LOW — `parseAgentDefinition` vs `parseAgentDefaultsFromContent` duplication
`src/index.ts:268–300` and `src/launch/launch-spec.ts:273–304` are near-identical frontmatter parsers. The index.ts version extends the result with `name`, `description`, `disableModelInvocation`. Refactoring to call `parseAgentDefaultsFromContent` from `index.ts` and augment the result eliminates the duplication, but `launch-spec.ts` is currently dependency-free of `index.ts` by design (comment at line 69) — the refactor would need to keep that layering intact.

### LOW — `safeScriptName` vs `safeFileName` duplication
Identical functions at `src/index.ts:981` and `src/launch/launch-spec.ts:507`. The `launch-spec.ts` one could be exported and imported into `index.ts`. No behavioral risk; purely mechanical.

### LOW — `src/index.ts` module size
At 2805 lines the file mixes: (a) widget rendering helpers, (b) headless lifecycle helpers, (c) pane launch, (d) pane watch, (e) resume tool execution, (f) extension registration. Widget rendering (`borderLine`, `borderTop`, `borderBottom`, `renderSubagentWidgetLines`, `formatWidgetRightLabel`) and the status refresh loop could move to a dedicated `src/ui/widget.ts` without changing any public API. This would reduce the size of the file the `/reload` survivor pattern needs to manage.

## Possible Misses

- **`src/backends/codex-mcp.ts`** — not read in depth; may contain additional Codex-specific dispatch logic that mirrors patterns in headless.ts.
- **`src/backends/tool-map.ts`** — maps pi tool names to Claude tool names; small file but a potential source of future CLI-specific branching.
- **Headless runner boilerplate** — the three `runPiHeadless` / `runClaudeHeadless` / `runCodexHeadless` functions share nearly identical abort-listener setup, `proc.on("error", ...)` shape, and `wasAborted` / `settled` / `exited` flags. This survey did not measure the LOC reduction from extracting a `runChildProcess` helper, but it appears non-trivial.
- **`OrchestrationResult.state` field** — appears on `OrchestrationResult` but not on `BackendResult`. The "three parallel types" finding assumes the `state` field stays on the orchestration layer; verify this assumption before collapsing types.
- **Working-tree cosmetic change** — `src/index.ts` has uncommitted modifications and `test/orchestration/widget-style.test.ts` is untracked. The test asserts lowercase title (`"subagents"`) and Nord10-blue border color. These are cosmetic widget styling changes that do not reveal a broader simplification opportunity; however, the widget rendering helpers involved (`renderSubagentWidgetLines`, `borderLine`, `borderTop`, `borderBottom`, lines 504–604) are a clean extract-to-module candidate as noted above.

## Open Questions / Ambiguities

1. **Layering constraint for `parseAgentDefaultsFromContent`** — `launch-spec.ts` comment at line 69 explains it avoids importing from `index.ts` to prevent circular dependencies. Any frontmatter-parser consolidation must not create a circular import edge. Would it make sense to extract the parser to `src/launch/agent-defaults.ts` as a shared leaf module?

2. **Result type collapse boundary** — Is the `SubagentResult` / `BackendResult` split intentional (pane path predates the Backend interface, kept for compatibility), or is it safe to unify them now? The `pane.ts` mapping is the most mechanical conversion candidate.

3. **`continueSerialFromIndex` in `tool-handlers.ts`** — This function (lines 9–59) reproduces part of the async serial dispatch logic. It lives in the tools layer rather than `run-serial.ts`. Was this placement deliberate (dependency direction) or incidental accumulation?

4. **Codex headless archival path** — `runCodexHeadless` writes raw JSONL lines to disk via `writeFileSync` inside the `close` handler. Is this intentional (synchronous, blocking, no async archival wait like Claude) or an oversight? The Claude path uses an async `archiveClaudeTranscript` with a poll loop.

5. **`registryEmitter` UI coupling** — The emitter in `index.ts:1844` both updates the widget and sends steer messages. If registry were extracted to a separate module in the future, this coupling to `piForRegistry` and `runningSubagents` would need untangling. Is there an existing plan to decouple?
