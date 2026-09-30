# Manager: mirror

Status: decisions in progress

## Decisions
- **MGR-D12** The manager lives until its agent exits or Pine quits: it is exempt from the detach reaper when no mirror is attached. It is never restored as a workspace. After a restart, `pine <agent>` starts a new manager and types the agent's `resumeCommand` if a resume token was saved. Why: nothing live is restored, but the conversation can resume. Governs: manager pty lifetime, `DETACH_GRACE_MS` reaping, restore.
- **MGR-D13** Inside Pine the manager pane shows no input editor, Resume button, rerun or insert. The human may close it, which asks first and then ends the manager. Pine draws it at the mirror's size and clips or scrolls when the pane is smaller. Why: view-only (MGR-D4). Governs: manager pane UI, `insertCommand` targets, pty size.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|

## Open
