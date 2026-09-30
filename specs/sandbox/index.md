# Sandboxed agent workspaces

Status: cases approved 2026-09-30 at 8457e4a

Intent: a human can mark a workspace as sandboxed, and then everything that runs in it (pane
shells, agent CLIs, `pine process`) is confined by the OS to the workspace folder and a
firewalled network, on Linux (bubblewrap) and macOS (Seatbelt), through
`@anthropic-ai/sandbox-runtime`. It is not a VM, has no snapshots or overlays, and does not
support Windows.

Segments:
- [Filesystem](filesystem.md)
- [Network and ports](network.md)
- [Pine control plane](control.md)
- [Secrets](secrets.md)
- [Packages](packages.md)

## Decisions
- **SBX-D1** The unit is the workspace. When a workspace is sandboxed, every pane shell it
  spawns through `pty:attach` (including panes opened by `ext.openTerminal`) and every
  `pine process` started for it are wrapped by srt. Why: `workDir` is already the workspace's
  anchor, and a per-pane or per-command mix is easy to get around. Governs: which spawns are wrapped
  (pane shells, ext.openTerminal panes, pine process start and restart).
- **SBX-D2** Sandboxing is off by default. Only the human turns it on or off: the switch in
  New workspace, the workspace menu, and the workspace's Sandbox view, all over `sandbox:*` IPC.
  No socket method, CLI verb or `settings.set` path changes it. A change applies to shells
  spawned afterwards; a running pane whose mode differs from the workspace shows a
  "Restart to apply" badge that restarts its shell when clicked. Why: an agent must not be able
  to lift its own fence, and srt fixes the filesystem rules when it wraps a process.
  Governs: sandbox.enabled, sandbox IPC, pane header badge.
- **SBX-D3** It fails closed. If srt can't initialize (bwrap, socat or rg missing, or user
  namespaces restricted), a sandboxed pane shows the error, names the missing packages with a
  `pine system install` hint, and spawns no shell; `pine process start` in that workspace
  fails with the same message. Nothing ever falls back to an unsandboxed spawn. Why: a silent
  fallback looks the same as working and isn't. Governs: srt initialization failure handling.
- **SBX-D4** Main owns sandbox policy in its own store, `sandbox.json` in the data dir, keyed by
  workspace id: `{enabled, allowRead[], domains[], controls}`. Only `sandbox:*` IPC handlers write
  it; the renderer reads it over IPC. The global lists live in `settings.json` under
  `sandbox` (`allowRead`, `allowedDomains`), which is not in `DATA_KEYS` and is local-only
  (never synced). "Until restart" domain grants and exposed ports live in memory only.
  Closing a workspace deletes its entry. `pty:attach` carries the pane's `workspaceId`, and main
  checks it against the pane's registered workspace instead of relying on event order. Why: it's
  a grant, and grants live in main like capabilities do. Governs: sandbox.json,
  settings.json#sandbox, PtySpawnOptions.workspaceId, SYNCED_FILES.
- **SBX-D5** Every setting is editable in the UI: Settings → Sandbox edits the global lists,
  and each workspace's Sandbox view (from the workspace menu) shows and edits its enabled switch,
  extra read paths, domains, control switches, exposed ports and blocked attempts. Nothing needs
  a hand-edited JSON file. Why: the human asked for every setting to be in the UI.
  Governs: Settings → Sandbox page, Sandbox view entry point.
  Unexpected: n/a — a pure UI surface; its bad-input cases are the list decisions' cases.
- **SBX-D6** Every sandbox request is an approval card in the requesting pane's window, and none
  is silent. Sandbox requests always ask, even in `approvals.mode: 'allow'`, and a card that times
  out counts as a deny. `ApprovalRequest` gains a `kind` (`capability` | `sandbox-domain` |
  `sandbox-port`) with a payload. A lasting answer to a sandbox kind writes to the sandbox store,
  never to `capabilityStore`. Why: the human asked for prompts, not silent grants, and the
  existing card, queue and timeout are reused. Governs: ApprovalRequest, approvals.autoApproves,
  approvals session grant.
