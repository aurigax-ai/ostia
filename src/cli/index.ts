#!/usr/bin/env node
/**
 * `pine` CLI (Slice 5, spec §6). A standalone Node script — NOT bundled into the Electron
 * app — that dials the running app instance's control socket (`PINE_SOCKET`, `PINE_TOKEN`,
 * both injected into every pty's env by `pty:attach` in `src/main/index.ts`) and speaks the
 * same `vscode-jsonrpc` framing as `controlServer.ts`. Built separately via esbuild
 * (`npm run build:cli`) since it must run under plain `node`, not Electron's main process.
 */
import { createConnection } from 'node:net'
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import type { CommandResult } from '../shared/types'

async function main(): Promise<void> {
  const socketPath = process.env.PINE_SOCKET
  const token = process.env.PINE_TOKEN
  const [cmd] = process.argv.slice(2)
  if (!socketPath) {
    console.error('pine: not inside a Pine pane (PINE_SOCKET unset)')
    process.exit(1)
  }
  const socket = createConnection(socketPath)
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  conn.listen()
  try {
    await conn.sendRequest('hello', { token })
    if (cmd === 'whoami') {
      const who = await conn.sendRequest('whoami')
      console.log(JSON.stringify(who, null, 2))
    } else if (cmd === 'commands') {
      const list = await conn.sendRequest('command.list')
      console.log(JSON.stringify(list, null, 2))
    } else if (cmd === 'info') {
      const info = await conn.sendRequest('pane.info')
      console.log(JSON.stringify(info, null, 2))
    } else if (cmd === 'cwd') {
      const res = await conn.sendRequest<{ cwd: string | null }>('cwd.get')
      console.log(res.cwd ?? '')
    } else if (cmd) {
      // Any other verb is treated as a command id, with an optional JSON args blob
      // as the 2nd argv (e.g. `pine pane.splitRight` or `pine pane.write '"ls\n"'`).
      const raw = process.argv[3]
      const args = raw ? JSON.parse(raw) : undefined
      const res = await conn.sendRequest<CommandResult>('command.exec', { id: cmd, args })
      if (res.ok) {
        console.log('ok')
        if (res.result !== undefined) console.log(JSON.stringify(res.result))
      } else {
        console.error('pine:', res.error?.message)
        process.exitCode = 1
      }
    } else {
      console.error(`pine: unknown command '${cmd ?? ''}' (try: whoami, commands, info, cwd)`)
      process.exitCode = 1
    }
  } catch (e) {
    console.error('pine:', e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  } finally {
    conn.dispose()
    socket.destroy()
  }
}
void main()
