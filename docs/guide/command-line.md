# Command line for scripts and agents

`turnleaf` runs the same Get latest, review files and Send as the extension, without an editor. It is meant for scripts and AI agents, for example a bot account that reviews a paper and leaves comments on Overleaf.

It is a separate build and is not part of the extension package or the VSIX. Build it from a copy of the repository with Node.js 22 or newer:

```sh
git clone https://github.com/ZeyuXuAudio/Turnleaf.git && cd Turnleaf
npm ci --ignore-scripts
npm run build:cli
node dist/cli.js --help
```

`dist/cli.js` is not installed as a `turnleaf` command. The examples below write `turnleaf` for `node /path/to/Turnleaf/dist/cli.js`; to type them as written, define it once in your shell:

```sh
alias turnleaf='node /path/to/Turnleaf/dist/cli.js'
```

## A review round

Each command works on the current folder unless `--folder` names another one. The build above leaves the shell in the Turnleaf checkout, so the examples name the paper's folder:

```sh
turnleaf sign-in                                   # once; saves the session
turnleaf projects                                  # find the project ID
turnleaf link 0123456789abcdef01234567 --all-sources --folder ~/papers/my-paper
turnleaf pull --folder ~/papers/my-paper           # first run: downloads the files; later: merges
# ... an agent reads ~/papers/my-paper/.turnleaf/projects/<key>/review/REVIEW.md,
#     drops new comments into review/new/ and replies into threads/*.json ...
turnleaf send --dry-run --folder ~/papers/my-paper              # what would be written
turnleaf send --yes --comments-only --folder ~/papers/my-paper  # write it
```

The review files are described in [Review files for AI agents and scripts](review-files-for-agents.md). The command line turns them on at the first `pull`, and imports and regenerates them at every `pull`, `status` and `send`.

## Commands

| Command | What it does |
| --- | --- |
| `sign-in [--browser PATH] [--headless]` | Opens a Chromium-based browser at the Overleaf sign-in page and saves the session once you are signed in. |
| `projects` | Lists the projects of the signed-in account. |
| `link <project-id> --files a.tex,b.bib` or `--all-sources` | Links the folder to a project and chooses its `.tex`, `.bib`, `.sty` and `.cls` files. Writes `.turnleaf/cli.json`, and the `.gitignore` that keeps `.turnleaf/` out of Git. Linking the same project again with other files is refused while comment changes are queued for the current or the new selection, or a sync was interrupted: send or discard them first, or keep the same files. |
| `pull [--take-overleaf] [--dry-run]` | Get latest. In an empty linked folder, it downloads the selected files (and, with `--pictures`, the pictures). Later it merges Overleaf's changes. Stops if a file changed both here and on Overleaf where they overlap; `--take-overleaf` uses Overleaf's version for those files and marks them `tookOverleaf` in the JSON output. The first pull records the sync baseline even when nothing comes in. |
| `status` | Imports the review files, prints what Send would write, with any refusal, and regenerates the review files from what it read on Overleaf. |
| `send --yes` or `send --dry-run`, with `[--comments-only] [--allow-untracked-edits] [--allow-deletes]` | Send. `--dry-run` prints what it would write; without `--yes` or `--dry-run` it is a usage error and nothing is read or written. When Overleaf changed since the last pull without overlapping local edits, `send --yes` first writes those changes to the folder, as **Apply & send** does in the editor. |

Common options: `--folder DIR`, `--base-url URL` (or `TURNLEAF_BASE_URL`; default `https://www.overleaf.com`), `--session-file FILE` (or `TURNLEAF_SESSION_FILE`), `--pictures` to also synchronize pictures in `pull`, `status` and `send` (off by default), and `--json` for machine-readable output. An unknown option, an option of another command or an extra argument is a usage error.

`pull`, `status` and `send` use the server the folder is linked to. Because `.turnleaf/cli.json` lies in the folder and may come from someone else, they refuse when `--base-url` (or `TURNLEAF_BASE_URL`) names another server, and they send a cookie from `TURNLEAF_COOKIE` or from a chosen `--session-file` only to a server named that way, or to `https://www.overleaf.com` when none is named. The default session file belongs to one server and needs no naming.

## Checks a headless Send adds

Send keeps all of its own checks: it reads Overleaf again, writes only what the plan lists, verifies the result and records it in Sync history. Without a person reviewing the outgoing summary, these options refuse a Send instead:

- `--comments-only`: refuse when saved files or pictures changed, or when accepting or rejecting a suggestion is queued, so only comments, replies and resolutions go out. Pictures that Send would not send anyway (listed under `blockedPictures`) do not count.
- File edits are refused unless Track Changes is on for the signed-in account in this project and Overleaf names the account, because otherwise they change the text directly instead of arriving as suggestions. Creating a selected file that exists only locally is refused when it has content, because Overleaf receives a new file's content as plain text. `--allow-untracked-edits` lifts both checks.
- Deleting a thread, a message, a created file or a picture is refused unless `--allow-deletes` is given.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done (or nothing to do). |
| 1 | Failed, or Send verified a mismatch on Overleaf. |
| 2 | Usage error: an unknown option or command, an extra argument, `send` without `--yes` or `--dry-run`, or a server that does not match the folder's link. Checked before any file or session is read. |
| 3 | Needs a decision: a conflict, a refused check, incoming changes, an interrupted sync, an invalid review file, a draft that changes someone else's message, or a changed file selection with queued drafts. |
| 4 | Not signed in, or the session expired, also when it expired in the middle of Apply or Send. Run `sign-in` again. |

With `--json`, every failure prints one JSON object to stdout, `{"error": "...", "code": "...", "exitCode": 3}`, with `details` (for example the refused plan) where there are any. Once Send has written to Overleaf, its receipt (`sent`, `history`) is printed even when regenerating the review files afterwards fails; that failure is listed under `warnings`.

## The session

The session cookie is saved with owner-only permissions in `~/.config/turnleaf/session-<server>` (or under `XDG_CONFIG_HOME`), and the browser profile used to sign in next to it, one profile per server and session file. When Overleaf renews the cookie, the new one replaces the file in one step, also when the command stops at a refusal or an error. `TURNLEAF_COOKIE` supplies a cookie for one run without saving it. A session file that is a symbolic link, that others can read, or that lies inside the working folder is refused.

### Save the session by hand

When `sign-in` cannot open a browser (for example because an organization's policy blocks it), copy the cookie from any browser where you are signed in to Overleaf with the account to use: open the developer tools, then **Storage** (Safari, Firefox) or **Application** (Chrome) → **Cookies** → `https://www.overleaf.com`, and copy the complete value of `overleaf_session2`, without decoding it. With the value on the clipboard (macOS):

```sh
dir="${XDG_CONFIG_HOME:-$HOME/.config}/turnleaf"
mkdir -p "$dir" && chmod 700 "$dir"
(umask 077 && pbpaste > "$dir/session-3f828e58a73ebf93")
turnleaf projects                                  # lists your projects if the session works
```

`session-3f828e58a73ebf93` is the file name for `https://www.overleaf.com`. For another server, pass `--session-file FILE` (or set `TURNLEAF_SESSION_FILE`) and save the cookie there. Do not sign out in that browser afterwards: signing out ends the session on Overleaf, and the saved cookie stops working. When it expires, commands exit with code 4; save a new cookie the same way. Treat the session file like a password, and prefer a separate Overleaf account for automated reviews, so its comments are clearly labeled.