- **SBX-D19** The wrap rule from SBX-D1 holds with one exception: the host pane that the system
  install flow opens (SBX-D30) is not wrapped. Every other pane shell in a sandboxed workspace
  (including `ext.openTerminal` panes) and every `pine process` start and restart is wrapped.
  Why: installing system packages needs sudo on the host, and the human watches that pane.
  Governs: which spawns are wrapped (pane shells, ext.openTerminal panes, pine process start and
  restart). Supersedes: SBX-D1.
- **SBX-D20** Per-workspace configuration is a page in Settings. The workspace's right-click menu
  gains "Workspace settings…", which opens Settings on Workspaces › <name> (a deep link through
  uiStore). The page has the tabs General, Files, Network, Ports, Secrets, Packages and Pine access.
  Settings › Sandbox holds the global defaults. Every setting is editable there, and nothing needs
  a hand-edited file. Why: Settings already has the navigation, room and search, and one place
  beats a second editor. Governs: Settings → Sandbox page, Sandbox view entry point.
  Supersedes: SBX-D5.
  Unexpected: n/a — a pure UI surface; its bad-input cases are the list decisions' cases.
- **SBX-D21** Global defaults in Settings › Sandbox apply to every sandboxed workspace. Lists
  (read paths, domains, package deny list) add up: global plus workspace. Single values (ports
  policy, package cooldown and malware switch, allow-only package list, control switches) are
  inherited unless the workspace overrides them. The workspace page marks each value inherited or
  overridden and can reset an override. Why: the human wants per-workspace control without setting
  every workspace up by hand. Governs: policy resolution.
- **SBX-D33** Pine has a core system-requirements checker (`main/systemRequirements.ts`): a feature
  registers the programs it needs per platform, each with its package name, and main answers
  which are missing (`system:requirements`). The sandbox registers bubblewrap, socat and ripgrep
  on Linux and ripgrep on macOS. Turning a workspace's sandbox on checks them first, in main: if
  any is missing, the switch is refused, it stays off, and the UI shows a notice naming the missing
  packages with an Install button. Why: the human asked that a feature can't be turned on without
  what it needs, and that the reason is shown instead of a later failure. Governs: sandbox enable
  guard, system requirements registry.
- **SBX-D34** The notice's Install button (and the same action on the desktop notification that a
  failed sandboxed spawn raises, SBX-D3) runs the system extension's install flow for exactly the
  missing packages, as the human's act: its confirm card shows the command, and a terminal opens
  where the human types sudo. If the system extension isn't enabled, the notice shows the command
  to copy instead. Why: installing stays the human's visible act, through the flow Pine already
  has. Governs: requirement install action, sandbox spawn failure notification.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|
