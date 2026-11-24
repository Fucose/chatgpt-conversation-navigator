# Repository Guidelines

## Project Structure & Module Organization

- `chatgpt-conversation-navigator.user.js` contains the Tampermonkey metadata, navigation logic, native ChatGPT adapters, UI, and embedded CSS. Keep related helpers within the existing section boundaries.
- Root-level `*.test.cjs` files cover conversation state, native adapters, navigation, and publishing. There are no separate source or asset directories.
- `.github/scripts/publish-gist.cjs` implements publishing; `.github/workflows/publish-gist.yml` runs release validation and synchronization. `README.md` documents installation, behavior, and releases.

## Build, Test, and Development Commands

Use Node.js 24, matching the release workflow. No dependency installation or build step is required.

```sh
node --check chatgpt-conversation-navigator.user.js # Check syntax
node --test                                      # Run all tests
node --test reply-navigation.test.cjs             # Run a focused suite
git diff --check                                 # Check whitespace
```

For browser development, install or update the local userscript in Tampermonkey, reload ChatGPT, and exercise the affected behavior.

## Coding Style & Naming Conventions

Use four-space indentation, semicolons, camelCase functions and variables, and UPPER_SNAKE_CASE constants. Preserve the userscript's IIFE, CommonJS test exports, and divider comments. Keep styling embedded in the script. No formatter or linter is configured; follow the surrounding code and avoid unrelated formatting changes.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`, with exported helpers or VM-based browser fixtures. Name files `<feature>.test.cjs` and use descriptive test names. Add focused regressions for changed behavior, mocking DOM/native APIs and publishing requests as appropriate. No numerical coverage threshold is configured. Run the affected suite during development and all tests before submitting.

For browser-facing changes, first try to test in the user's Windows Edge using the `$connect-windows-edge` skill. Exercise the affected behavior on ChatGPT, including conversation switching, virtualized messages, and outline/navigation interactions when relevant. If Edge is unavailable, use the available browser or VM fixtures and report which checks ran.

## Project Continuity

For nontrivial work, read [docs/README.md](docs/README.md), the relevant files under `docs/architecture/` and `docs/decisions/`, the latest linked handoff, and the active plan if one exists. Then inspect the current code, tests, and `git status`; the documentation index is a reading route, not proof of current status.

- `docs/architecture/` records implemented behavior and verified technical facts.
- `docs/plans/` records intended multi-step work and lifecycle status.
- `docs/devlog/YYYY-MM.md` records work actually completed, evidence, and deviations.
- `docs/decisions/` records accepted durable technical tradeoffs.
- `docs/handoffs/` records the latest recovery point when work crosses sessions or agents.

Continue an existing plan for the same scope instead of creating a competing one. At meaningful checkpoints, interruptions, or handoffs, update the devlog and durable handoff with actual progress, incomplete work, exact verification, and authorization boundaries. A plan or handoff never authorizes commits, pushes, releases, or other separately controlled actions. When behavior or durable rationale changes, update current knowledge, decisions, and the documentation index as applicable. Use one active writer per documentation file and merge rather than overwrite another writer's newer state.

## Commit & Pull Request Guidelines

Follow the history's Conventional Commit style: `feat:`, `fix:`, `perf:`, or `chore:` followed by a concise description. Keep commits focused. Pull requests should explain the behavior change, link relevant issues, list validation performed, and include screenshots for visible UI changes. Update `README.md` when installation or user-facing behavior changes.

## Versioning

Update `@version` and the startup log version together when the user explicitly requests a version change or before making an authorized commit. A commit request includes the version bump without separate confirmation. If the pending changes already include the intended bump, use that version. Keep the version unchanged during development until one of these conditions applies.

## Commit, Push, and Publish to Gist

For an authorized Gist release, publish through `.github/workflows/publish-gist.yml`. The workflow is triggered by pushing an annotated `v<version>` tag to `origin`, runs the Node.js 24 checks, and updates only `chatgpt-conversation-navigator.user.js` in the existing Gist. Preserve the filename and both Gist metadata URLs. Keep `GIST_TOKEN` in GitHub Actions secrets. The publisher rejects version downgrades and changed content under an existing version.

1. After bumping the version, confirm the branch and release scope, check that the tag is unused locally and remotely, and run the checks below. Use the same shell variables in the remaining steps.

   ```bash
   release_file=chatgpt-conversation-navigator.user.js
   release_version=$(awk '$2 == "@version" {print $3}' "$release_file")
   release_tag="v$release_version"
   release_branch=$(git branch --show-current)
   git status --short --branch
   git tag --list "$release_tag"
   git ls-remote origin "refs/heads/$release_branch" "refs/tags/$release_tag"
   node --check "$release_file"
   node --test
   git diff --check
   ```

2. Set `release_paths` to the approved paths as a Bash array and `release_commit_message` to the approved Conventional Commit message. Review the staged diff before committing. Tag that commit, then push the branch and tag together. The tag push starts publication.

   ```bash
   git add -- "${release_paths[@]}"
   git diff --cached --check
   git diff --cached --name-status
   git diff --cached
   git commit -m "$release_commit_message"
   git tag -a "$release_tag" -m "Release $release_tag" HEAD
   git push --atomic origin \
     "refs/heads/$release_branch:refs/heads/$release_branch" \
     "refs/tags/$release_tag:refs/tags/$release_tag"
   ```

3. Find the workflow run whose `headSha` matches `git rev-parse "$release_tag^{commit}"`. Set `release_run_id` to that run's `databaseId` and wait for it to succeed.

   ```bash
   gh run list --workflow publish-gist.yml --branch "$release_tag" \
     --json databaseId,headSha,status,conclusion,url
   gh run watch "$release_run_id" --exit-status
   ```

4. Compare the Gist revision URL and the stable update URL with the tagged file. Report the commit, tag, workflow result, and installation link after both hashes match.

   ```bash
   set -euo pipefail
   release_revision_url=$(gh api gists/fc9f1963666d75e7f93a5edceae137c7 \
     --jq '.files["chatgpt-conversation-navigator.user.js"].raw_url')
   release_update_url=$(git show "$release_tag:$release_file" | awk '$2 == "@updateURL" {print $3}')
   release_hash=$(git show "$release_tag:$release_file" | sha256sum)
   for release_url in "$release_revision_url" "$release_update_url"; do
     downloaded_hash=$(curl -fsSL -H 'Cache-Control: no-cache' "$release_url" | sha256sum)
     test "$downloaded_hash" = "$release_hash"
   done
   ```
