import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { booleanSetting, connect, onShutdown, runTool } from '../sdk'
import { sshCommands } from './commands'
import { CONSENT_FILE, HelperConsent } from './consent'
import { helperBundle } from './helper'
import { helperCommands } from './helperCommands'
import { HelperHosts } from './helperHosts'
import { discoverHosts } from './hosts'

const RESOLVE_TIMEOUT_MS = 5000
const HELPER_SOURCE = join(__dirname, 'assets', 'helper.sh')

async function main(): Promise<void> {
  const ext = await connect()
  const helper = helperBundle(readFileSync(HELPER_SOURCE))
  const hosts = new HelperHosts({ helper })
  const dataDir = process.env.PINE_EXTENSION_DATA
  const consent = new HelperConsent(dataDir ? join(dataDir, CONSENT_FILE) : null)
  const run = (args: string[]) => runTool('ssh', args, { timeoutMs: RESOLVE_TIMEOUT_MS })
  onShutdown(() => hosts.closeAll())
  await ext.registerCommands({
    ...sshCommands({
      discover: () => discoverHosts(homedir()),
      run,
      confirm: (req) => ext.confirm(req),
      openTerminal: (opts) => ext.openTerminal(opts),
      shellIntegration: async () =>
        booleanSetting(await ext.getSettings(), 'shellIntegration', true),
    }),
    ...helperCommands({
      run,
      confirm: (req) => ext.confirm(req),
      enabled: async () => booleanSetting(await ext.getSettings(), 'remoteHelper', true),
      consent,
      hosts,
      helper,
    }),
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