| SBX-C1 | SBX-D19 | expected | Given a sandboxed workspace, when a pane opens, then its shell runs under srt and `cat ~/.ssh/id_ed25519` fails with permission denied |
| SBX-C2 | SBX-D19 | expected | Given a sandboxed workspace, when an agent runs `pine process start "curl example.com"`, then the process runs under srt and the connection is refused |
| SBX-C3 | SBX-D19 | expected | Given an extension calls `ext.openTerminal` into a sandboxed workspace, when the pane spawns, then its shell runs under srt |
| SBX-C4 | SBX-D19 | unexpected | Given a sandboxed workspace, when a `pine process` entry is restarted, then the restarted process is wrapped too |
| SBX-C5 | SBX-D2 | expected | Given a new workspace with the sandbox switch off, when a pane opens, then its shell is not wrapped |
| SBX-C6 | SBX-D2 | expected | Given a workspace with running panes, when the human turns the sandbox on, then each running pane shows "Restart to apply", and clicking it restarts that pane's shell under srt |
| SBX-C7 | SBX-D2 | unexpected | Given an agent in any pane, when it calls `pine settings set sandbox.enabled false` or any socket method naming the sandbox, then it is refused and the store is unchanged |
| SBX-C8 | SBX-D2 | unexpected | Given two windows, when a `sandbox:set-enabled` IPC arrives from a window that doesn't show the workspace, then it is refused |
| SBX-C9 | SBX-D3 | expected | Given bwrap is missing on Linux, when a pane opens in a sandboxed workspace, then no shell is spawned and the pane shows the error naming `bubblewrap` with a `pine system install` hint |
| SBX-C10 | SBX-D3 | unexpected | Given srt initialization fails, when `pine process start` runs in a sandboxed workspace, then it exits non-zero with the error and nothing is spawned |
| SBX-C11 | SBX-D3 | unexpected | Given srt failed once and the missing package is then installed, when the human reopens the pane, then the shell spawns sandboxed |
| SBX-C12 | SBX-D4 | expected | Given a sandboxed workspace with approved domains, when the app restarts and restores it, then it is still sandboxed with the same domains, and no "until restart" grant or exposed port survives |
| SBX-C13 | SBX-D4 | unexpected | Given `pty:attach` names a workspace id that isn't the pane's registered workspace, when main spawns, then it refuses and spawns nothing |
| SBX-C14 | SBX-D4 | unexpected | Given `pty:attach` arrives before the renderer's `pane-created` event, when the pane's workspace is sandboxed, then the shell still spawns sandboxed |
| SBX-C15 | SBX-D4 | unexpected | Given `sandbox.json` is missing or corrupt at startup, when a workspace restores, then it is treated as not sandboxed only if no entry exists, and a corrupt file is reported and spawns in affected workspaces fail closed |
| SBX-C16 | SBX-D4 | unexpected | Given settings sync is on, when settings sync writes the folder, then `sandbox` is absent from the synced settings.json |
| SBX-C17 | SBX-D4 | unexpected | Given a sandboxed workspace, when the human closes it, then its `sandbox.json` entry is removed |
| SBX-C57 | SBX-D20 | expected | Given a sandboxed workspace, when the human opens Settings → Sandbox and "Workspace settings…" from the workspace menu, then Settings opens on that workspace's page, and every global list, read path, domain, port, secret grant, package rule and control switch is shown and editable there |
| SBX-C59 | SBX-D21 | expected | Given the global cooldown is 2 days and a workspace overrides it to 0, when that workspace downloads a package published an hour ago, then it succeeds, other sandboxed workspaces are blocked, and the page shows the override with a Reset |
| SBX-C60 | SBX-D21 | expected | Given a global domain and a workspace domain, when the workspace's shell connects to either, then both work, and the page shows the global one as inherited |
| SBX-C61 | SBX-D21 | unexpected | Given a workspace overrides a value, when the human changes the global default, then the workspace keeps its override until reset |
| SBX-C95 | SBX-D33 | expected | Given bubblewrap is missing, when the human turns a workspace's sandbox on, then it stays off and a notice names bubblewrap with an Install button |
| SBX-C96 | SBX-D33 | unexpected | Given a requirement is missing, when `sandbox:set-enabled` true reaches main from the owning window anyway, then main refuses it and the store is unchanged |
| SBX-C97 | SBX-D34 | expected | Given the missing-requirements notice, when the human clicks Install, then the system extension's confirm card lists exactly the missing packages |
| SBX-C98 | SBX-D34 | unexpected | Given the system extension is disabled, when the notice shows, then it offers the install command to copy and opens no terminal |
| SBX-C99 | SBX-D34 | expected | Given a sandboxed pane fails to spawn for a missing package, when it fails, then a desktop notification names the package and its Install action starts the same flow |
| SBX-C18 | SBX-D6 | expected | Given `approvals.mode: 'allow'`, when a sandboxed agent requests a domain, then a card is still shown and nothing is granted until the human answers |
| SBX-C19 | SBX-D6 | unexpected | Given a pending sandbox card, when it times out, then the request is denied and nothing is stored |
| SBX-C20 | SBX-D6 | unexpected | Given a sandbox card answered "This workspace", when approval history is read, then no capability grant was written and the domain is in the workspace's sandbox entry |

## Open
