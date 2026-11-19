# Syncing with Overleaf

Turnleaf moves changes in two directions, and both are reviewed first:

- **Get latest** brings Overleaf's changes into your local files after a merge preview.
- **Send** writes your saved edits and queued comment changes to Overleaf, exactly as listed in the outgoing summary.

The header at the top of the sidebar always shows the sync state, whether Turnleaf is connected, and the one or two actions that make sense right now.

## Get latest

Choose **Get latest** in the header (or run **Turnleaf: Get Latest (Preview)**). Turnleaf reads the selected files and comments from Overleaf and prepares a three-way merge between the last synchronized version, your saved local files and Overleaf's current text.

The preview appears in the **Review** tab under **Changes to local**:

- Each file is listed with its added and removed line counts, the lines its diff marks on each side; a changed line counts as one removed and one added. Click a file to open a diff from **Local now** to **After merge**.
- Incoming comment changes are listed below the files, with their content before and after.
- Previewing changes nothing: your source files stay as they are and the last synchronized version is not moved.

Choose **Apply** to apply the reviewed result. Turnleaf checks its inputs again first, then writes the merged files. Edits of yours that do not overlap Overleaf's are kept. Incoming comment changes take effect locally only with Apply. **Close preview** leaves everything as it was.

If something changed while the preview was open, it is marked **Preview out of date**; choose **Refresh preview**.

### Unsaved files

If a selected source file, or an open review JSON file of this selection (under `review/threads` or `review/new`), has unsaved changes, Turnleaf asks you to save before previewing (**Save & preview**). Only those files are saved; other files are left alone. The edits of a saved review file become drafts (see [Review files for AI agents and scripts](review-files-for-agents.md)).

### The first sync

The first Get latest sets the shared starting point. There is no earlier version to merge from, so:

- Files that are identical locally and on Overleaf become the starting point. If nothing differs, the button reads **Use this baseline**.
- For each file that differs, choose **Use Overleaf version**, **Keep my version** or **Merge manually**. A kept version is listed as going out once you apply the preview.

### Conflicts

A file marked **Conflict** was changed on both sides in the same place. Choose **Resolve in editor**: an editable merged copy opens with both versions. Edit it and save it; the saved copy is used automatically. Check the diff again, then **Apply**. Closing the preview leaves your source files unchanged.

## The outgoing summary

Under the header, the outgoing summary always shows what the next Send would write:

- **Going out**: each file with its added and removed line counts, each picture, and each queued comment change (replies, edits, deletions, resolutions, new comments and suggestion decisions).
- **From Overleaf, applied to your files first**: shown when collaborators changed other parts of the project since your last sync. These changes are merged into your files before sending, and the button reads **Apply & send**.
- **Waiting**: shown when a queued comment change stops Send. The change that blocks Send comes first, marked **Blocks Send**.

The summary is recomputed from your saved files, your queued comment changes and the last known state of Overleaf whenever one of them changes. This needs no request to Overleaf. The foot of the summary shows when Overleaf was last compared.

Working with the rows:

