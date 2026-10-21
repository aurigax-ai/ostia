# Settings and snippets

```sh
ostia settings schema [key]              # each key's type, allowed values and description
ostia settings get [key]
ostia settings set appearance.terminal.size 14 [--dry-run]   # value parsed as JSON, else a string
ostia settings unset appearance.terminal.size
ostia settings set keybindings.palette.toggle '"Ctrl+Shift+Y"'   # null unbinds
ostia snippet list [--json] | snippet show <name> [--json]
```

`set` prints `{previous, value, applied}` and refuses an unknown key, a wrong type or a value
the setting does not list. The human's own keys are refused with `can only be changed by you in
Settings`: the roots `capabilities`, `privacy`, `terminalKeys`, `modifierRemap`, `workspaceGroups` and `playbooks`, and
`behavior.externalEditor`, `behavior.checkForUpdates`, `behavior.updateChannel`,
`behavior.discreteGpu`, `notifications.command`, `agents.autoResume`,
`agents.hooks`, `agents.trustWorkspaceFolders`,
`terminal.warnOnRiskyPaste`, `terminal.shell`, `terminal.osc52Write`, `terminal.keepShells`,
`terminal.scrollbackHistory`, `workspaces.globalHotkey`. Any other root that is not a settings
group (`approvals`, `sync`, `sandbox`, `manager`, `assistant`, …) answers `unknown settings key`.
A chord the shell needs (plain Ctrl+letter,
arrows, Escape, Tab) is refused for a keybinding. Snippets come from
`<workDir>/.ostia/snippets/*.yaml`, `~/.config/ostia/snippets/*.yaml` and extensions; there is
no verb that runs one.
