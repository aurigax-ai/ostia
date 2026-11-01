# Git and ports

```sh
ostia git status                         # {root, branch:{head,oid,upstream,ahead,behind}, counts}
ostia git changes                        # + changes:[{path, origPath?, area, code}]
ostia git diff <path> [--staged]         # {root, path, area, code, patch}
ostia git open <path> [--staged]         # the file's diff in a diff pane
ostia git log [--limit N] [--json]       # recent commits, default 50
ostia git blame <file> [--json]
ostia git stage <path…> | --all
ostia git unstage <path…> | --all
ostia git commit -m <message>            # commits what is staged; prints the sha
ostia ports list [--all]                 # {workspaces:[{workspaceId, ports:[{port, name}], ssh:[host]}]}
ostia ports forward <remote> [--local N] # ssh remote workspace: forward a host port to this computer
ostia ports stop <remote>                # stop that forward
```

Git works on the repository of your current folder; `area` is `staged`, `unstaged`,
`untracked` or `conflicted`. Errors: `not-a-repo`, `not-changed`, `git-failed` with git's
message. There is no discard verb. `ports list --all` needs `all-workspaces`.

In an ssh remote workspace, `ports list` prints one line per host port: remote port, local port
(`-` when not forwarded), process name, error. `forward` and `stop` answer the same lines, read
back after the change. On the desktop they need `process`; on the host they run with no card while
the link is up. The local port is 1024 to 65535 and never one in use; with no `--local`, Ostia picks
it. Errors: `not-remote`, `link-down`, `not-listening`, `bad-port`, `port-taken`, `too-many`. A human
chooses Auto or Manual in the SSH extension settings; you cannot change it.
