# Dispatch

- Start each worker with one short line:
  `ostia agent run claude --tab "<project> · workers" --cwd <worktree> "/onboard worker: <task>. Issue #N. Report to <name>."`
  In the Agent pane, call `ostia_agent_run` with the same prompt.
- For a review, start the line with `/onboard reviewer:`.
- Scouting and simple lookups can run on a smaller model.
- Tell each worker your bus name. A restarted manager gets a new pane id but registers the same name again.
- After every dispatch, read the pane back and confirm the worker took the task. A message reaches an idle agent only at its next prompt, so give an idle worker its work with `ostia pane send` and confirm.
