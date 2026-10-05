---
name: greet
description: Use when the human asks you to greet someone by name.
---

# Greet

List the extension commands and find the one titled "Greet":

```sh
ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" ext ls
```

Run it with the person's name, for example `ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" hello greet Ada`
(use the extension id the list shows). It posts a notification in the app and prints the
greeting. Releases from before the rename set only `$OSTIA_NODE` and `$OSTIA_CLI`; use those there.
