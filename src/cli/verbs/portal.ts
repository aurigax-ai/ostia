import { spawn } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import { launchThroughSystemd } from '../../main/platform/systemdLaunch'
import type { StreamEvent } from '../../shared/agents/agentStream'
import { PI_MANAGER_AGENT } from '../../shared/agents/managerSettings'
import { MIRROR_DETACH_KEY, portalSocketPath, portalSupported } from '../../shared/agents/portal'
import { readLine, SessionPrinter } from './portalSession'

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

function launchOstia(appBin: string, env: NodeJS.ProcessEnv): void {
  const { ELECTRON_RUN_AS_NODE: _node, ...rest } = env
  const args = ['--hidden']
  if (launchThroughSystemd({ exe: appBin, args, env: rest })) return
  spawn(appBin, args, { detached: true, stdio: 'ignore', env: rest }).unref()
}

export async function connectPortal(
  path: string,
  env: NodeJS.ProcessEnv,
  launch: (appBin: string, env: NodeJS.ProcessEnv) => void = launchOstia,
  timeoutMs = START_TIMEOUT_MS,
): Promise<Socket | string> {
  const first = await connectOnce(path)
  if (first) return first
  const appBin = readEnv('APP_BIN', env)
  if (!appBin)
    return 'Ostia is not running, and this ostia command does not know where Ostia is installed'
  launch(appBin, env)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(START_POLL_MS)
    const socket = await connectOnce(path)
    if (socket) return socket
  }
  return `Ostia did not start within ${Math.round(timeoutMs / 1000)} s`
}

export function stripDetach(chunk: string): { input: string; detach: boolean } {
  const at = chunk.indexOf(MIRROR_DETACH_KEY)
  if (at < 0) return { input: chunk, detach: false }
  return { input: chunk.slice(0, at), detach: true }
}

export const NOT_IN_PANE_MESSAGE = 'ostia: not inside an Ostia pane (OSTIA_SOCKET unset)'

export interface PortalGate {
  platform: NodeJS.Platform
  isVerb: (cmd: string) => boolean
}

export function verbIn(table: object): (cmd: string) => boolean {
  return (cmd) => Object.hasOwn(table, cmd)
}

export function outsidePaneRefusal(argv: string[], gate: PortalGate): string | null {
  const [cmd] = argv
  if (cmd === undefined) return portalSupported(gate.platform) ? null : NOT_IN_PANE_MESSAGE
  if (gate.isVerb(cmd) || !portalSupported(gate.platform)) return NOT_IN_PANE_MESSAGE
  return null
}

export async function runPortalCommand(
  argv: string[],
  io: PortalIo,
  gate: PortalGate = { platform: process.platform, isVerb: () => false },
): Promise<number> {
  const refusal = outsidePaneRefusal(argv, gate)
  if (refusal) {
    io.stderr.write(`${refusal}\n`)
    return 1
  }
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    io.stderr.write(`${NOT_IN_PANE_MESSAGE}\n`)
    return 1
  }
  const [agent = PI_MANAGER_AGENT, ...args] = argv
  const path = portalSocketPath(true, io.env, tmpdir())
  const connected = await connectPortal(path, io.env)
  if (typeof connected === 'string') {
    io.stderr.write(`ostia: ${connected}\n`)
    return 1
  }
  return agent === PI_MANAGER_AGENT
    ? session(connected, args, io)
    : mirror(connected, agent, args, io)
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
      if (detach) finish(0, 'ostia: detached; the manager keeps running')
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
      finish(Number.isInteger(code) ? code : 0, `ostia: ${agent} exited`)
    })
    socket.on('close', () => finish(1, 'ostia: the connection to Ostia closed'))
    socket.on('error', () => finish(1, 'ostia: the connection to Ostia failed'))
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
        finish(1, `ostia: ${err instanceof Error ? err.message : String(err)}`)
      })
  })
}

function session(socket: Socket, args: string[], io: PortalIo): Promise<number> {
  const conn: MessageConnection = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  const decoder = new StringDecoder('utf8')
  const printer = new SessionPrinter((text) => io.stdout.write(text))
  let attached = false
  let buffer = ''
  const early: string[] = []

  return new Promise((resolve) => {
    let finished = false
    const finish = (code: number, message?: string): void => {
      if (finished) return
      finished = true
      io.stdin.off('data', onInput)
      if (io.stdin.isTTY) io.stdin.setRawMode(false)
      io.stdin.pause()
      if (message) io.stderr.write(`${message}\n`)
      conn.dispose()
      socket.destroy()
      resolve(code)
    }

    const send = (text: string): void => {
      printer.typed(text)
      conn.sendRequest('portal.prompt', { text }).catch((err: unknown) => {
        printer.failed(err instanceof Error ? err.message : String(err))
      })
    }

    const onInput = (chunk: Buffer): void => {
      const read = readLine(buffer, decoder.write(chunk))
      buffer = read.buffer
      if (read.input.detach) {
        finish(0, 'ostia: detached; the manager session keeps running')
        return
      }
      if (!attached) {
        early.push(...read.input.submitted.filter((line) => line.trim() !== ''))
        return
      }
      io.stdout.write(read.input.edit)
      for (const line of read.input.submitted) {
        if (line.trim() === '') io.stdout.write('\n> ')
        else send(line.trim())
      }
    }

    conn.onNotification('session.events', (params: { events?: unknown }) => {
      if (Array.isArray(params?.events)) printer.events(params.events as StreamEvent[])
    })
    conn.onNotification('session.waiting', (params: { waiting?: unknown }) => {
      if (params?.waiting === true) printer.waiting()
    })
    conn.onNotification('session.ended', () => finish(1, 'ostia: the manager session ended'))
    socket.on('close', () => finish(1, 'ostia: the connection to Ostia closed'))
    socket.on('error', () => finish(1, 'ostia: the connection to Ostia failed'))
    conn.listen()

    io.stdin.setRawMode(true)
    io.stdin.resume()
    io.stdin.on('data', onInput)

    conn
      .sendRequest('portal.open', {
        agent: PI_MANAGER_AGENT,
        args,
        cwd: io.cwd,
        cols: io.stdout.columns,
        rows: io.stdout.rows,
        ...(io.env.PATH ? { path: io.env.PATH } : {}),
      })
      .then(() => {
        attached = true
        printer.banner()
        for (const line of early.splice(0)) send(line.trim())
      })
      .catch((err: unknown) => {
        finish(1, `ostia: ${err instanceof Error ? err.message : String(err)}`)
      })
  })
}
