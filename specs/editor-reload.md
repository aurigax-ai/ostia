# Editor reload

Status: cases approved 2026-09-30 at 0da11c5

Intent: a file open in Pine's text editor follows changes other programs (agents, git, a formatter)
make on disk, without ever losing the human's unsaved edits or silently overwriting a newer file.
It covers the Monaco editor only, not the image or PDF viewers.

## Decisions
- **ERL-D1** Main watches the folder of every file open in an editor with Node's `fs.watch` (OS
  events: inotify, FSEvents), filters for that file's name, debounces about 150 ms, and tells the
  windows showing it that it changed (new content hash, or gone). Only paths inside the folders
  `fs:*` may read are watched, and a folder's watch is dropped when no open file uses it. The
  editor also re-checks its open files when Pine's window regains focus. Why: OS events arrive at
  once without polling; watching the folder survives the write-then-rename saves agents and
  editors use; the focus re-check covers a dropped event. Governs: fs watch IPC, editor change
  detection.
- **ERL-D2** A file with no unsaved edits reloads quietly when it changes on disk, keeping cursor,
  selection and scroll, as one undoable edit. Why: the human wants to see the agent's change, and
  Ctrl+Z still brings back what was there. Governs: clean-buffer reload.
- **ERL-D3** A file with unsaved edits is never changed when the disk changes. A bar says
  "Changed on disk" with Compare (Pine's diff view: the editor's text against the disk's),
  Reload (discard the edits) and Keep mine (hide the bar until the next change). Autosave pauses
  for that file until the human chooses. Why: the human's text must never be lost to an agent's
  write. Governs: dirty-buffer conflict bar, autosave pause.
- **ERL-D4** Saving checks that the disk still holds the version the editor last loaded or saved.
  If not, nothing is written and the bar offers Overwrite, Compare and Cancel. Autosave never
  overwrites; it waits for the human. Why: saving over an agent's newer change would lose it
  silently. Governs: save conflict check.
- **ERL-D5** A file deleted or renamed away on disk keeps its text in the editor, and the bar says
  "Deleted on disk". Saving writes it back to the same path. If the file reappears, it's treated as
  a change (ERL-D2 or ERL-D3). Why: the text may be the only copy left. Governs: deleted-file
  handling.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|
| ERL-C1 | ERL-D1 | expected | Given a file open in the editor, when another program rewrites it by write-then-rename, then the window is told within a second |
| ERL-C2 | ERL-D1 | unexpected | Given a file outside the folders Pine may read, when the editor asks to watch it, then main refuses and watches nothing |
| ERL-C3 | ERL-D1 | unexpected | Given two panes with the same file open, when one closes, then the folder is still watched; when both close, the watch is dropped |
| ERL-C4 | ERL-D1 | unexpected | Given a change that arrived while no event fired, when Pine's window regains focus, then the editor picks up the new content |
| ERL-C5 | ERL-D2 | expected | Given a clean buffer with the cursor on line 40, when an agent changes line 3 on disk, then the editor shows the new text, the cursor stays on line 40, and Ctrl+Z restores the old text |
| ERL-C6 | ERL-D2 | unexpected | Given a clean buffer, when the disk content is rewritten with identical bytes, then nothing changes in the editor and no undo step is added |
| ERL-C7 | ERL-D3 | expected | Given unsaved edits, when the file changes on disk, then the text is untouched and the "Changed on disk" bar shows Compare, Reload and Keep mine |
| ERL-C8 | ERL-D3 | expected | Given the bar, when the human clicks Compare, then a diff pane opens with the editor's text against the disk's; when they click Reload, the disk's text replaces theirs |
| ERL-C9 | ERL-D3 | unexpected | Given autosave after a delay and unsaved edits, when the file changes on disk, then autosave writes nothing until the human chooses |
| ERL-C10 | ERL-D3 | unexpected | Given the human clicked Keep mine, when the disk changes again, then the bar comes back |
| ERL-C11 | ERL-D4 | expected | Given the disk changed after the editor loaded the file, when the human saves, then nothing is written and the bar offers Overwrite, Compare and Cancel; Overwrite then writes the editor's text |
| ERL-C12 | ERL-D4 | unexpected | Given the disk is unchanged since the last load or save, when the human saves, then it writes with no bar |
| ERL-C13 | ERL-D5 | expected | Given a file open with or without edits, when it is deleted on disk, then the text stays and the bar says "Deleted on disk"; saving writes it back |
| ERL-C14 | ERL-D5 | unexpected | Given a deleted file, when it reappears with new content, then it is handled as a change: reloaded if clean, bar if dirty |

## Open
