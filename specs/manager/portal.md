# Manager: portal

Status: decisions in progress

## Decisions
- **MGR-D7** Agent presets live in `manager.agents` in settings.json, which maps a name to an argv; claude and codex are built in. Only Settings → Manager edits it, and it is not in `DATA_KEYS`. `pine <name> [args…]` appends the extra args as argv data, quoted by `shared/shellQuote.ts`, and they are typed only at the manager pane's first idle prompt. An unknown name exits non-zero and lists the presets. Why: argv, never a shell string, and only the human changes it. Governs: `manager.agents`, `pine <name>`, the settings store.
- **MGR-D8** `pine <agent>` attaches if the manager already runs that agent, and fails with the running agent's name if it runs another. Ctrl+\\ detaches and leaves the manager running. Why: one manager (MGR-D2). Governs: portal.open, the mirror's detach key.
- **MGR-D9** Linux only. On macOS and Windows the portal socket is not opened and Settings → Manager is not shown. Why: the caller check needs /proc. Governs: portal startup, the Settings → Manager section.
- **MGR-D14** The portal accepts one connection at a time and identifies the caller's pid with `ss -xpn` (execFile, `shell: false`), matching the peer inode of the accepted socket. It refuses when Pine's main process is an ancestor of that pid (which covers every pane shell, extension and background process), when `/proc/<pid>/environ` holds `PINE_TOKEN`, or when the caller's controlling tty is a Pine pty. If `ss` is missing or the pid can't be resolved, it refuses. A process that double-forks and calls `setsid` escapes all three checks; that gap is recorded in CLAUDE.md §8. Why: Node can't read SO_PEERCRED, and no approval prompt backs this check (MGR-D3). Governs: portal.open, caller check, CLAUDE.md §8.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|

## Open
