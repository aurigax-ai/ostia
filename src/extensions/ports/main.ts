import {
  type CommandHandler,
  type OstiaExtension,
  cliArgs,
  connect,
  failure,
  ok,
  parseFlags,
} from '../sdk'
import { scanTrees } from './scan'
import { groupByWorkspace, terminalPids } from './sidebar'

function handlers(ext: OstiaExtension): Record<string, CommandHandler> {
  return {
    ls: async (args, caller) => {
      const cli = cliArgs(args)
      const all = cli ? parseFlags(cli.argv, [], ['all']).bools.has('all') : false
      if (all && !caller.capabilities.includes('all-workspaces')) {
        return failure('needs-elevation', 'all-workspaces')
      }
      if (!all && !caller.workspaceId)
        return failure('no-workspace', 'no workspace for this caller')
      const panes = await ext.listPanes()
      const groups = groupByWorkspace(panes, await scanTrees(terminalPids(panes), process.ppid))
      const workspaces = [...groups]
        .filter(([id]) => all || id === caller.workspaceId)
        .map(([workspaceId, group]) => ({ workspaceId, ports: group.ports, ssh: group.ssh }))
      return ok(undefined, { workspaces })
    },
  }
}

async function main(): Promise<void> {
  const ext = await connect()
  await ext.registerCommands(handlers(ext))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
