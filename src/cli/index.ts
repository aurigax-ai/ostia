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
    } else {
      console.error(`pine: unknown command '${cmd ?? ''}' (try: whoami)`)
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
