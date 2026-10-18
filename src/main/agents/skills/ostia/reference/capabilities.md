# Capabilities, reach, the phone gateway and script tokens

## Contents

- Capabilities
- Refusals
- Reach
- Phone gateway
- Script tokens

## Capabilities

A pane holds these by default: `drive-self`, `read-board`, `notify`, `settings-read`, `process`,
`vault-read`, `vault-write`. These start withheld: `send-other-pane`, `type-other-pane`,
`read-other-pane`, `kill-pane`, `all-workspaces`, `shell`, `destructive`, `phone`, `gateway`,
`browse`, `settings-write`, `credentials`.

A call that needs a withheld capability waits (up to 90 s) while a card on the pane asks the
human: Allow once, Allow for this pane (until it closes), or Deny. On Allow the same call
succeeds. `destructive` and `credentials` ask every time. The human can pre-grant capabilities
in settings.json (`"capabilities": {"grants": ["browse"]}`) or set Settings → Agents → Agent
permission requests to "Allow and record". No command grants or approves a capability, and
`capabilities` and `approvals` cannot be set with `ostia settings set`. `ostia commands` lists
each command's `capabilities`.

## Refusals

| Error | Meaning |
|---|---|
| `denied: <caps>` | the human said no |
| `not-approved: <caps>` | nobody answered in time |
| `needs-elevation: <cap>` | the caller cannot be asked (an extension, or a script token without it) |
| `sandboxed:` | a sandboxed workspace reaches only itself |

## Reach

Reach is the set of workspaces a pane acts on without `all-workspaces`, set by the human in
Settings → Agents (`capabilities.reach`); `ostia settings set` refuses it.

- `workspace`: the pane's own workspace.
- `project` (default): also every workspace on the same git repository (any worktree), or the
  same folder outside a repository, with the same sandbox state. A folder an agent set with
  `ostia workspace dir` counts after the human confirms it on a card.
- `group`: also the workspaces in the pane's sidebar group. A membership an agent made counts
  after the human confirms it on a card.

Scratch and sandboxed workspaces are in no one's reach. Reach replaces only `all-workspaces`:
panes the caller did not open still ask for `type-other-pane`, `read-other-pane` or `kill-pane`.

## Phone gateway

```sh
ostia gateway status                     # {running, host, port, fingerprint, deviceCount, tailnet, route}
ostia gateway pair                       # pairing JSON and an ostia-pair:// URI; not-running when off
ostia gateway devices                    # deviceId, name, caps, createdAt
ostia gateway revoke <deviceId>
```

Every gateway verb needs `gateway`. The gateway is off until the human turns it on and picks its
route in Settings → Remote; no command starts it. A paired phone gets `read` and `notify`;
`command`, `input` and `destructive` are granted per phone only in Settings → Remote.

## Script tokens

A program outside Ostia runs `ostia` with `OSTIA_TOKEN` set to a script token the human made
with `ostia token create`; with `OSTIA_SOCKET` unset, the CLI finds the app's socket itself.
Scripts reach only these commands: `whoami`, `docs`, `commands`, `notify` (a desktop
notification only), `bus send`, `pane list|read|send|key|wait|wake|hibernate|close|rename|move`,
`process run|list|logs|kill|restart`, `agent run`, and
`workspace list|new|rename|describe|close|group|ungroup|group-color|group-rename|group-delete|pin|unpin`.
A script never asks the human: a capability its token lacks answers `needs-elevation`, and an
expired token `token-expired`. A script has no pane or workspace of its own, so it names its
target: a pane, `--workspace` for `process run`, `agent run` and the workspace verbs, and its
reach is the token's scope.
