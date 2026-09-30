# Manager: identity

Status: cases approved 2026-09-30 at d973b5a (the user said to finish everything on the branch)

## Decisions
- **MGR-D10** Manager skills: Settings → Manager holds a list of skill folders the human picks. Pine builds the manager's plugin dir from the manager skill plus those folders; for Codex it writes a context file that lists them. Worker panes never get the manager skill, and the manager never gets the worker `pine` skill. Why: the manager learns only what the human chose. Governs: the manager plugin dir, the Codex context file, `manager.skills`.
- **MGR-D11** Limits, set only in Settings → Manager: at most 8 live workers, 20 spawns per 10 minutes, and 60 bus messages per minute from the manager. Hitting a limit returns an error and does nothing. A manager can never spawn or open a manager. Why: the bus has no threads, so rate limits are what stop runaway loops. Governs: manager.spawn, bus.send from the manager, `manager.limits`.
- **MGR-D15** The manager holds every capability except `phone`, `gateway` and the human-only settings keys, and acts across all workspaces. It can list, read, open, close, focus and rename workspaces and panes, spawn workers, and message agents on the bus. `destructive` still asks: the approval card brings the Pine window up from the tray. Why: managing other sessions is the manager's job, but grants and irreversible actions stay with the human. Governs: manager caps, `ensureCaps` for the manager identity, approval window placement.
- **MGR-D16** Typing into other panes is a separate switch, `manager.allowInput`, off by default and set only in Settings → Manager. When it is on, the manager may send text and keys (Enter, y/n, arrows, Ctrl+C) to any pane except its own, whether or not the pane is at an idle prompt, for example to approve a worker's permission request. When it is off, those calls fail with an error naming the setting. CLAUDE.md §4 "Nothing types into a pane" gets this as its one extra exception. Why: convenient, but it turns the manager's reading into typing, so the human opts in. Governs: `manager.input`, the §4 typing invariant, `manager.allowInput`.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|
| MGR-C28 | MGR-D10 | expected | Given skill folders picked in Settings → Manager, when the manager starts, then claude's plugin holds the manager skill, those skills and the resume and state hooks, codex's context names them, and the worker plugin never holds the manager skill |
| MGR-C36 | MGR-D10 | unexpected | Given a picked folder without SKILL.md, a missing folder, or one whose name clashes, when the manager starts, then it is skipped and the rest still load |
| MGR-C29 | MGR-D11, MGR-D15 | expected | Given the manager, when it runs `pine manager spawn <preset> --name N -- args`, then a new workspace N opens with a terminal running the preset plus args, and it gets the worker's pane id |
| MGR-C37 | MGR-D11 | unexpected | Given the live-worker, spawn-rate or bus-rate limit reached, or an unknown preset or relative cwd, when the manager spawns or sends, then it fails with `limit:` (or the bad field) and nothing opens or is sent |
| MGR-C31 | MGR-D15 | unexpected | Given an ordinary pane, when it calls any `manager.*` method or reads `pine docs`, then it gets `not-available-to-pane` and the docs never mention the manager; the manager reads another pane's screen but never its own |
| MGR-C32 | MGR-D15 | expected | Given Pine hidden in the tray, when an approval card waits for the human (a manager's `destructive` request), then the window comes forward; an auto-approved request does not bring it |
| MGR-C30 | MGR-D16 | unexpected | Given `manager.allowInput` off, when the manager calls `manager.input`, then it fails `input-off` naming the setting and nothing is typed |
| MGR-C35 | MGR-D16 | expected | Given `manager.allowInput` on, when the manager sends text and named keys to a worker, then the worker gets them even while its program runs; its own pane and unknown keys are refused |

## Open
