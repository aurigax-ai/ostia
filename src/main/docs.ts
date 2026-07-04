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
