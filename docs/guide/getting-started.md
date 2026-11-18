# Getting started

This page takes you from installing Turnleaf to a linked project with chosen files. The same steps are in the **Getting Started** walkthrough: open **Welcome → Walkthroughs → Turnleaf**, or run **Turnleaf: Open Getting Started** from the Command Palette.

## Install

Turnleaf is currently installed from a VSIX file. Publication on the Visual Studio Marketplace and Open VSX is coming soon.

1. Get `turnleaf-<version>.vsix` from the repository's Releases page, or build it yourself (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).
2. In VS Code or Cursor, run **Extensions: Install from VSIX…** and choose the file.

You need VS Code 1.85.2 or newer, or a current Cursor release.

## Open and trust your folder

Open the local folder that holds your LaTeX sources (**File → Open Folder…**). Turnleaf works with an ordinary folder; Git is not needed, and an existing Git repository is treated as an ordinary folder.

Turnleaf only runs in a **trusted** workspace. If the editor asks whether you trust the authors of the files in this folder, choose **Yes, I trust the authors**. In Restricted Mode, run **Workspaces: Manage Workspace Trust** and trust the folder.

Then open **Turnleaf** in the Activity Bar. The sidebar has a header with the sync state and main actions, and three tabs: **Review**, **Setup** and **Sync**. Until the project is set up, the **Setup** tab is shown first and walks you through the four steps below.

## Use a self-hosted server

Turnleaf connects to `https://www.overleaf.com` by default. For an Overleaf Server Pro installation, set `turnleaf.baseUrl` to its address before signing in, for example with **Preferences: Open Workspace Settings (JSON)**:

```json
{
  "turnleaf.baseUrl": "https://overleaf.example.edu"
}
```

The address must use `https://` or `http://` and must not contain a user name, password, query or fragment. Each server has its own sign-in.

Overleaf Community Edition is not supported: it has no comments or Track Changes, and Turnleaf cannot read projects from it. See [Troubleshooting](troubleshooting.md#community-edition-and-server-pro).

## Sign in

### Sign in with Browser (recommended)

1. In **Setup**, choose **Sign in with browser** (or run **Turnleaf: Sign In with Browser**).
2. A separate browser window opens on Overleaf's sign-in page. Sign in as you normally would.
3. The window closes by itself once you are signed in. The sidebar then shows **Connected** and the server name.

Turnleaf uses Chrome, Edge, Brave or Chromium, whichever it finds first. To use a particular browser, set `turnleaf.browserPath` to its executable. The sign-in window uses its own private browser profile, separate from your everyday browser; Turnleaf keeps that profile so that signing in again later usually takes one click. If you do not sign in within 10 minutes, the attempt ends; choose **Sign in with browser** again when you are ready.

### Sign in with a session cookie (fallback)

Use this when no supported browser is installed or the browser window cannot be used.

1. In **Setup**, choose **Use a session cookie instead** (or run **Turnleaf: Sign In with Session Cookie**).
2. Paste the value of your `overleaf_session2` cookie into the masked prompt.

To find the cookie in Chrome:

1. Sign in to Overleaf in Chrome.
2. Open **⋮ → More Tools → Developer Tools**, or press **⌘⌥I** on Mac / **Ctrl+Shift+I** on Windows and Linux.
3. Select **Application → Storage → Cookies → https://www.overleaf.com** (or your server).
4. Copy the complete `overleaf_session2` value with URL decoding off. Paste only the value, not the name.

Either way, the session is stored in the editor's secret storage. **Sign in with browser** also keeps a copy in its private browser profile, in the editor's user data folder, until you **Sign out**. The session is never written to your workspace or to settings; see [SECURITY.md](../../SECURITY.md#what-turnleaf-stores-and-where). Treat the cookie like a password: anyone who has it can act as you on Overleaf.

## Link a project

Choose **Choose project** in **Setup** (or run **Turnleaf: Link Project**) and pick the Overleaf project from the list. The link is stored as `turnleaf.projectId` in the folder's workspace settings.

Linking a different project turns sending off again and clears the file selection, so the next step opens straight away.

## Choose files

**Choose files** (or **Turnleaf: Choose Source Files**) opens a multi-select list. Nothing is synchronized until you choose files here. Right after you choose a project, the list opens with every source file on Overleaf ticked and the main document first.

The list has up to four groups:

- Files on Overleaf, listed first: `.tex`, `.bib`, `.sty` and `.cls` files of the project.
- **Only in the local folder**: local source files that are not on Overleaf yet. They are marked **new on Overleaf: created at Send**; Send creates them, together with any missing folders.
- **Neither local nor on Overleaf**: previously selected files that no longer exist anywhere. They start unticked, so **OK** removes them from the selection.
- **Pictures only in the local folder**: local PNG, JPG and PDF files that are not on Overleaf. Ticked pictures are uploaded at Send.

Pictures already on Overleaf do not need to be chosen: they are synchronized automatically while `turnleaf.syncPictures` is on. See [Pictures and PDF figures](syncing.md#pictures-and-pdf-figures).

The selection is stored as `turnleaf.trackedFiles`. Adding files later keeps the current sync state, queued comment changes and history, unless the larger selection already has a newer sync of its own (that one is used), or a sync was interrupted (finish it first, with **Recover local apply** or **Get latest**). Each server, project and file selection has its own local state.

To look at what Overleaf holds for the chosen files without syncing anything, run **Turnleaf: Inspect Project (Read Only)**. It opens a read-only report, and **Turnleaf: Open Inspected File** opens the fetched text of one file.

## Enable sending

Sending is off by default for a new project, so Turnleaf starts read-only. Until you turn on sending, you can get the latest changes, read comments and prepare replies, but nothing is written to Overleaf.

When you are ready to publish, choose **Enable sending** in **Setup** (or in the header when there is something to send). This sets `turnleaf.allowWrites` for this folder; you do not need to edit any JSON. Choose **Disable** in **Setup** to turn it off again. **Choose project** also turns it off when the project changes.

Next: [get the latest changes and set the starting point](syncing.md#get-latest).

## Sign out

Choose **Sign out** at the bottom of **Setup**, or run **Turnleaf: Sign Out**. This removes the stored session and the private sign-in browser profile for the current server and closes the live connection. Cached comments, queued drafts and history stay available.