- Click a file to open a diff from **Overleaf now** to **After send**.
- Click a comment row to unfold it. It offers **Discard**; **Edit** for a draft that has text; **Show in editor** when the place is known; and **Update selection** when a new comment needs one (see [New comments](comments.md#new-comments)). The file and line of a row link to that place in the editor when it is known.
- Rows marked with a warning cannot be brought back by **Undo this send**, for example deleted comments, comments on text you edited, and suggestion decisions. The reason is shown on the row.
- Each list can be folded with the toggle on its head line. A folded list opens again when a row needs a look.
- **Review details** opens the full text report: the files with their added and removed line counts, the pictures, and each comment change with its text before and after. A warning mark on a file row points to an effect on comments or suggestions, such as a comment on text you edited.

Unsaved edits are not in the summary. The summary names the unsaved files and offers **Save all**.

When Track Changes is on in the Overleaf project, your edits to existing files arrive as your suggestions. Pictures are always replaced for everyone, not as suggestions, and so is the initial content of a new file that Send creates: it arrives as plain text.

## Send

Choose **Send** (or **Apply & send**). Turnleaf then:

1. Reads Overleaf and your saved files again.
2. Compares the result with the summary you saw. If anything differs, nothing is sent: the summary shows the fresh state with the differing rows marked **Changed**, so you can look again and send again.
3. Applies incoming Overleaf changes to your files first, if the summary listed any.
4. Writes the file edits and comment changes, then reads them back to verify them.

If the send includes deleted comments or threads, you are asked to confirm first; deletions cannot be undone.

After a verified send the state line reads **Sent and verified on Overleaf.** If Overleaf reports edits made at the same moment, the result is flagged; check the project history on Overleaf.

### When Send is not available

When nothing can be sent, the summary says why and the main button is the way out. See [Send is not available](troubleshooting.md#send-is-not-available) for each reason and what to do.

### Fast or Full check

Choosing **Send** always reads every selected file from Overleaf first, to compare it with the summary you saw. **Check before sending** in the summary chooses how Send checks Overleaf around its writes:

- **Full** (default): reads every selected file again before and after the writes.
- **Fast**: with a live connection, the checks around the writes read again only the files Overleaf reported as edited and the files the send wrote. It is quicker on projects with many files, but relies on Overleaf reporting every edit over the live connection. An edit made after Send's first read that is not reported is not seen before writing, and the check afterwards catches it only in a file this send wrote. Without a live connection, Full is used.

The same choice is the `turnleaf.sendCheck` setting and the **Turnleaf: Set Send Check (Full or Fast)** command.

## Undo this send

Right after a verified send, the header shows **Undo**. Every successful send in Sync history that has not been undone also has **Undo this send**.

Undo opens a summary of what is taken back from Overleaf and what stays as sent, with the reason for each row that stays, for example a deleted message, or a line edited on Overleaf since. **Send undo** works like Send: it reads Overleaf again and sends only when nothing changed since the undo summary was shown.

- Your local files and queued comment changes are not touched. The undone file edits are listed as going out again afterwards. Sent replies and other comment actions are not queued again: draft them again if you still want them.
- A file that this send created on Overleaf is deleted again, if it is unchanged since. Folders it created are kept. Overleaf keeps deleted files restorable in its history.
- Overleaf changes that you have not applied yet must be brought in with Get latest first.

The undo is recorded in Sync history as **Undo of the send from** that time.

## Sync history

**Sync history** in the **Sync** tab (or **Turnleaf: Open Sync History**) opens a local timeline of every Send and Apply. Each record shows its direction, time and outcome (for example success, partial or uncertain), exact before and after copies of text files, the pictures by hash and size, comment changes, the steps that were verified, and any warnings. Open a recorded file to see its diff.

History is kept in `.turnleaf/` in your folder. By default, finished records older than 90 days are removed and at most 50 are kept; records an interrupted sync still needs are always kept. Change this with `turnleaf.historyDays` and `turnleaf.historyLimit`, or run **Turnleaf: Clear Older Sync History** to keep only the 10 most recent records.

History contains copies of your source text and comments, but never your session cookie.

## Recover local apply

Apply writes several files. If it is interrupted, for example because the editor closed, Turnleaf keeps a recovery checkpoint and offers **Recover local apply** (also **Turnleaf: Recover Local Apply**). Recovery restores the selected files to their state before the interrupted Apply. It refuses to overwrite a file you edited since the interruption.

If a Send was interrupted or its outcome is uncertain, Turnleaf asks you to **Get latest** before sending again, so you can see what reached Overleaf. A comment change with an uncertain outcome cannot be sent again. Check Overleaf and Sync history, then **Get latest** and **Apply**. Discard the draft, and draft it again only if the action is still missing.

## Live updates and remote checks

While the window is in the foreground, Turnleaf keeps one live connection to the linked project and notices Overleaf's edits and comments as they happen. They show up as incoming changes; they appear in your editor only after **Get latest** and **Apply**. A check every 60 seconds over the same connection catches anything missed. The connection pauses after 5 minutes with the window in the background, and resumes when you come back.

The **Updates** menu in the **Sync** tab chooses between **Live** and checks **Every 10 s**, **Every 30 s**, **Every 60 s** or **Manually**. Checks only report whether Overleaf changed; they never apply updates, send anything or move the starting point. After failures they wait longer between attempts, and they give way to anything you start yourself. A dot on the **Sync** tab means checks are failing. **Check Remote Now** in the sidebar title bar checks at once.

When you open the window or change the file selection, the state reads **Checking Overleaf…** until the first read finishes. With **Manually**, nothing is read when the window opens; use **Check Remote Now** or **Get latest**.

## Pictures and PDF figures

While `turnleaf.syncPictures` is on (the default), PNG, JPG and PDF files in the Overleaf project take part in syncing. They are compared by content, not by date:

- **Get latest** brings in new and changed pictures. The preview lists each one with its size; click it to compare both versions: a PNG or JPG that exists on both sides opens as a side-by-side diff, a PDF opens in the system viewer, and a picture that exists on one side only opens as its single copy. A picture changed on both sides offers **Use Overleaf version** or **Keep my version**.
- **Send** uploads pictures you changed locally. Local pictures that are not on Overleaf are uploaded when you tick them under **Pictures only in the local folder** in **Choose files**.
- **Undo this send** puts back the previous version, or deletes a picture the send created if it is unchanged since.

Some pictures are listed but not sent:

- Files linked on Overleaf from another project or a URL. Change them there.
- Files over the server's upload limit (50 MiB if the server reports none).
- A picture whose name clashes with a text document or folder on Overleaf.

A picture deleted on Overleaf stays in your folder and is no longer synchronized. A picture deleted locally is restored by the next Get latest; Turnleaf never deletes it on Overleaf.

Turn `turnleaf.syncPictures` off to leave local pictures alone.
