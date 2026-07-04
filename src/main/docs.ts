/**
 * `docs` toolbelt method — a static, ungated help blob for the `pine` CLI itself.
 * No capability required: it's just "how do I use this thing", not a privileged action.
 */
import { registerControlMethod } from './controlServer'

const CLI_HELP = `pine — control-socket CLI

  pine whoami                    show this pane's identity
  pine commands                  list commands available in this window
  pine open <file>               open <file> in the editor
  pine notify <title> [body]     fire a desktop notification
  pine process run "<cmd>" [--name X] [--cwd P]   start a tracked background process
  pine process ls                                 list tracked processes
  pine process logs <id|name> [--since N]         print captured output
  pine process kill <id|name>                     kill a tracked process
  pine process restart <id|name>                   kill (if running) and re-run
  pine vault set <KEY> [--global]  store a secret (value read from stdin, no echo)
  pine vault get <KEY> [--global]  print a stored secret
  pine vault ls [--global]         list stored secret keys (never values)
  pine vault rm <KEY> [--global]   delete a stored secret
  pine wiki get <slug> [--global]     print a wiki page's body
  pine wiki set <slug> [--global]     upsert a wiki page (body read from stdin)
  pine wiki ls [--global]             list wiki pages
  pine wiki search <q> [--global]     search wiki pages by title/body
  pine wiki rm <slug> [--global]      delete a wiki page
  pine kanban ls                             list board columns + cards
  pine kanban add "<title>" [--column X] [--body ...]   add a card
  pine kanban move <id> <column>              move a card to a column
  pine kanban assign <id> <who>               assign a card
  pine kanban done <id>                       move a card to 'done'
  pine kanban rm <id>                         delete a card
  pine bus send <toExternalId> "<msg>"        send a message to another pane's inbox
  pine bus inbox [--drain]                    print your inbox (optionally clearing it)
  pine bus wait [--timeout MS]                block until a message arrives (default 30s)
  pine bus handoff <to> --task "..." --summary "..."   hand a task off to another pane
  pine bus claim <id>                         claim a handoff addressed to you
  pine bus handoffs [--mine]                  list handoffs (all, or yours with --mine)
  pine bus done <id>                          mark a handoff completed
  pine docs                      show this help

  pine <command-id> [jsonArgs]   run any registered command by id, with an
                                  optional JSON-encoded args blob
`

export function registerDocsMethods(): void {
  registerControlMethod('docs', {
    handler: () => ({
      cli: CLI_HELP,
      note: 'run `pine commands --json` for the machine-readable command list',
    }),
  })
}
