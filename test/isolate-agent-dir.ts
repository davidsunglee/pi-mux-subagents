// Unit/orchestration tests resolve launch specs against a temp `cwd`, and
// `getDefaultSessionDirFor` eagerly `mkdirSync`s a session directory under
// `getAgentConfigDir()` (`PI_CODING_AGENT_DIR ?? ~/.pi/agent`). When the env var
// is unset those writes land in the developer's real `~/.pi/agent/sessions/`,
// which (a) pollutes the home directory with thousands of `--var-folders-...--`
// stubs and (b) fails with `EPERM` under a sandboxed runner (e.g. the Codex
// seatbelt test-runner) because `~/.pi` is outside the writable workspace roots.
//
// Default the config dir to a throwaway temp directory so the suite is hermetic
// regardless of where it runs. Tests that set/restore PI_CODING_AGENT_DIR
// themselves still override this default; an already-set value is left intact.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PI_CODING_AGENT_DIR) {
  const isolatedAgentDir = mkdtempSync(join(tmpdir(), "pi-test-agent-"));
  process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
  process.on("exit", () => {
    try {
      rmSync(isolatedAgentDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; the OS reaps TMPDIR anyway.
    }
  });
}
