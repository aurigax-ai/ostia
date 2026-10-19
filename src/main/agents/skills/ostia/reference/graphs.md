# Graphs

```sh
ostia graph schema                       # the graph file's JSON Schema
ostia graph nodes                        # the node kinds Ostia runs, their fields and outputs
ostia graph validate .ostia/graphs/ship.yaml   # checks the file and prints each problem
ostia graph explain <file>               # an outline: triggers, nodes, edges, what it needs
ostia graph dry-run <file> [--input k=v]… [--mock <node>=<json>]… [--json]   # mocked outputs; nothing runs
ostia graph list                         # this workspace's graphs and whether each is enabled
ostia graph runs [name] | graph show <run> [--node <id>]
ostia graph run <name> [--input key=value]… [--input-json <json>]
ostia graph report --json '<object>' [--run <id>]
ostia graph open                         # opens the Graphs panel for the human
```

A graph is one YAML file, `.ostia/graphs/<name>.yaml` in the workspace folder. It runs only
after the human clicks Enable on its exact definition in the Graphs panel; any change outside
`ui` disables it, and no command enables one. `graph run` starts only an enabled graph whose
manual trigger says `agents: true`, from a pane of its workspace, which becomes `trigger.pane`.
An agent node's prompt names its `--run`; `report` without one is refused as `ambiguous` when
two runs wait on the pane. A `command` node runs without a terminal tab; its output is in the
Graphs panel and `graph show`. A `message` node reaches an agent through the bus. Graphs run only
while Ostia runs.
