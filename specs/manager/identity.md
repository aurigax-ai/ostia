# Manager: identity

Status: decisions in progress

## Decisions
- **MGR-D10** Manager skills: Settings → Manager holds a list of skill folders the human picks. Pine builds the manager's plugin dir from the manager skill plus those folders; for Codex it writes a context file that lists them. Worker panes never get the manager skill, and the manager never gets the worker `pine` skill. Why: the manager learns only what the human chose. Governs: the manager plugin dir, the Codex context file, `manager.skills`.
- **MGR-D11** Limits, set only in Settings → Manager: at most 8 live workers, 20 spawns per 10 minutes, and 60 bus messages per minute from the manager. Hitting a limit returns an error and does nothing. A manager can never spawn or open a manager. Why: the bus has no threads, so rate limits are what stop runaway loops. Governs: manager.spawn, bus.send from the manager, `manager.limits`.
- **MGR-D15** The manager holds every capability except `phone`, `gateway` and the human-only settings keys, and acts across all workspaces. It can list, read, open, close, focus and rename workspaces and panes, spawn workers, and message agents on the bus. `destructive` still asks: the approval card brings the Pine window up from the tray. Why: managing other sessions is the manager's job, but grants and irreversible actions stay with the human. Governs: manager caps, `ensureCaps` for the manager identity, approval window placement.
- **MGR-D16** Typing into other panes is a separate switch, `manager.allowInput`, off by default and set only in Settings → Manager. When it is on, the manager may send text and keys (Enter, y/n, arrows, Ctrl+C) to any pane except its own, whether or not the pane is at an idle prompt, for example to approve a worker's permission request. When it is off, those calls fail with an error naming the setting. CLAUDE.md §4 "Nothing types into a pane" gets this as its one extra exception. Why: convenient, but it turns the manager's reading into typing, so the human opts in. Governs: `manager.input`, the §4 typing invariant, `manager.allowInput`.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|

## Open
