# Manager: portal

Status: cases approved 2026-09-30 at 81e6c2b (the user said to start building)

## Decisions
- **MGR-D7** Agent presets live in `manager.agents` in settings.json, which maps a name to an argv; claude and codex are built in. Only Settings → Manager edits it, and it is not in `DATA_KEYS`. `pine <name> [args…]` appends the extra args as argv data, quoted by `shared/shellQuote.ts`, and they are typed only at the manager pane's first idle prompt. An unknown name exits non-zero and lists the presets. Why: argv, never a shell string, and only the human changes it. Governs: `manager.agents`, `pine <name>`, the settings store.
- **MGR-D8** `pine <agent>` attaches if the manager already runs that agent, and fails with the running agent's name if it runs another. Ctrl+\\ detaches and leaves the manager running. Why: one manager (MGR-D2). Governs: same or different agent on open, the mirror's detach key.
- **MGR-D9** Linux only. On macOS and Windows the portal socket is not opened and Settings → Manager is not shown. Why: the caller check needs /proc. Governs: portal startup, the Settings → Manager section.
- **MGR-D14** The portal accepts one connection at a time and identifies the caller's pid with `ss -xpn` (execFile, `shell: false`), matching the peer inode of the accepted socket. It refuses when Pine's main process is an ancestor of that pid (which covers every pane shell, extension and background process), when `/proc/<pid>/environ` holds `PINE_TOKEN`, or when the caller's controlling tty is a Pine pty. If `ss` is missing or the pid can't be resolved, it refuses. A process that double-forks and calls `setsid` escapes all three checks; that gap is recorded in CLAUDE.md §8. Why: Node can't read SO_PEERCRED, and no approval prompt backs this check (MGR-D3). Governs: portal.open, caller check, CLAUDE.md §8.
- **MGR-D17** Presets are as in MGR-D7, but main starts the preset's argv plus the extra args directly as the manager pane's process: no shell, nothing typed, the caller's cwd and PATH. The Settings → Manager editor is not built yet; `manager` is edited by hand in settings.json, carried through every settings save, and refused by `pine settings set`. Why: spawning the argv is simpler and safer than typing it at a prompt, and the caller's PATH finds the agent the way their terminal does. Governs: `manager.agents`, manager spawn, settings store. Supersedes: MGR-D7.
- **MGR-D18** The portal serves any number of connections but at most one attached mirror; `portal.open` checks the caller with `ss -xpnH` as in MGR-D14, and a second `portal.open` while a mirror is attached fails with `mirror-attached`. Why: the check is per request, and one mirror is what keeps one input source. Governs: caller check, mirror slot. Supersedes: MGR-D14.
- **MGR-D19** The portal socket is `$XDG_RUNTIME_DIR/pine-portal.sock` (`pine-dev-portal.sock` for an unpackaged build), mode 0600; `PINE_PORTAL_SOCKET` overrides it for Pine and the CLI. The first live Pine owns it; a later one leaves it alone. `pnpm install:local` writes `~/.local/bin/pine`, which sets `PINE_APP_BIN` so the CLI can start Pine with `--hidden`. Outside Pine without a terminal on stdin and stdout, the CLI prints the old "not inside a Pine pane" error. Why: a fixed path is the pointer to the running Pine, and scripts and agents outside a terminal learn nothing about the manager. Governs: portal socket path, the installed launcher, CLI outside Pine.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|
| MGR-C7 | MGR-D1, MGR-D19 | expected | Given Pine is not running, when `pine claude` runs in an outside terminal, then the CLI starts Pine with `--hidden` once and connects when the portal comes up |
| MGR-C8 | MGR-D1, MGR-D19 | unexpected | Given Pine does not come up within the timeout, or the CLI doesn't know where Pine is installed, when `pine claude` runs, then it exits 1 with a message and launches at most once |
| MGR-C9 | MGR-D8, MGR-D2 | expected | Given a manager running claude, when `pine claude` runs again, then it attaches to the same pane and no second manager workspace appears |
| MGR-C10 | MGR-D8 | unexpected | Given a manager running claude, when `pine codex` runs, then it fails naming claude |
| MGR-C11 | MGR-D18, MGR-D3 | unexpected | Given a caller whose ancestor is Pine's main process (a pane shell with PINE_SOCKET unset), when it calls `portal.open`, then it is refused with `inside-pine` and nothing opens |
| MGR-C12 | MGR-D18 | unexpected | Given a reparented caller whose environment still holds PINE_TOKEN, when it calls `portal.open`, then it is refused |
| MGR-C13 | MGR-D18 | unexpected | Given a reparented caller whose controlling tty is a Pine pty, when it calls `portal.open`, then it is refused |
| MGR-C14 | MGR-D18 | unexpected | Given `ss` missing or the caller's pid unreadable, when it calls `portal.open`, then it is refused with `unknown-caller` |
| MGR-C15 | MGR-D18, MGR-D4 | unexpected | Given a mirror attached, when a second terminal calls `portal.open`, then it fails with `mirror-attached`; after the first detaches, a new one attaches |
| MGR-C16 | MGR-D17 | unexpected | Given an unknown agent name, a malformed preset in settings.json, or `pine settings set manager…`, then the unknown name fails listing the presets, the malformed preset is ignored, and the set is refused; a hand-edited `manager` section survives other settings saves |
| MGR-C17 | MGR-D17 | expected | Given `pine aider --model '$(rm -rf ~)'`, then the manager runs argv `aider --yes --model $(rm -rf ~)` with the last argument passed literally |
| MGR-C18 | MGR-D9 | unexpected | Given macOS or Windows, then the portal is not started |
| MGR-C27 | MGR-D2 | unexpected | Given two `portal.open` calls at once, then one manager starts and both get the same pane |

## Open
- The Settings → Manager editor for `manager.agents` (MGR-D7) is not built; the section is hand-edited.
