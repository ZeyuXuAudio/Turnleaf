# Review files for AI agents and scripts

Turnleaf keeps the linked project's comments as plain files in your folder. An AI coding agent, or any script, can read the discussions there and queue replies, resolutions and new comments. What they queue is listed in the outgoing summary like your own drafts, and is published only when you choose **Send**.

The files are on by default. Turn them off or on with the **AI agents and scripts** switch in the **Setup** tab, or the `turnleaf.localReviewFiles` setting. Turning them off imports what was saved there, then removes the folder; queued drafts stay.

To look at them, choose **Local review files** in the **Sync** tab, **Open overview** in **Setup**, or run **Turnleaf: Open Local Review Files**. Choosing **Local review files** also turns the files on when they are off.

## Layout

The files live in the project's state folder:

```text
.turnleaf/projects/<project-key>/review/
├── REVIEW.md                  overview of all discussions (generated)
├── index.json                 source files → thread IDs and JSON paths (generated)
├── thread.schema.json         JSON schema for thread files
├── new-comment.schema.json    JSON schema for new-comment requests
├── threads/
│   └── <thread-id>.json       one file per discussion; only localEdits is editable
├── new/                       drop new-comment requests here
└── import-error.txt           present only while a saved file is refused
```

`<project-key>` is a fixed key for the server, project and file selection. The overview and index are kept up to date for the linked project and file selection.

- **`REVIEW.md`** shows each discussion with its file and line, the quoted source passage, the last accepted and latest fetched messages, incoming changes, and edits waiting to be sent. It also repeats the editing rules below, so an agent can start there.
- **`index.json`** lists the project, the selected files and, for each thread, its JSON file, source file, line, anchor state, whether it is resolved, whether it has incoming changes and how many edits are pending. `bySourceFile` maps each source file to its thread IDs.
- **`threads/<thread-id>.json`** holds one discussion: the last accepted snapshot (`baseline`), the latest fetched snapshot (`remote`), each with its exact source anchor (file, line, document ID, quoted text and UTF-16 ranges), the local anchor of a new comment (`localSelection`), and the editable `localEdits` array. The adjacent schema gives validation and completion in the editor.

Do not edit `REVIEW.md`, `index.json` or any field other than `localEdits`; they are regenerated.

## Reply, edit, resolve and delete

Add entries to `localEdits` in a thread file and save it. For example, a reply:

```json
"localEdits": [
  { "id": "reply-1", "action": "reply", "text": "I have clarified this paragraph." }
]
```

| `action` | Fields | Effect at Send |
| --- | --- | --- |
| `reply` | `text` | Adds a reply to the thread. |
| `editMessage` | `messageId`, `text` | Replaces the text of one of your own messages. `messageId` is the original message's `id`. |
| `deleteMessage` | `messageId` | Deletes one of your own messages. |
| `resolve` | — | Resolves the thread. |
| `reopen` | — | Reopens a resolved thread. |
| `deleteThread` | — | Deletes the whole thread. |

Rules:

- Each `id` must be distinct across the project: 1 to 128 letters, digits, `-` or `_`. Keep an entry's `id` unchanged when you revise its text.
- `text` must be between 1 and 20,000 characters.
- To revise a queued draft, change its `text`. To discard it, remove the entry.
- A thread needs its incoming discussion applied first: if it is new on Overleaf, choose **Get latest** and **Apply** before adding local edits to it.
- `deleteThread` must be the only edit for its thread.
- A new comment's replies, edits and resolutions go with its `createThread` entry: keep them together, or remove all of them.
- Deleting a thread JSON file does not delete the discussion; the file is regenerated.
- Deletions are confirmed again at Send.
- Suggestion decisions are made in the editor, not in these files.

Saving a thread file updates the queued drafts and the sidebar. Unsaved JSON buffers are named in the outgoing summary, and Send waits until they are saved. At Send, Turnleaf imports the files again and checks for further edits before writing.

## Start a new comment

Save a JSON file in `review/new/`, for example `review/new/comment-1.json`:

```json
{
  "id": "comment-1",
  "path": "main.tex",
  "quote": "exact saved source text",
  "text": "Please justify this."
}
```

- `path` is a selected source file that is already on Overleaf.
- A request file over 100,000 bytes is refused.
- `quote` must match the saved file exactly, line breaks included.
- If `quote` occurs more than once, add `line` (the line it starts on) or `occurrence` (1-based), not both, or quote a longer passage.
- The schema is `review/new-comment.schema.json`.

Once the request is queued, the file is removed from `new/`, and the thread appears in `index.json`, `REVIEW.md` and its own thread file with a `createThread` entry. Its text and replies can then be edited there. **New Comment on Selection** in the editor does the same from a selection.

A new comment follows its text when the file is saved with other edits. If the commented text itself changed, save a request with the same `id` again to move the comment. This also works for comments made with **New Comment on Selection**, using the `id` of their `createThread` entry. A reused `id` must belong to a queued new comment in the same source file; any other reuse is refused.

## Errors

A file that cannot be imported is kept as it is and blocks Send until it is corrected. The reason is written to `review/import-error.txt`, which is removed after the next successful import. Typical reasons:

- Invalid JSON, or a field other than `localEdits` was changed.
- An `id` is used twice, or an entry changed its `action` or `messageId`.
- A `quote` was not found, or occurs more than once without `line` or `occurrence`.
- A thread was edited before its incoming discussion was applied, `deleteThread` is not the only edit for its thread, or a new thread's replies have no `createThread`.
- A request file is over 100,000 bytes, or an `id` is reused for something other than a queued new comment in the same source file.
- The same draft was changed in the sidebar while the file was being edited. Keep your new text, undo the JSON edit, reopen **Local review files**, and apply the text to the updated record.

Turnleaf never overwrites an unsaved JSON buffer when it refreshes the files.

## Tips for agents

- Read `REVIEW.md` first; follow its links to the thread files.
- Use `index.json` and `bySourceFile` to find the threads for a file, then open the source at `remote.anchor` or `baseline.anchor`.
- Make the requested change in the source file, then add a `reply` (and, if appropriate, `resolve`) to the thread's `localEdits`.
- Leave sending to the person: the edits wait in the outgoing summary until they choose **Send**.
