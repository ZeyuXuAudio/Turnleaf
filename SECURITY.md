# Security

Turnleaf works with your Overleaf session and with private document text. This page explains what it stores, what it contacts, and how to report a security problem.

## What Turnleaf stores, and where

| Data | Where | Notes |
| --- | --- | --- |
| Overleaf session (`overleaf_session2` cookie) | The editor's secret storage (the operating system keychain or the editor's encrypted store) | One entry per server. Never written to your workspace, settings, logs or sync history. Removed by **Sign out**. |
| Sign-in browser profile | Turnleaf's global storage in the editor's user data folder, under `sign-in/` | A private Chromium profile used only by **Sign in with Browser**, one per server, created with owner-only permissions. It holds an Overleaf session too. Removed by **Sign out**. |
| Project link, file selection, sending switch, preferences | Workspace settings (`.vscode/settings.json`) | No secrets. |
| Local sync state | `.turnleaf/` in your workspace folder | See below. |

The `.turnleaf/` folder is created with owner-only permissions. It contains, per server, project and file selection:

- the last synchronized version of each file and the latest fetched comments and suggestions;
- queued comment drafts;
- recovery checkpoints for an interrupted Apply;
- sync history with **exact before and after copies** of synchronized text files and comment changes; pictures are recorded by hash and size, and the bytes of a picture that was overwritten are kept, but the bytes of a newly sent picture are not;
- a log of every write sent to Overleaf;
- the review files for AI agents and scripts.

This is private source and comment text. Keep `.turnleaf/` out of shared folders, public repositories and archives you send to others; add `.turnleaf/` to `.gitignore` if the folder is a Git repository. Turnleaf does not change `.gitignore`.

No file in your workspace contains the session cookie.

## What Turnleaf contacts

- **Only the configured Overleaf server** (`turnleaf.baseUrl`, by default `https://www.overleaf.com`). Every request is checked against that server's origin before the cookie is attached; requests and redirects to any other origin are refused.
- **No telemetry, analytics or crash reporting.** Turnleaf sends nothing about you or your usage anywhere.

Turnleaf starts two kinds of local programs:

- For **Sign in with Browser**, a Chromium-based browser with the private profile above, opened on the server's sign-in page. Turnleaf talks to it over a pipe, not a network port, so other local programs cannot attach to it. Once you are signed in, Turnleaf reads the session cookie for the configured server and closes the browser. Pages you visit in that window are loaded by the browser, as in any browser.
- For **Export Annotated Review PDF**, the `synctex` command from your TeX installation.

Turnleaf never runs Git.

## Writes to Overleaf

- Nothing is written until **Enable sending** is turned on for the project. It is off by default for a new project, and **Choose project** turns it off again when the project changes.
- Every write passes through one guard that checks this switch, refuses invalid text (wrong encoding, line endings or size), and records the write before it starts.
- Send writes only what the outgoing summary showed. It first reads every selected file from Overleaf again and sends nothing if anything differs.
- Turnleaf never deletes or renames files on Overleaf, except that **Undo this send** removes a file Turnleaf itself created and that is unchanged since.

## Treat the session cookie like a password

Anyone with your `overleaf_session2` value can act as you on Overleaf until the session ends. Never paste it into issues, chats or screenshots. If you think it leaked, sign out of Overleaf in your browser (or change your password) to end the session, then sign in to Turnleaf again.

## Reporting a vulnerability

Please report security problems privately:

1. Use GitHub's private vulnerability reporting: on the repository page, open **Security → Report a vulnerability**.
2. If that is not available, open a regular issue that only asks for a private contact. Do not include any details of the problem.

Include the Turnleaf version, your editor and operating system, and the steps to reproduce. **Never include session cookies, the contents of `.turnleaf/`, or private document text**; use a throwaway Overleaf project if an example is needed.

Fixes are made for the latest released version.
