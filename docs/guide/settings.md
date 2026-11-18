# Settings

Most settings are changed for you by the sidebar: signing in, choosing a project and files, enabling sending, the comment appearance and the update interval. You can also edit them in **Preferences: Open Settings** (search for "Turnleaf") or in `.vscode/settings.json`.

Turnleaf stores the project link, file selection and sending switch as **workspace folder** settings, so each folder has its own. `turnleaf.browserPath` is a machine setting.

## Connection and project

| Setting | Default | Meaning |
| --- | --- | --- |
| `turnleaf.baseUrl` | `"https://www.overleaf.com"` | Overleaf server address. Set it before signing in to use a Server Pro installation. |
| `turnleaf.browserPath` | `""` | Chromium-based browser (Chrome, Edge, Brave or Chromium) used for **Sign in with Browser**. Leave empty to detect one. |
| `turnleaf.projectId` | `""` | Linked Overleaf project ID. Set by **Choose project**. |
| `turnleaf.trackedFiles` | `[]` | Project-relative source files to review and synchronize (`.tex`, `.bib`, `.sty`, `.cls`). Set by **Choose files**; nothing is synchronized until files are chosen. |

## Syncing

| Setting | Default | Meaning |
| --- | --- | --- |
| `turnleaf.allowWrites` | `false` | Allow reviewed file and comment changes to be sent to Overleaf. Changed by **Enable sending** in **Setup**. Off for a new project; **Choose project** turns it off when the project changes. |
| `turnleaf.sendCheck` | `"full"` | How Send checks Overleaf around its writes. `full`: reads every selected file again before and after the writes. `fast`: with a live connection, the checks around the writes re-read only the files Overleaf reported as edited and the files it wrote; without one, they read in full. Send always reads every selected file first. See [Fast or Full check](syncing.md#fast-or-full-check). |
| `turnleaf.syncPictures` | `true` | Get latest also brings in the PNG, JPG and PDF files of the Overleaf project, compared by content. Off leaves local pictures alone. |
| `turnleaf.liveUpdates` | `true` | Keep one connection to the linked project open and show its edits and comments as they happen. Its edits and comments show up as incoming changes and reach the editor after **Get latest** and **Apply**. A 60-second check over the same connection catches anything missed. Pauses after 5 minutes with the window in the background. |
| `turnleaf.remoteCheckInterval` | `10` | When live updates are off: how often, in seconds, to check the selected files and comments, without applying anything. `0` (only when requested), `10`, `30` or `60`. Checks back off after failures. |

The **Updates** menu in the **Sync** tab sets `turnleaf.liveUpdates` and `turnleaf.remoteCheckInterval` together.

## Comments and review

| Setting | Default | Meaning |
| --- | --- | --- |
| `turnleaf.commentMarkers` | `"belowParagraph"` | Where comment markers go in the gutter while word wrap is on. `belowParagraph`: on the blank line under the commented line; without a blank line there, no marker while **Highlights** is on (with it off, the marker stays on the commented line). `commentedLine`: on the line where the comment ends, repeated on each wrapped row. With word wrap off, markers stay on the commented line. |
| `turnleaf.localReviewFiles` | `true` | Keep the comments as files under `.turnleaf/projects/<key>/review/`, where AI agents and scripts can read them and queue replies, resolutions and new comments. Off imports what was saved there and removes the folder; queued drafts stay. See [Review files for AI agents and scripts](review-files-for-agents.md). |
| `turnleaf.reviewLogPath` | `"docs/overleaf_review_log.md"` | Where **Export Review Log** writes. The export overwrites this file. |

## Sync history

| Setting | Default | Meaning |
| --- | --- | --- |
| `turnleaf.historyLimit` | `50` | Finished sync-history records to keep. `0` keeps all. Records an interrupted sync still needs are always kept. |
| `turnleaf.historyDays` | `90` | Remove finished sync-history records older than this many days. `0` keeps them regardless of age. |

## Colors

Turnleaf's colors follow your theme. To change them, use `workbench.colorCustomizations`:

| Color | Used for |
| --- | --- |
| `turnleaf.accent` | Accent for Turnleaf controls and outline icons |
| `turnleaf.buttonBackground` | Background of the main action; follows the theme's button color by default |
| `turnleaf.addedForeground`, `turnleaf.removedForeground` | Added and removed line counts |
| `turnleaf.addedLineBackground`, `turnleaf.removedLineBackground` | Added and removed lines in preview diffs |
| `turnleaf.addedTextBackground`, `turnleaf.removedTextBackground` | Added and removed text in preview diffs |
| `turnleaf.commentBackground`, `turnleaf.commentBorder` | Background and underline of commented text |

For example:

```json
{
  "workbench.colorCustomizations": {
    "turnleaf.commentBackground": "#ffd54f33"
  }
}
```
