---
name: greet
description: Use when the human asks you to greet someone by name.
---

# Greet

List the extension commands and find the one titled "Greet":

```sh
ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" ext ls
```

Run it with the person's name, for example `ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" hello greet Ada`
(use the extension id the list shows). It posts a notification in the app and prints the
greeting.
