# Settings and snippets

```sh
ostia settings schema [key]              # each key's type, allowed values and description
ostia settings get [key]
ostia settings set appearance.terminal.size 14 [--dry-run]   # value parsed as JSON, else a string
ostia settings unset appearance.terminal.size
ostia settings set keybindings.palette.toggle '"Ctrl+Shift+Y"'   # null unbinds
ostia snippet list [--json] | snippet show <name> [--json]
ostia account list [--json]              # number, email, current or off, session % and weekly % of each Claude account
ostia account switch <email|number>     # the account new Claude sessions start on; the human is asked every time
```

`set` prints `{previous, value, applied}` and refuses an unknown key, a wrong type or a value
the setting does not list. The human's own keys are refused with `can only be changed by you in
Settings`: the roots `capabilities`, `privacy`, `terminalKeys`, `modifierRemap`, `workspaceGroups` and `playbooks`, and
`behavior.externalEditor`, `behavior.checkForUpdates`, `behavior.updateChannel`,
`behavior.discreteGpu`, `notifications.command`, `agents.autoResume`,
`agents.hooks`, `agents.trustWorkspaceFolders`, `agents.finishedHibernateMinutes`,
`terminal.warnOnRiskyPaste`, `terminal.shell`, `terminal.osc52Write`,
`terminal.askBeforeOpeningApps`, `terminal.allowedAppSchemes`, `terminal.keepShells`,
`terminal.scrollbackHistory`, `workspaces.globalHotkey`. Any other root that is not a settings
group (`approvals`, `sync`, `sandbox`, `manager`, `assistant`, …) answers `unknown settings key`.
A chord the shell needs (plain Ctrl+letter,
arrows, Escape, Tab) is refused for a keybinding. Snippets come from
`<workDir>/.ostia/snippets/*.yaml`, `~/.config/ostia/snippets/*.yaml` and extensions; there is
no verb that runs one. `account switch` changes only the account new Claude sessions start on, never
a running one; the human approves it on a card each time, and nothing here adds, removes or signs out an account.
The two usage columns stay empty until the human turns on Check usage in Settings, and on macOS.
An account the human turned off in Settings is listed as `off`; `account switch` to it fails with `account-off`.
