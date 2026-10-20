import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from '@aurigax-ai/ostia-extension-sdk'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { BRIDGE_MODE, nodeDeviceIo, parseBridgeArgs, runBridge } from './bridge'
import { serialCommands } from './commands'
import { prepareLogDir } from './session'
import { listDevices } from './settings'

const readdir = (dir: string) => readdirSync(dir)

function logDir(): string | null {
  const data = readEnv('EXTENSION_DATA')
  if (!data) return null
  return join(data, 'logs')
}

function reveal(dir: string): Promise<string | null> {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  return new Promise((resolve) => {
    const child = spawn(opener, [dir], { detached: true, stdio: 'ignore' })
    child.on('error', (err) => resolve(err.message))
    child.on('spawn', () => {
      child.unref()
      resolve(null)
    })
  })
}

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
      logDir,
      prepareLogDir: (dir) => prepareLogDir(dir),
      reveal,
      devices: () => listDevices(process.platform, readdir),
      execPath: process.execPath,
      script: __filename,
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
