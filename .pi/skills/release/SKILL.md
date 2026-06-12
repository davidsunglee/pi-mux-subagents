---
name: release
description: Create a GitHub and npm release with changelog, preflight checks, and a gitleaks scan. Use when asked to "release", "cut a release", "publish version", "bump version", "create release".
---

# Release

Create a versioned GitHub release and publish the npm package with an auto-generated changelog from commits since the last release.

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

## Step 2: Generate Changelog

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

## Step 3: Update package.json

Bump the version in `package.json`:

```bash
# Read, update, write back — don't use npm version (it may auto-commit)
```

Use a precise edit to change only the version field. Update lockfiles only if the project requires it for the version bump.

## Step 4: Pre-release Verification and Git Leaks Check

Run all release gates before committing, tagging, pushing, creating the GitHub release, or publishing to npm.

At minimum:

```bash
git status --short --branch
pnpm run check
gitleaks detect --source . --verbose --redact
```

Run any additional release-appropriate project checks the user requests, such as integration or slow test suites.

Do **not** continue if any verification command fails or if `gitleaks` reports findings. If `gitleaks` is unavailable, stop and ask the user whether to install it or use an approved alternative; do not skip the leak check silently.

## Step 5: Commit, Tag, Push

```bash
git add package.json
# Also add lockfiles or generated artifacts if they intentionally changed.
git commit -m "chore(release): v<VERSION>"
git tag v<VERSION>
git push origin HEAD
git push origin v<VERSION>
```

## Step 6: Publish to npm

Confirm npm authentication, inspect the package contents, then publish:

```bash
npm whoami
npm publish --dry-run --access public
npm publish --access public
npm view <PACKAGE_NAME>@<VERSION> version
```

Use the package name from `package.json`. Keep `--access public` for scoped public packages.

## Step 7: Create GitHub Release

```bash
gh release create v<VERSION> --title "v<VERSION>" --notes "<CHANGELOG>"
```

Pass the generated changelog as the `--notes` value. Use a temp file if the changelog is long:

```bash
echo "<CHANGELOG>" > /tmp/release-notes.md
gh release create v<VERSION> --title "v<VERSION>" --notes-file /tmp/release-notes.md
rm /tmp/release-notes.md
```

## Step 8: Verify

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
