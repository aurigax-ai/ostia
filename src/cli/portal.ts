import { spawn } from 'node:child_process'
import { type Socket, createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import { MIRROR_DETACH_KEY, portalSocketPath } from '../shared/portal'

export const PORTAL_USAGE = `usage: pine <agent> [args…]

Run from a terminal outside Pine. Opens Pine's manager workspace running <agent>
(a preset such as claude or codex) and shows it here. Starts Pine in the tray if it
isn't running. Ctrl+\\ detaches and leaves the manager running.`

const START_TIMEOUT_MS = 20_000
const START_POLL_MS = 250
const ENTER_ALT_SCREEN = '\x1b[?1049h'
const LEAVE_ALT_SCREEN = '\x1b[?1049l'

export interface PortalIo {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WritableStream
  env: NodeJS.ProcessEnv
  cwd: string
}

function connectOnce(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    socket.once('connect', () => resolve(socket))
    socket.once('error', () => resolve(null))
  })
}

function launchPine(appBin: string, env: NodeJS.ProcessEnv): void {
  const { ELECTRON_RUN_AS_NODE: _node, ...rest } = env
  spawn(appBin, ['--hidden'], { detached: true, stdio: 'ignore', env: rest }).unref()
}

export async function connectPortal(
  path: string,
  env: NodeJS.ProcessEnv,
  launch: (appBin: string, env: NodeJS.ProcessEnv) => void = launchPine,
  timeoutMs = START_TIMEOUT_MS,
): Promise<Socket | string> {
  const first = await connectOnce(path)
  if (first) return first
  const appBin = env.PINE_APP_BIN
  if (!appBin)
    return 'Pine is not running, and this pine command does not know where Pine is installed'
  launch(appBin, env)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(START_POLL_MS)
    const socket = await connectOnce(path)
    if (socket) return socket
  }
  return `Pine did not start within ${Math.round(timeoutMs / 1000)} s`
}

export function stripDetach(chunk: string): { input: string; detach: boolean } {
  const at = chunk.indexOf(MIRROR_DETACH_KEY)
  if (at < 0) return { input: chunk, detach: false }
  return { input: chunk.slice(0, at), detach: true }
}

export async function runPortalCommand(argv: string[], io: PortalIo): Promise<number> {
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    io.stderr.write('pine: not inside a Pine pane (PINE_SOCKET unset)\n')
    return 1
  }
  const [agent, ...args] = argv
  if (!agent) {
    io.stdout.write(`${PORTAL_USAGE}\n`)
    return 1
  }
  const path = portalSocketPath(true, io.env, tmpdir())
  const connected = await connectPortal(path, io.env)
  if (typeof connected === 'string') {
    io.stderr.write(`pine: ${connected}\n`)
    return 1
  }
  return mirror(connected, agent, args, io)
}

function mirror(socket: Socket, agent: string, args: string[], io: PortalIo): Promise<number> {
  const conn: MessageConnection = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  const decoder = new StringDecoder('utf8')
  let screenTaken = false
  let attached = false
  const early: string[] = []

  return new Promise((resolve) => {
    let finished = false
    const finish = (code: number, message?: string): void => {
      if (finished) return
      finished = true
      io.stdin.off('data', onInput)
      io.stdout.off('resize', onResize)
      if (io.stdin.isTTY) io.stdin.setRawMode(false)
      io.stdin.pause()
      if (screenTaken) io.stdout.write(LEAVE_ALT_SCREEN)
      if (message) io.stderr.write(`${message}\n`)
      conn.dispose()
      socket.destroy()
      resolve(code)
    }

    const onInput = (chunk: Buffer): void => {
      const { input, detach } = stripDetach(decoder.write(chunk))
      if (input && attached) void conn.sendNotification('mirror.input', { data: input })
      else if (input) early.push(input)
      if (detach) finish(0, 'pine: detached; the manager keeps running')
    }
    const onResize = (): void => {
      void conn.sendNotification('mirror.resize', {
        cols: io.stdout.columns,
        rows: io.stdout.rows,
      })
    }

    conn.onNotification('mirror.data', (params: { data?: unknown }) => {
      if (typeof params?.data === 'string') io.stdout.write(params.data)
    })
    conn.onNotification('mirror.exit', (params: { code?: unknown }) => {
      const code = Number(params?.code)
      finish(Number.isInteger(code) ? code : 0, `pine: ${agent} exited`)
    })
    socket.on('close', () => finish(1, 'pine: the connection to Pine closed'))
    socket.on('error', () => finish(1, 'pine: the connection to Pine failed'))
    conn.listen()

    io.stdin.setRawMode(true)
    io.stdin.resume()
    io.stdout.write(ENTER_ALT_SCREEN)
    screenTaken = true
    io.stdin.on('data', onInput)
    io.stdout.on('resize', onResize)

    conn
      .sendRequest('portal.open', {
        agent,
        args,
        cwd: io.cwd,
        cols: io.stdout.columns,
        rows: io.stdout.rows,
        ...(io.env.PATH ? { path: io.env.PATH } : {}),
      })
      .then(() => {
        attached = true
        if (early.length > 0) void conn.sendNotification('mirror.input', { data: early.join('') })
        early.length = 0
      })
      .catch((err: unknown) => {
        finish(1, `pine: ${err instanceof Error ? err.message : String(err)}`)
      })
  })
}
