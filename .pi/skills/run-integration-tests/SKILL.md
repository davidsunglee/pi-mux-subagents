---
name: run-integration-tests
description: Run the integration test suite through the test-runner subagent, including pane/mux coverage when a supported backend is available. Use when asked to "run integration tests", "run e2e tests", "verify integration", "test before release", or "check everything works".
---

# Run Integration Tests

Run the current repository's integration suite from the active working tree and capture a test-runner artifact. The workflow is backend-neutral: it supports Herdr, cmux, tmux, zellij, and wezterm. When running inside Herdr, force `PI_SUBAGENT_MUX=herdr` so pane-backed tests exercise the Herdr adapter.

## Inputs and defaults

Determine these before dispatch:

| Input | Default | Notes |
|---|---|---|
| Working directory | current git repo root | Never hardcode a user/path-specific checkout. |
| Suite mode | `fast` | `fast` runs `npm run test:integration`; `all` runs `PI_RUN_SLOW=1 npm run test:integration`; `slow-only` runs `npm run test:integration:slow`. |
| Child model | existing `PI_TEST_MODEL`, else harness default | If the user names a model, resolve it first; set `PI_TEST_MODEL=<fully-qualified-model>` for child pi sessions. For pi model thinking, use the pi model suffix form if needed, e.g. `openai-codex/gpt-5.4:medium`. |
| Test-runner model | `crossProvider.cheap` via shared dispatch | If the user explicitly requests a runner model (for example, "GPT-5.4 with medium thinking"), resolve it and pass `model`, `cli`, and `thinking` explicitly to the test-runner subagent. |
| Backend forcing | none | If the user wants Herdr coverage and `HERDR_ENV=1`, prefix the command with `PI_SUBAGENT_MUX=herdr`. |
| Timeout | existing `PI_TEST_TIMEOUT`, else harness default | Override with `PI_TEST_TIMEOUT=<ms>` when requested or when running slow/full suites. |
| Session validation | optional, enabled for lifecycle/pane investigations | Validate recent `pi-integ-*` sessions after the run when requested or when debugging lifecycle behavior. |

### Model resolution

When the user names a model without a provider, do not guess. Run:

```bash
pi --list-models "<model name>"
```

- One match: use the fully-qualified provider/model value.
- Multiple matches: prefer an authenticated provider if clear; otherwise ask.
- No match: say so and ask for another model/login.

For the common request "GPT-5.4 with medium thinking" in this environment, the expected resolution is typically:

- test-runner dispatch: `model: "openai-codex/gpt-5.4"`, `cli: "pi"`, `thinking: "medium"`
- integration child sessions: `PI_TEST_MODEL=openai-codex/gpt-5.4:medium`

## Step 1: Preflight

Run these from the target repo root:

```bash
git status --short --branch
node --version
npm --version
node -e 'const p=JSON.parse(require("fs").readFileSync("package.json","utf8")); for (const s of ["test:integration","test:integration:slow","build:plugin"]) console.log(`${s}=${p.scripts?.[s] ?? "<missing>"}`)'
printf 'HERDR_ENV=%s\nHERDR_PANE_ID=%s\nHERDR_SOCKET_PATH=%s\n' "$HERDR_ENV" "$HERDR_PANE_ID" "$HERDR_SOCKET_PATH"
printf 'CMUX_SOCKET_PATH=%s\nTMUX=%s\nZELLIJ=%s\nZELLIJ_SESSION_NAME=%s\nWEZTERM_UNIX_SOCKET=%s\n' "$CMUX_SOCKET_PATH" "$TMUX" "$ZELLIJ" "$ZELLIJ_SESSION_NAME" "$WEZTERM_UNIX_SOCKET"
```

Requirements:

- Node 22+.
- `package.json` has `test:integration`.
- For Herdr-specific validation, `HERDR_ENV=1` and `HERDR_PANE_ID` should be set. If they are absent, warn that Herdr pane tests will skip or fail instead of exercising the Herdr adapter.
- If no mux backend environment is present, the default integration suite can still run headless tests, but pane/mux tests will skip. Ask before proceeding if the user specifically requested pane/mux coverage.

## Step 2: Choose the command

Build one command string and pass it verbatim to test-runner.

### Fast/default integration gate

```bash
PI_TEST_MODEL=<model> npm run test:integration
```

### All integration tests, including slow opt-in suites

Use this when the user says "all integration tests", "full integration", "pre-release", or explicitly wants slow/pane/Claude orchestration coverage:

```bash
PI_RUN_SLOW=1 PI_TEST_MODEL=<model> npm run test:integration
```

### Slow subset only

Use this only when the user specifically asks for the slow subset rather than the whole integration directory:

```bash
PI_TEST_MODEL=<model> npm run test:integration:slow
```

### Herdr-forced command

When running inside Herdr and the goal is to exercise the Herdr backend, prefix the selected command with `PI_SUBAGENT_MUX=herdr`:

```bash
PI_SUBAGENT_MUX=herdr PI_RUN_SLOW=1 PI_TEST_MODEL=<model> npm run test:integration
```

Add `PI_TEST_TIMEOUT=<ms>` or `PI_BLOCK_WAIT_MS=<ms>` only when requested or when the existing defaults are too short for the selected suite. Do not add ad-hoc flags to `node --test`; use the repo's npm scripts unless there is a specific reason to target individual files.

## Step 3: Dispatch through test-runner

Use the shared test-runner protocol instead of running the long integration command directly in the main session.

1. Ensure the artifact directory exists:

   ```bash
   mkdir -p docs/test-runs/integration
   ```

2. Pick an artifact path under `docs/test-runs/integration/`, for example:

   ```text
   docs/test-runs/integration/<YYYY-MM-DD-HHMMSS>-integration.log
   ```

