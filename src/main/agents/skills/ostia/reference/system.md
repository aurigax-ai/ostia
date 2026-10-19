# System packages

```sh
ostia system info                        # {os, kernel, arch, shell, isRoot, packageManagers}
ostia system install ripgrep --reason "search the repo" [--manager <name>] [--wait]
```

`install` shows the human the exact install command; on Approve it runs in a terminal beside
your pane, where the human answers any sudo prompt. It prints `{approved, command, paneId}`,
exit 1 when denied. `--wait` returns when the install ends with `{finished, exitCode}` (up to
about 10 minutes). Package names are plain names without flags or spaces; `--manager` is one of
`pacman paru yay apt dnf zypper apk brew flatpak snap nix-env winget` found on PATH.
