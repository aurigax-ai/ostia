import { readdirSync } from 'node:fs'
import { connect } from '@aurigax-ai/ostia-extension-sdk'
import { BRIDGE_MODE, nodeDeviceIo, parseBridgeArgs, runBridge } from './bridge'
import { serialCommands } from './commands'
import { listDevices } from './settings'

const readdir = (dir: string) => readdirSync(dir)

async function bridge(argv: string[]): Promise<void> {
  const code = await runBridge(parseBridgeArgs(argv), {
    platform: process.platform,
    readdir,
    terminal: { input: process.stdin, output: process.stdout },
    io: nodeDeviceIo,
  })
  process.exit(code)
}

async function main(): Promise<void> {
  const ext = await connect()
  await ext.registerCommands(
    serialCommands({
      platform: process.platform,
      devices: () => listDevices(process.platform, readdir),
      execPath: process.execPath,
      script: __filename,
      confirm: (req) => ext.confirm(req),
      openTerminal: (opts) => ext.openTerminal(opts),
    }),
  )
}

const [mode, ...rest] = process.argv.slice(2)
const run = mode === BRIDGE_MODE ? bridge(rest) : main()
run.catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