3. Capture the artifact freshness baseline:

   ```bash
   ARTIFACT_BASELINE=$(python3 -c "import os, sys; p=sys.argv[1]; print(os.path.getmtime(p) if os.path.exists(p) else 0)" "<artifact_path>")
   ```

4. Fill the shared prompt template at `$HOME/.pi/agent/skills/_shared/test-runner-prompt.md` with:

   - `TEST_COMMAND`: the exact command from Step 2
   - `WORKING_DIR`: absolute repo root
   - `ARTIFACT_PATH`: absolute artifact path
   - `PHASE_SECTION`: `## Phase Label\n\nintegration-<mode>\n`

5. Dispatch one `test-runner` subagent:

   ```text
   subagent_run_serial {
     tasks: [{
       name: "test-runner: integration-<mode>",
       agent: "test-runner",
       task: <filled prompt>,
       model: <resolved runner model>,
       cli: <resolved runner cli>,
       thinking: <requested thinking, if any>,
       cwd: <repo root>
     }],
     wait: true
   }
   ```

6. Validate the artifact handoff and structure:

   ```bash
   python3 $HOME/.pi/agent/skills/_shared/scripts/parse-test-runner-artifact.py \
     --artifact <artifact_path> \
     --final-message <path-to-finalMessage-or-stdin> \
     --expected-path <artifact_path> \
     --freshness-baseline "$ARTIFACT_BASELINE"
   ```

A non-zero test command exit code is not a protocol failure; report it as a test failure with the artifact path.

## Step 4: Interpret results

Read the parsed artifact JSON:

- `exit_code == 0`, empty `failing_identifiers`, and empty `non_reconcilable_failures`: integration run passed.
- Non-empty `failing_identifiers`: report the stable failing test identifiers.
- Non-empty `non_reconcilable_failures`: report the evidence blocks verbatim; these are crashes/build/collection errors or failures without stable test names.

Do not rely on hardcoded expected test counts. Use the Node test summary in the artifact (`tests`, `pass`, `fail`, `skipped`) and the parsed failure buckets.

## Step 5: Optional session validation

Run this when the user asks for lifecycle validation, when pane/mux tests fail suspiciously, or before release if the goal is end-to-end session integrity. Use recent `pi-integ-*` session directories created by the integration harness; do not assume exact parent/child counts.

Find candidate session directories:

```bash
find ~/.pi/agent/sessions -type d -name '*pi-integ*' -mmin -30 2>/dev/null | sort
```

If no directory is found, widen the search:

```bash
find ~/.pi/agent/sessions -type d -name '*pi-integ*' 2>/dev/null | tail -20
```

Validate each selected directory:

```bash
SESSION_DIR="<session-dir>" python3 - <<'PY'
import glob, json, os, sys
session_dir = os.environ['SESSION_DIR']
files = sorted(glob.glob(os.path.join(session_dir, '*.jsonl')))
print(f'Found {len(files)} session files in {session_dir}')
errors = []
parents = 0
children = 0
for f in files:
    name = os.path.basename(f)
    entries = []
    for line in open(f, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except Exception as exc:
            errors.append(f'{name}: invalid JSON: {exc}')
            break
    if not entries:
        errors.append(f'{name}: empty file')
        continue
    header = entries[0]
    if header.get('type') != 'session':
        errors.append(f'{name}: first entry is {header.get("type")}, not session')
        continue
    is_child = bool(header.get('parentSession'))
    children += int(is_child)
    parents += int(not is_child)
    messages = [e for e in entries if e.get('type') == 'message']
    user_msgs = [m for m in messages if m.get('message', {}).get('role') == 'user']
    assistant_msgs = [m for m in messages if m.get('message', {}).get('role') == 'assistant']
    error_entries = [e for e in entries if e.get('type') == 'error']
    if not user_msgs:
        errors.append(f'{name}: no user messages')
    if not assistant_msgs:
        errors.append(f'{name}: no assistant messages')
    if error_entries:
        errors.append(f'{name}: has {len(error_entries)} error entries')
    for m in reversed(messages):
        if m.get('message', {}).get('role') == 'assistant':
            if m.get('message', {}).get('stopReason') == 'aborted':
                errors.append(f'{name}: final assistant message was aborted')
            break
print(f'Parent sessions: {parents}')
print(f'Child sessions: {children}')
if errors:
    print('ERRORS:')
    for err in errors:
        print(f'  - {err}')
    sys.exit(1)
print('All selected sessions are well-formed')
PY
```

Session validation supplements the test result; it does not replace the test-runner artifact.

## Step 6: Report

Report these items clearly:

- Working directory and git branch.
- Backend environment detected and whether `PI_SUBAGENT_MUX` was forced.
- Exact command passed to test-runner.
- Test-runner model/cli/thinking and child `PI_TEST_MODEL`.
- Artifact path.
- Parsed result: exit code, failing identifiers count, non-reconcilable count, Node test summary if visible.
- Optional session-validation summary.

Example summary:

```text
Integration test results
- Worktree: <path> (<branch>)
- Backend: Herdr (HERDR_ENV=1, PI_SUBAGENT_MUX=herdr)
- Command: PI_SUBAGENT_MUX=herdr PI_RUN_SLOW=1 PI_TEST_MODEL=openai-codex/gpt-5.4:medium npm run test:integration
- Test-runner: openai-codex/gpt-5.4 via pi, thinking=medium
- Artifact: docs/test-runs/integration/<timestamp>-integration.log
- Result: exit 0; failing identifiers 0; non-reconcilable failures 0
```

If the run fails, include the stable identifiers and non-reconcilable evidence and suggest the smallest next debugging step (usually rerun the failing file or inspect the named artifact).
