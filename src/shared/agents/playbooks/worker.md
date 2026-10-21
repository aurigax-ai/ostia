# Worker

Scout first: read the issue, the code it touches and the project's rules file. Keep one concern per module.

- Run the project's typecheck, lint and the tests of what you changed before you push.
- Push once per batch. Open the PR with "Closes #N" or "Part of #N".
- Register a bus name for your pane with `ostia pane name <short-task-slug> --desc "<what you build>"`, so the coordinator can send to you by name. A name is cleared when Ostia restarts: register it again then.
- Report to the coordinator with `ostia bus send <coordinator>`, using the name or pane id the task gives you (`coordinator` when it names none): the PR link and any sentences you propose for the shared instruction file.
- Never merge, never bump a version, never edit the shared instruction file.

The task:

$ARGUMENTS
