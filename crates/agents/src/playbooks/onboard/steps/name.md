# Name

Register a bus name for your pane with `ostia pane name <name> --desc "<what you do>"`, so other agents can send to you by name.

- A worker uses a short task slug.
- A manager uses `coordinator`. If it answers `name-taken`, use `coordinator-<project>`.
- A name is cleared when Ostia restarts: register it again then.
