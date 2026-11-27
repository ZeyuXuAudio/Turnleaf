# Contributing to Turnleaf

Thank you for helping. Bug reports, fixes and documentation improvements are welcome. For larger changes, please open an issue first to agree on the approach.

## Prerequisites

- Node.js 22 or newer (the packaging tool `vsce` needs it)
- Git (`npm test` creates temporary Git repositories)
- VS Code 1.85.2 or newer, or Cursor
- Network access for the first `npm test` (see below)

## Build and test

```sh
npm ci --ignore-scripts
npm run check      # type-check
npm test           # unit, protocol and workflow tests
npm run build      # bundle into dist/
npm run package    # build and create releases/turnleaf-<version>.vsix
```

To run the extension from source, open the repository in VS Code or Cursor and press **F5** to start the **Run Turnleaf** configuration. It opens a development window with the extension loaded. To try a packaged build, install the `.vsix` with **Extensions: Install from VSIX…**.

## Code layout

`src/core/` holds everything that does not depend on the editor: the origin-restricted HTTP transport and Socket.IO client for Overleaf, document and comment-range handling, the three-way merge, the folder-based sync workflow and its local state in `.turnleaf/`, the review files, pictures and PDF annotation. Writes to Overleaf go through a single guard that requires sending to be enabled and records each write. `src/extension/` is the VS Code layer: activation, commands, the sidebar and larger view (webviews), native comment threads, editor decorations, diffs and sync history. Keep editor APIs out of `src/core/` so that it stays testable in plain Node.

## Other test commands

| Command | What it does |
| --- | --- |
| `npm run test:editor` | Launches VS Code with a temporary profile against a local fixture server and runs the extension's UI workflow. Set `TURNLEAF_EDITOR` to another VS Code or Electron executable, such as `/Applications/Cursor.app/Contents/MacOS/Cursor`. |
| `npm run test:press` | Like `test:editor`, but presses the panel's **Send** button with real mouse input through the editor's DevTools port, opened on a free local port for the run: a press that sends, one during a refresh, one just after the summary changed, a double click and a press held while the panel redraws. Checks the press record, the output channel and the notice in the panel for each. |
| `npm run test:fixture` | Starts a local fixture server and prints a workspace path and a fictional cookie, for trying the extension by hand. |
| `npm run test:live` | Read-only probe against your real Overleaf account in a reusable editor profile (`TURNLEAF_LIVE_PROFILE` to move it). Needs a one-time sign-in. |
| `npm run test:ce` | Starts Overleaf Community Edition in Docker, seeds throwaway projects and checks the extension against them, through a test-only adapter for the comment-threads route that stock Community Edition lacks. Needs Docker and about 4 GB of disk. `-- --help` lists the options. |
| `npm run test:installed` | Installs the packaged VSIX (run `npm run package` first) into a disposable VS Code profile and checks it in production mode, with a fictional session. It is interactive: when the test window asks for the session cookie, enter `fictional-fixture-session`. |

`npm test`, `test:editor`, `test:press`, `test:fixture` and `test:installed` first run `scripts/fetch-reference.mjs`. It downloads a few files of Overleaf's own editing code, pinned to a commit and checked by SHA-256, into the git-ignored `test/reference/` folder. Some tests compare Turnleaf with that code. It is licensed under the AGPL-3.0, used only for testing, and is neither part of this repository nor bundled with the extension; the build fails if it reaches the bundle.

No test needs a real Overleaf cookie except `test:live`, which keeps the session in its own editor profile and never prints it.

## Pull requests

- Run `npm run check` and `npm test` before opening a pull request.
- Keep changes focused, and follow the style of the surrounding code.
- Update the [user guide](docs/guide/README.md) and [CHANGELOG.md](CHANGELOG.md) (under **Unreleased**) when behavior changes.
- Never commit cookies, `.turnleaf/` folders, test profiles or private project content.

## Releasing a new version

For maintainers. Release from the main checkout, on an up-to-date `main` with a clean working tree; merge any branch or worktree first, because a `.vsix` built in a worktree is deleted with it. The steps below use `0.10.8` as the new version.

1. **Test.** `npm run check`, `npm test` and `npm run test:editor` must pass. When the change touches the sidebar or the panel, also run `npm run test:press`.
2. **Set the version.** Run `npm version 0.10.8 --no-git-tag-version`, which updates `package.json` and `package-lock.json`. In [CHANGELOG.md](CHANGELOG.md), rename `## Unreleased` to `## 0.10.8`.
3. **Package and check the package.** `npm run package` writes `releases/turnleaf-0.10.8.vsix` (Git ignores `releases/`). Then run `npm run test:installed`, which installs that file into a disposable VS Code profile.
4. **Commit.** Commit `package.json`, `package-lock.json` and `CHANGELOG.md` as `Release 0.10.8: <the change in a few words>`. The build writes [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) from the bundled packages. If it changed because a dependency was added, removed or updated, commit it too, after checking the diff.
5. **Tag and push.** Run `git tag v0.10.8`, then `git push origin main v0.10.8`.
6. **GitHub release.** Cursor users install from here. The notes are the version's CHANGELOG section without its heading:

   ```sh
   gh release create v0.10.8 releases/turnleaf-0.10.8.vsix --title "Turnleaf 0.10.8" \
     --notes "$(awk '$0 == "## 0.10.8" { f = 1; next } /^## / { f = 0 } f' CHANGELOG.md)"
   ```

7. **VS Code Marketplace.** On the [publisher management page](https://marketplace.visualstudio.com/manage/publishers/zeyuxu), choose **⋯ → Update** for Turnleaf and upload the same `.vsix`. The upload is done by hand there; `vsce publish` is not set up. VS Code installs the new version once the Marketplace has verified it, which usually takes a few minutes.

A version that was merged but never published needs no release of its own: the next version's package includes its changes. Add the skipped version's CHANGELOG section to the GitHub release notes, under its own `## <version>` heading.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
