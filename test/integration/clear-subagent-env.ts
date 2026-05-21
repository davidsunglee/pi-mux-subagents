// Integration tests must be independent of the pi subagent session that may be
// running the test command. Parent subagent runtime variables (especially
// PI_DENY_TOOLS) otherwise change extension activation and child lifecycle
// behavior before the tests can set their own fixtures.
for (const key of [
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_AUTO_EXIT",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_ACTIVITY_FILE",
  "PI_SUBAGENT_SURFACE",
]) {
  delete process.env[key];
}
