# pi-mux-subagents

An interactive and headless subagent framework for [pi](https://github.com/earendil-works/pi) and Claude Code with terminal-multiplexer pane support, sync and async orchestration, and a multi-CLI design. Mux pane execution—launching each subagent into its own live terminal pane—is the framework's primary differentiator: it gives you direct observability, manual intervention, and interruption semantics that headless subprocess execution cannot match.

## Install

```bash
npm install @aphotic/pi-mux-subagents
```

Register the extension in your project's `package.json`:

```json
{
  "pi": {
    "extensions": ["./node_modules/@aphotic/pi-mux-subagents/src/index.ts"]
  }
}
```

## Quickstart

### Subagent primitive (single launch)

Launch a single worker and receive its result asynchronously:

```json
{
  "name": "summarise-module",
  "task": "Summarise the public API of src/orchestration/ in one paragraph.",
  "agent": "researcher"
}
```

The parent receives a steer-back message when the worker finishes. Do not invent its output.

### Serial orchestrator

Run tasks one after another. Use `{previous}` to pass each step's final message into the next:

```json
{
  "tasks": [
    { "name": "Research", "task": "List all public exports in src/." },
    { "name": "Plan",     "task": "Write a migration plan based on: {previous}" },
    { "name": "Review",   "task": "Review the plan for completeness: {previous}" }
  ]
}
```

The sequence stops on the first failure and returns all prior results alongside the failing one.

### Parallel orchestrator

Run independent tasks concurrently with a configurable cap:

```json
{
  "maxConcurrency": 3,
  "tasks": [
    { "name": "Auth review",    "task": "Review src/backends/ for security issues." },
    { "name": "Mux review",     "task": "Review src/mux/ for reliability issues." },
    { "name": "Tooling review", "task": "Review src/tools/ for correctness." }
  ]
}
```

`maxConcurrency` defaults to `4` and is capped at `8`. Partial failures do not cancel sibling tasks. Results are returned in input order.

### Sync vs async subagent calls

By default (`wait: true`) the orchestration tool blocks until all tasks complete. Set `wait: false` to return immediately with an `orchestrationId`:

```json
{ "wait": false, "tasks": [ { "name": "Background probe", "task": "..." } ] }
```

The tool returns:

```json
{ "orchestrationId": "7a3f91e2", "state": "pending", "tasks": [...] }
```

Completion arrives later as a single aggregated steer-back message. Cancel with:

```json
{ "orchestrationId": "7a3f91e2" }
```

### CLI selection

Choose which CLI each subagent runs under with the `cli` field:

```json
{ "name": "pi worker",     "task": "...", "cli": "pi" }
{ "name": "claude worker", "task": "...", "cli": "claude" }
```

`cli: "pi"` (default) gives access to pi lifecycle tools (`subagent_done`, `caller_ping`), skills, and coordinator spawning. `cli: "claude"` runs the Claude Code CLI in headless or pane mode; it trades pi lifecycle features for Claude-native tool access. The framework is designed to support additional CLIs (codex, opencode) in the future.

### Headless vs mux

Control the execution backend with the `PI_SUBAGENT_MODE` environment variable:

```bash
export PI_SUBAGENT_MODE=auto      # default: use a mux pane when one is detected, otherwise headless
export PI_SUBAGENT_MODE=pane      # require a mux; fail if none is available
export PI_SUBAGENT_MODE=headless  # always run as a child process
```

Headless mode works in CI, IDE terminals, and SSH sessions. It produces structured `usage` and `transcript` fields. Pane mode opens each subagent in a live terminal surface where you can watch, type, and intervene directly.

### Interactive flag and autoexit interplay

`interactive` and `autoExit` control how a subagent behaves after completing its turn:

```json
{ "interactive": false, "autoExit": true }   // autonomous one-shot worker — exits after one turn
{ "interactive": true,  "autoExit": false }  // user-driven session — stays open for follow-up
```

When both are set, `autoExit: true` takes precedence on turn completion. An `interactive: true` child suppresses intermediate status steer-back messages so the parent is not repeatedly woken by expected pauses. If neither is set, `interactive` defaults to `true` unless `autoExit: true` is explicitly present.

## Backend selection

The framework auto-detects an available mux when an interactive subagent is requested and falls back to headless when no mux is found. Adapters are checked in this fixed detection order: **herdr, cmux, tmux, zellij, wezterm**. Override the selection with `PI_SUBAGENT_MUX=<name>` to force a specific adapter or fail fast if that adapter is unavailable.

### `pi-mux-detect`

The package ships a standalone `pi-mux-detect` CLI that exposes the same detection logic used at runtime as machine-readable JSON:

```bash
npx pi-mux-detect
```

Sample output:

```json
{
  "backend": "pane",
  "mux": "herdr",
  "modeForced": false,
  "muxPreference": null,
  "muxPreferenceInvalid": false,
  "reason": "herdr detected via HERDR_ENV"
}
```

Fields: `backend` (`"pane"` or `"headless"`), `mux` (detected adapter name or `null`), `modeForced` (whether `PI_SUBAGENT_MODE` forced the backend), `muxPreference` (value of `PI_SUBAGENT_MUX` when set and valid), `muxPreferenceInvalid` (true when `PI_SUBAGENT_MUX` is set to an unrecognised value), `reason` (human-readable explanation of the detection outcome).

Downstream packages should call `pi-mux-detect` rather than duplicating mux env-var checks.

## Ecosystem

[`pi-flow-core`](https://github.com/aphotic/pi-flow-core) provides a curated library of ready-made agents and skills that build on this package. The dependency direction is `pi-flow-core → pi-mux-subagents`, not the reverse: `pi-mux-subagents` has no runtime dependency on `pi-flow-core`. If you want a batteries-included setup with pre-built agent definitions, start with `pi-flow-core`; if you want only the launch and orchestration primitives, this package is self-contained.

## Attribution

This project began as a fork of [`HazAT/pi-interactive-subagents`](https://github.com/HazAT/pi-interactive-subagents). Thanks to the upstream maintainer for the foundation this work builds on.

## License

MIT. The LICENSE file at the package root preserves the upstream copyright notice as required by MIT.
