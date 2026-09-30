# Manager: mirror

Status: cases approved 2026-09-30 at 81e6c2b (the user said to start building)

## Decisions
- **MGR-D12** The manager lives until its agent exits or Pine quits: it is exempt from the detach reaper when no mirror is attached. It is never restored as a workspace. After a restart, `pine <agent>` starts a new manager and types the agent's `resumeCommand` if a resume token was saved. Why: nothing live is restored, but the conversation can resume. Governs: manager pty lifetime, `DETACH_GRACE_MS` reaping, restore.
- **MGR-D13** Inside Pine the manager pane shows no input editor, Resume button, rerun or insert. The human may close it, which asks first and then ends the manager. Pine draws it at the mirror's size and clips or scrolls when the pane is smaller. Why: view-only (MGR-D4). Governs: manager pane UI, closing the manager pane, Pine's view size. Unexpected: n/a — an ended manager's workspace closes with the same ask, and nothing else reaches the pane (MGR-C20).

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|
| MGR-C33 | MGR-D12 | expected | Given Pine quit while the claude manager ran with a saved resume token, when `pine claude` runs after the restart, then the manager starts with `--resume <id>`; after the agent exits on its own, or for another preset, extra args or a malformed token, it starts fresh |
| MGR-C20 | MGR-D4, MGR-D13 | expected | Given the manager open in Pine, when the human types in its pane, then nothing reaches the agent, Pine never resizes its pty, and the pane says it is read-only |
| MGR-C21 | MGR-D8, MGR-D13 | expected | Given a mirror attached, when the human types and resizes the outside terminal, then the agent gets the keys and the size, and Pine's view follows the size |
| MGR-C22 | MGR-D8, MGR-D12 | expected | Given a mirror attached, when Ctrl+\\ is pressed, then the CLI exits 0, the manager keeps running, and the next `pine <agent>` reattaches with its screen replayed |
| MGR-C23 | MGR-D12 | expected | Given a mirror attached, when the agent exits with code 7, then the CLI exits 7, Pine's view says the manager ended, and the next `pine <agent>` starts a new manager in a fresh workspace |
| MGR-C24 | MGR-D12 | unexpected | Given a mirror attached, when its terminal disappears without detaching, then the manager is not reaped |
| MGR-C25 | MGR-D12 | expected | Given a manager workspace, when Pine saves workspaces, then the manager workspace is left out |
| MGR-C26 | MGR-D13 | expected | Given the manager workspace, when the human closes it in Pine, then Pine asks first, and only on confirm ends the agent |

## Open
