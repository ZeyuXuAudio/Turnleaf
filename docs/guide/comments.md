# Comments and suggestions

Turnleaf shows the comments and suggestions of the linked Overleaf project in the editor and in the sidebar. Everything you do with them (replies, edits, resolutions, deletions, new comments, accepting and rejecting suggestions) is saved locally as a draft and listed in the outgoing summary. Nothing reaches Overleaf until you choose **Send**. Drafts work while sending is off, and they survive restarts.

## The Review tab

The **Review** tab in the sidebar lists comments and suggestions as cards, grouped by file and sorted by line. The bar at the top shows how many comments are open and how many suggestions there are.

- **Current file** / **All files** chooses whether the list follows the source file you are editing (including split editors) or shows every selected file.
- **Highlights** turns inline editor highlights for the selected review items (commented text, suggested insertions and struck-through suggested deletions) on or off. The choice is kept for the workspace.
- The chips **Open**, **Resolved**, **Suggestions** and **Going out** choose what both the list and the editor show, each with its count. **Going out** means threads and suggestions with a change waiting for Send. An item shows when any of its kinds is on. **Resolved** starts off; the choice is kept for the workspace.
- **Comment** starts a new comment on the text selected in the editor (see [New comments](#new-comments)).

Each comment card shows the author, the date, the line (for example **L42**) and a button to resolve or reopen the thread. Badges appear only for exceptions: **Pending send**, **Resolved**, a comment whose text was deleted, or a local status such as addressed or declined. A comment whose text was deleted on Overleaf shows **near L42** and the text it was on; the thread is kept, and you can reply, resolve or delete it as usual.

The sidebar cuts a long first message to three lines; click **Show more** under it to read it in full, and **Show less** to cut it again. Under the first message, a card with replies shows the newest reply: its author, its date and the first two lines of its text. Click the reply count (for example **2 replies**) to unfold every reply in full inside the card, oldest first, together with the whole first message; click it again to fold them. Each card keeps these choices when the list refreshes.

Click a card to select it and open its thread in the editor. The selected card has a reply box (**⌘Enter** / **Ctrl+Enter** saves the reply) and, for your own first message, edit and delete buttons.

**Open Larger View** in the sidebar title bar opens the same overview beside the editor, in two columns: the list on the left, and the selected thread with its commented text, the surrounding lines and all messages on the right.

**Turnleaf: Filter Threads by Author** limits the comments to one author.

## Markers and highlights in the editor

Each comment matching the active chips (**Open**, **Resolved**, **Going out**) has a marker in the gutter, with distinct markers for open, resolved and new comments. Click a marker to open the thread; click it again to close it. Commented text is highlighted with a light background and underline while **Highlights** is on; opening a hidden thread from **Show in editor** still reveals it in the editor. Highlights and markers follow your typing; nothing is sent to Overleaf while you type.

Hover over commented text to see the first message, the date and the number of replies, with **Open thread**, **Reply** and **Resolve on send** (or **Reopen on send**) links.

### Where markers go with word wrap on

Cursor draws a gutter marker on every wrapped row of its line, which crowds long paragraphs. So with word wrap on, Turnleaf by default puts markers **below the paragraph**:

- The marker goes on the blank line under the commented line.
- Without a blank line there, and with **Highlights** on, there is no marker. The highlighted text shows the comment, and **Open thread** in its hover (or the sidebar) opens it; the marker then stays until another comment is opened.
- With **Highlights** off, the marker still goes on the blank line under the commented line when there is one; otherwise it stays on the commented line, as it does for a comment whose text was deleted.

Choose **On the commented line** in **Setup → Project setup → Comment appearance** to keep every marker on its line. The same choice is the `turnleaf.commentMarkers` setting. With word wrap off, markers are always on the commented line.

### Outline markers

Linked workspaces start with clear outline comment markers and a transparent gutter. They come from the "Turnleaf outline comments" product icon theme, which changes only the comment icons; other icons use the editor's defaults.

**Restore editor markers** in **Comment appearance** brings back your previous appearance and keeps that choice. **Use outline comment markers** turns them on again, and also repairs markers that look like solid blocks.

## Working with threads

Threads open as native comment threads in the editor. Their header has **Resolve Thread on Send** or **Reopen Thread on Send**, and **More Actions** with the local status commands, **Open Project on Overleaf** and **Delete Thread on Send**.

| Action | Where |
| --- | --- |
| Reply | The reply box in the thread, the selected card in the sidebar, or **Reply** in the hover |
| Edit or delete your own message | The pencil and trash buttons on your message in the thread, the card or the larger view |
| Resolve or reopen | The thread header, the card, or the hover |
| Delete a thread | **More Actions → Delete Thread on Send**, where the server permits it |

You can edit and delete only your own messages. Edits to a message that is still a draft change the draft. Deletions of messages and threads are confirmed again at Send, because they remove content from Overleaf for everyone and cannot be undone.

Each change appears in the outgoing summary, where you can unfold it, edit its text or **Discard** it. Edit drafts and open threads survive a refresh.

## Suggestions

Overleaf's suggestions (tracked changes) are shown in the text while **Highlights** and **Suggestions** (or **Going out** for decided suggestions) are on: suggested insertions are part of the text and highlighted, and suggested deletions are shown struck through. The text Turnleaf fetches includes suggested insertions and leaves out suggested deletions, even when their highlights are hidden.

To decide a suggestion:

- Click **Accept on send** or **Reject on send** at the top right of its card, or the **Accept** / **Reject** links in its hover.
- Click the same button again to undo the decision; the other button replaces it.
- With two or more suggestions in a file, **Accept all** and **Reject all** decide them all at once. From the Command Palette, **Turnleaf: Accept All Suggestions in File on Send** and **Turnleaf: Reject All Suggestions in File on Send** do the same for the file you are editing.

To decide several suggestions at once:

- **In a selection.** Select text and choose **Turnleaf: Accept Suggestions in Selection on Send** or **Turnleaf: Reject Suggestions in Selection on Send** from the editor's context menu or the Command Palette. As in Overleaf's review panel, this decides every suggested insertion that overlaps the selection and every suggested deletion inside it, including one at either edge of the selection. With several selections, it decides the suggestions of all of them.
- **By author.** When a file has suggestions from two or more authors, **By author…** next to **Accept all** lists each author with their number of suggestions, to accept or reject all of theirs in that file. **Turnleaf: Accept Suggestions by Author in File on Send** and **Turnleaf: Reject Suggestions by Author in File on Send** do the same from the Command Palette for the file you are editing. Two accounts with the same name are listed separately.

Choosing the same decision again for the same suggestions undoes it, as with **Accept all**; when only some of them have it, the rest get it too.

A decision is a draft until Send, like any comment change. At Send, decisions are applied first, as Overleaf's review panel does, and then your file edits are sent against the result. Rejecting also updates your local file: the text of a rejected insertion is removed, and the text of a rejected deletion comes back. If a suggestion was decided or changed on Overleaf meanwhile, Send stops and names the file and line; discard the decision and look again.

## New comments

To start a new thread:

1. Select text in a selected source file that is already on Overleaf.
2. Choose **Turnleaf: New Comment on Selection** from the editor's context menu, or **Comment** in the Review tab.
3. Enter the comment. The file is saved first if needed.

The new thread appears in the editor and in the outgoing summary, and is created on Overleaf at Send. You can reply to it and edit it before sending.

A new comment is tied to the selected text in the saved file. When you save the file with other edits, the comment follows its text. If the selected text itself was edited, or it moved and is no longer unique, the comment's row in the outgoing summary says **Needs a new selection**. Select the text again, then choose **Update selection** on that row (or run **Turnleaf: Update Pending Comment Selection**). The draft and its replies are kept.

## Local addressed and declined status

Besides Overleaf's open and resolved state, each thread has a local status that is never sent:

- **Mark Addressed Locally** records that you dealt with the comment.
- **Mark Declined Locally** asks for a reason and records it.
- **Reopen Locally** returns the thread to open.

Find them under **More Actions** in the thread header. The status appears as a badge on the card, in the review log and in the annotated PDF.

## Export a review log

**Turnleaf: Export Review Log** writes a Markdown report of all threads in the selected files, with their state, local status and messages, to `docs/overleaf_review_log.md`. Change the path with `turnleaf.reviewLogPath`. The export overwrites that file each time, and refuses to write over a selected source file.

For a file-based interface that you or an AI agent can also edit, see [Review files for AI agents and scripts](review-files-for-agents.md).
