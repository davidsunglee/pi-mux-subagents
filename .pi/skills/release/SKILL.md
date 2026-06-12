---
name: release
description: Create a GitHub and npm release with a todo checklist, reviewed changelog, preflight checks, and a gitleaks scan. Use when asked to "release", "cut a release", "publish version", "bump version", "create release".
---

# Release

Create a versioned GitHub release and publish the npm package with an auto-generated changelog from commits since the last release.

## Step 0: Create or Refresh Release Todos

Before doing release work, create a todo checklist so `/release` can drive the whole process visibly. If a release checklist already exists, refresh it instead of duplicating tasks.

Use these canonical tasks, adapting names only when the project has a more specific convention:

1. Confirm release version
2. Audit release state
3. Prepare release notes
4. Review release notes
5. Bump package version
6. Run pre-release verification
7. Run git leaks check
8. Commit and tag release
9. Push release refs
10. Publish npm package
11. Create GitHub release
12. Verify release end to end

Include these dependencies:

- Prepare release notes depends on auditing release state.
- Review release notes depends on preparing release notes.
- Bump package version depends on confirming the release version and approving the release notes.
- Pre-release verification and git leaks check depend on the version bump.
- Commit and tag release depends on pre-release verification and git leaks check.
- Push release refs depends on commit and tag release.
- Publish npm package depends on pushed release refs.
- Create GitHub release depends on pushed release refs and npm publication.
- Verify release end to end depends on npm publication and GitHub release creation.

If audit discovers a blocker, such as missing npm authentication, create a separate blocker todo and add it to the affected downstream task instead of dropping or silently skipping that release step.

Mark exactly one todo as in progress at a time, and update each todo immediately as the release advances.

## Step 1: Determine Version

Check the current version and latest git tag:

```bash
cat package.json | grep '"version"'
git tag -l --sort=-v:refname | head -5
```

If the user provided a version, use it. Otherwise ask:

> What version? (current is X.Y.Z — patch/minor/major, or exact version)

Resolve semver:
- `patch` → X.Y.(Z+1)
- `minor` → X.(Y+1).0
- `major` → (X+1).0.0
- Exact version string → use as-is

## Step 2: Generate Release Notes

Get commits since the last tag (or all commits if no tags exist):

```bash
# If tags exist:
git log $(git tag -l --sort=-v:refname | head -1)..HEAD --pretty=format:"- %s" --no-merges

# If no tags:
git log --pretty=format:"- %s" --no-merges
```

Group commits by type using conventional commit prefixes:

| Prefix | Section |
|--------|---------|
| `feat` | ✨ Features |
| `fix` | 🐛 Bug Fixes |
| `refactor` | ♻️ Refactoring |
| `docs` | 📝 Documentation |
| `chore`, `test`, `perf`, `ci` | 🔧 Other Changes |
| No prefix | 🔧 Other Changes |

Format as markdown. Omit empty sections. Strip the `type(scope):` prefix from each line for readability.

Start with grouped commit sections.

Example output:

```markdown
## ✨ Features

- Add live subagent status widget
- Make subagent tool async — return immediately, steer on completion

## 🐛 Bug Fixes

- Fix session file collision with 3+ concurrent agents
- Truncate widget lines to terminal width
```

Write the draft to a temporary file, for example `/tmp/release-notes-v<VERSION>.md`, so it can be reviewed, edited, and later passed to `gh release create --notes-file`.

## Step 3: Manual Release Notes Review

Show the release notes draft to the user and explicitly ask for review before continuing.

Required behavior:

- Provide the release notes file path.
- Paste or summarize the full draft in the conversation.
- Pause for user approval or edits.
- If the user requests changes, edit the notes and show the revised draft.
- Do **not** continue to version bump, verification, commit/tag, push, npm publish, or GitHub release creation until the user explicitly approves the release notes.

Use the reviewed notes file for the GitHub release. Do not regenerate or replace the approved notes later unless the user asks.

## Step 4: Update package.json

Bump the version in `package.json`:

```bash
# Read, update, write back — don't use npm version (it may auto-commit)
```

Use a precise edit to change only the version field. Update lockfiles only if the project requires it for the version bump.

## Step 5: Pre-release Verification and Git Leaks Check

Run all release gates before committing, tagging, pushing, creating the GitHub release, or publishing to npm.

At minimum:

```bash
git status --short --branch
pnpm run check
gitleaks detect --source . --verbose --redact
```

Run any additional release-appropriate project checks the user requests, such as integration or slow test suites.

Do **not** continue if any verification command fails or if `gitleaks` reports findings. If `gitleaks` is unavailable, stop and ask the user whether to install it or use an approved alternative; do not skip the leak check silently.

## Step 6: Commit, Tag, Push

```bash
git add package.json
# Also add lockfiles or generated artifacts if they intentionally changed.
git commit -m "chore(release): v<VERSION>"
git tag v<VERSION>
git push origin HEAD
git push origin v<VERSION>
```

## Step 7: Publish to npm

Do **not** run `npm publish` from the agent session. The user handles npm publication directly so one-time passwords, browser auth, and publish credentials never need to enter the agent session.

Print the exact commands for the user to run from the repository root, then pause until the user confirms publication completed:

```bash
npm whoami
npm publish --dry-run --access public
npm publish --access public
npm view <PACKAGE_NAME>@<VERSION> version
```

Use the package name from `package.json`. Keep `--access public` for scoped public packages. If npm asks for OTP or web authentication, the user should complete it outside the agent session. Do not ask the user to paste OTP codes into the conversation.

After the user confirms publication, verify with:

```bash
npm view <PACKAGE_NAME>@<VERSION> version
```

## Step 8: Create GitHub Release

Use the reviewed release notes file from Step 3:

```bash
gh release create v<VERSION> --title "v<VERSION>" --notes-file /tmp/release-notes-v<VERSION>.md
```

If the notes are intentionally inline instead of file-backed, pass the reviewed changelog as the `--notes` value:

```bash
gh release create v<VERSION> --title "v<VERSION>" --notes "<REVIEWED_CHANGELOG>"
```

## Step 9: Verify

Confirm the release, tag, npm package, and local repository state:

```bash
gh release view v<VERSION>
git ls-remote --tags origin v<VERSION>
npm view <PACKAGE_NAME>@<VERSION> version
git status --short --branch
```

Print a summary:

```
✅ Released v<VERSION>
   Tag: v<VERSION>
   GitHub: https://github.com/<owner>/<repo>/releases/tag/v<VERSION>
   npm: <PACKAGE_NAME>@<VERSION>
```
