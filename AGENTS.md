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

Tests use `node:test` and `node:assert/strict`, with exported helpers or VM-based browser fixtures. Name files `<feature>.test.cjs` and use descriptive test names. Add focused regressions for changed behavior, mocking DOM/native APIs and publishing requests as appropriate. No numerical coverage threshold is configured. Run the affected suite during development and all tests before submitting. For UI changes, also check conversation switching, virtualized messages, and relevant outline/navigation interactions in the browser.

## Commit & Pull Request Guidelines

Follow the history's Conventional Commit style: `feat:`, `fix:`, `perf:`, or `chore:` followed by a concise description. Keep commits focused. Pull requests should explain the behavior change, link relevant issues, list validation performed, and include screenshots for visible UI changes. Update `README.md` when installation or user-facing behavior changes.

## Release & Configuration

For releases, update both `@version` and the startup log version; use the matching `v<version>` tag. Preserve the userscript filename and existing Gist `@updateURL`/`@downloadURL`. Keep `GIST_TOKEN` in GitHub Actions secrets. The publisher rejects downgrades and changed content under an existing version; run its mocked tests for local validation.
