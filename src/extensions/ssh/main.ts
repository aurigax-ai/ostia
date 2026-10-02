import { homedir } from 'node:os'
import { connect, runTool } from '../sdk'
import { sshCommands } from './commands'
import { discoverHosts } from './hosts'

const RESOLVE_TIMEOUT_MS = 5000

async function main(): Promise<void> {
  const ext = await connect()
  await ext.registerCommands(
    sshCommands({
      discover: () => discoverHosts(homedir()),
      run: (args) => runTool('ssh', args, { timeoutMs: RESOLVE_TIMEOUT_MS }),
      confirm: (req) => ext.confirm(req),
      openTerminal: (opts) => ext.openTerminal(opts),
      shellIntegration: async () => (await ext.getSettings()).shellIntegration !== false,
    }),
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
