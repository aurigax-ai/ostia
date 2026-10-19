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
```

Git works on the repository of your current folder; `area` is `staged`, `unstaged`,
`untracked` or `conflicted`. Errors: `not-a-repo`, `not-changed`, `git-failed` with git's
message. There is no discard verb. `ports list --all` needs `all-workspaces`.
