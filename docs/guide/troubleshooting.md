# Troubleshooting

Turnleaf writes what it does, and any errors, to the **Turnleaf** output channel (**View → Output**, then choose **Turnleaf**). Start there when something looks wrong.

## "Overleaf session expired"

Overleaf sessions end after a while, or when you sign out of Overleaf elsewhere. Choose **Sign in again** in the message, or **Sign in with browser** in **Setup**. Cached comments, queued drafts and history stay available while you are signed out.

If the browser window opens but does not close after signing in, make sure you finished on an Overleaf page (for example the project list), not a sign-in or password page. After 10 minutes the attempt ends.

## "No Chrome, Edge, Brave or Chromium browser was found"

**Sign in with Browser** needs a Chromium-based browser. Install one, set `turnleaf.browserPath` to its executable, or choose **Paste session cookie** and follow [Sign in with a session cookie](getting-started.md#sign-in-with-a-session-cookie-fallback).

## "Trust this workspace before connecting to Overleaf"

Turnleaf runs only in trusted local folders. Run **Workspaces: Manage Workspace Trust** and trust the folder.

## "Another editor is updating this folder"

Two editor windows opened on the same folder share its `.turnleaf/` state, and only one can update it at a time. Let the other window finish its Turnleaf operation, then try again. A lock left behind by an editor that crashed expires after 30 seconds.

## Send is not available

When nothing can be sent, the outgoing summary says why and the main button shows the way out: **Get latest**, **Recover local apply**, **Save all**, **Enable sending**, or **Discard** on the blocking change in the **Waiting** list. Common reasons:

| Message | What to do |
| --- | --- |
| Get latest to establish the local sync baseline. | Run **Get latest** and **Apply** once to set the starting point. |
| … also changed on Overleaf where you edited. | Run **Get latest**, resolve the conflict, then look at the summary again. |
| … is missing in the local folder. | **Get latest** restores it from Overleaf, or remove it in **Choose files**. |
| Recover the interrupted local Apply first. | Choose **Recover local apply**. |
| Get latest to review the interrupted send before continuing. | Run **Get latest** to see what reached Overleaf. |
| Unsaved edits in … are not included. | Choose **Save all**. |
| Sending is off for this project. | Choose **Enable sending**. |
| A suggestion you decided was changed or decided on Overleaf. | **Discard** that decision in the **Waiting** list, then decide again. |
| Needs a new selection | Select the commented text again and choose **Update selection**. |
| An error in a review file | Fix the file named in `review/import-error.txt`. See [Errors](review-files-for-agents.md#errors). |

If Send reports **Nothing was sent: the summary changed since it was shown**, Overleaf or your files changed after you looked. The changed rows are marked **Changed**; check them and choose **Send** again.

A file is refused for upload if it is not valid UTF-8, has CR (Windows) line endings, contains a NUL character or a character outside the Basic Multilingual Plane (such as an emoji), or is larger than 1 MB. The message names the file; for some character problems it also gives the line and column.

## "Checking Overleaf…" stays on

After opening the window or changing the file selection, Turnleaf reads the project once before showing its state. With **Updates** set to **Manually**, nothing is read when the window opens. On large projects this can take a while. Overleaf also limits how often a project can be opened per minute; Turnleaf then waits and tries again by itself. If the state changes to **Remote state unknown**, check your network and sign-in, then choose **Check Remote Now**.

## Live updates or checks fail

A dot on the **Sync** tab means checks are failing. Turnleaf retries with growing delays. Choose **Check Remote Now** to try at once, or switch **Updates** to a fixed interval or **Manually** if a network blocks the live connection. The live connection pauses after 5 minutes with the window in the background and resumes when you return. Live and timed checks only detect Overleaf's edits and comments as incoming changes; they reach your editor after **Get latest** and **Apply**.

## Comment markers look like solid blocks

Open **Setup → Project setup → Comment appearance** and choose **Use outline comment markers**; this repairs their colors. **Restore editor markers** returns to the editor's own markers.

## Community Edition and Server Pro

- **overleaf.com** and **Server Pro** have comments and Track Changes, and are what Turnleaf is made for. For Server Pro, set `turnleaf.baseUrl` before signing in.
- **Community Edition** has no comments or Track Changes; these are Server Pro features. It also does not answer the request for a project's comment list that Turnleaf makes on every read, so Turnleaf cannot read Community Edition projects.

## Where Turnleaf keeps its data

| What | Where |
| --- | --- |
| Session | The editor's secret storage, one per server, and after **Sign in with browser** also the sign-in browser profile below. Never in a file in your folder. |
| Sign-in browser profile | Turnleaf's storage in the editor's user data, one per server. Removed by **Sign out**. |
| Project link, file selection, sending switch | Workspace folder settings (`.vscode/settings.json`). |
| Starting point, queued drafts, recovery copies, sync history, review files | `.turnleaf/projects/<project-key>/` in your folder. |
| Lock shared by editor windows | `.turnleaf/turnleaf.lock` |

The `.turnleaf/` folder contains copies of your source text and comments. Keep it private: add `.turnleaf/` to `.gitignore` if the folder is shared, and leave it out of anything you upload or send.

## Start over

To reset all of Turnleaf's local state in this folder:

1. Close every editor window on the folder.
2. Delete the `.turnleaf/` folder, or only `.turnleaf/projects/`. This removes the queued drafts, recovery copies and sync history of **every** project and file selection ever linked in this folder, not only the current one; send or copy anything you need first.
3. Reopen the folder and run **Get latest**. The first sync asks again how to handle files that differ.

To forget the sign-in, use **Sign out**. To unlink the project, remove `turnleaf.projectId` and `turnleaf.trackedFiles` from the workspace settings, or link another project with **Choose project**.

## Reporting a bug

Open an issue in the project's GitHub repository with:

- The Turnleaf version (shown at the bottom of the **Sync** tab), the editor and its version, and your operating system.
- What you did, what you expected and what happened.
- The relevant lines from the **Turnleaf** output channel.

**Never** include your session cookie, the contents of `.turnleaf/`, or private document text. The output channel does not contain the cookie, but it can contain file names and messages; look through it before pasting. For security problems, see [SECURITY.md](../../SECURITY.md).
