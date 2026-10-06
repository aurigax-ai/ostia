# cmux session fixture

`session-com.cmuxterm.app.json` is the file cmux 0.65.0 saves at
`~/Library/Application Support/cmux/session-com.cmuxterm.app.json`, recorded on a working Mac and
then cleaned up:

- The window and the workspaces Office, Client work, Editor and Research are from the recording.
  User names, project names, folders, titles, UUIDs and agent session ids were replaced, and
  notifications, resume commands, launch environments and display ids were removed.
- The recording had no splits, so these parts were written by hand in the same wire format
  (cmux `SessionWorkspaceLayoutSnapshot`, `SessionPanelSnapshot`): the App workspace (a split with
  tabs, a browser, a Markdown file, an unsupported panel, scrollback and a codex session), the
  group on Research, and the second window with the Ops workspace (canvas mode, a remote
  terminal and a group).
