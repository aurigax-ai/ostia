import { spawn } from 'node:child_process'
import { closeSync, constants, openSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { ReadStream } from 'node:tty'
import { parseFlags } from '@aurigax-ai/ostia-extension-sdk'
import { CR, EchoLoop, LF, type LogFile, openLogFile, SessionLog } from './session'
import {
  COMMON_SPEEDS,
  DEFAULT_FRAME,
  DEFAULT_SPEED,
  deviceGlobs,
  frameText,
  isSerialDevice,
  type LineSettings,
  listDevices,
  logName,
  parseFrame,
  parseSpeed,
  sttyArgs,
} from './settings'
import { QUIT_KEY, SECRET_KEY, SECRET_TITLE_MARK, type Strings, stringsFor } from './strings'

export const BRIDGE_MODE = 'bridge'
const QUIT_BYTE = 0x1d
const SECRET_BYTE = 0x1c
const STTY_TIMEOUT_MS = 5000
const OPEN_FLAGS = constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK

export interface BridgeArgs {
  locale?: string
  device?: string
  speed?: string
  frame?: string
  log?: string
  logDir?: string
}

interface BridgeTiming {
  logFlushMs: number
  loopQuietMs: number
  secretGraceMs: number
}

const DEFAULT_TIMING: BridgeTiming = { logFlushMs: 250, loopQuietMs: 600, secretGraceMs: 1500 }

interface BridgeTerminal {
  input: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown }
  output: { write: (chunk: string | Uint8Array) => unknown }
}

export interface DeviceStream {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'end' | 'close', listener: () => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  write(data: Uint8Array, done: (err?: Error | null) => void): unknown
  destroy(): unknown
}

export interface DeviceIo {
  open: (path: string) => number
  close: (fd: number) => void
  configure: (fd: number, args: string[]) => Promise<string | null>
  stream: (fd: number) => DeviceStream
}

export interface BridgeEnv {
  platform: NodeJS.Platform
  readdir: (dir: string) => string[]
  terminal: BridgeTerminal
  io: DeviceIo
  openLog?: (path: string) => LogFile
  timing?: Partial<BridgeTiming>
}

export function runStty(fd: number, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('stty', args, { stdio: [fd, 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), STTY_TIMEOUT_MS)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve(err.message)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(null)
      else
        resolve(
          stderr.trim() || (signal ? `stty was stopped (${signal})` : `stty exited with ${code}`),
        )
    })
  })
}

export const nodeDeviceIo: DeviceIo = {
  open: (path) => openSync(path, OPEN_FLAGS),
  close: (fd) => closeSync(fd),
  configure: runStty,
  stream: (fd) => new ReadStream(fd),
}

export function parseBridgeArgs(argv: string[]): BridgeArgs {
  const { flags } = parseFlags(argv, ['locale', 'device', 'speed', 'frame', 'log', 'log-dir'])
  return {
    locale: flags.locale,
    device: flags.device,
    speed: flags.speed,
    frame: flags.frame,
    log: flags.log,
    logDir: flags['log-dir'],
  }
}

export function bridgeCommand(
  execPath: string,
  script: string,
  locale: string | undefined,
  target?: { device: string; line: LineSettings },
  logs?: { dir: string; name?: string },
): string[] {
  const argv = ['env', 'ELECTRON_RUN_AS_NODE=1', execPath, script, BRIDGE_MODE]
  if (locale) argv.push('--locale', locale)
  if (target) {
    argv.push('--device', target.device, '--speed', String(target.line.speed))
    argv.push('--frame', frameText(target.line.frame))
  }
  if (logs) argv.push('--log-dir', logs.dir)
  if (logs?.name !== undefined) argv.push('--log', logs.name)
  return argv
}

function lineText(line: LineSettings): string {
  return `${line.speed} ${frameText(line.frame)}`
}

export function paneTitle(device: string, line: LineSettings): string {
  return `${device.slice(device.lastIndexOf('/') + 1)} ${lineText(line)}`
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined
}

function reasonOf(err: unknown): string {
  return errorCode(err) ?? (err instanceof Error ? err.message : String(err))
}

export function openFailure(
  err: unknown,
  device: string,
  platform: NodeJS.Platform,
  s: Strings,
): string {
  const code = errorCode(err)
  if (code === 'EBUSY') return s.busy(device)
  if (code === 'ENOENT' || code === 'ENXIO' || code === 'ENODEV') return s.missing(device)
  if (code === 'EACCES' || code === 'EPERM') return s.deniedAccess(device, platform === 'linux')
  return s.openFailed(device, reasonOf(err))
}

function say(terminal: BridgeTerminal, text: string): void {
  terminal.output.write(`${text}\r\n`)
}

function lineReader(input: NodeJS.ReadableStream): {
  next: () => Promise<string | null>
  close: () => void
} {
  const rl = createInterface({ input, terminal: false })
  const queued: string[] = []
  const waiting: ((line: string | null) => void)[] = []
  let ended = false
  rl.on('line', (line) => {
    const take = waiting.shift()
    if (take) take(line)
    else queued.push(line)
  })
  rl.on('close', () => {
    ended = true
    for (const take of waiting.splice(0)) take(null)
  })
  return {
    next: () => {
      const line = queued.shift()
      if (line !== undefined) return Promise.resolve(line)
      if (ended) return Promise.resolve(null)
      return new Promise((resolve) => waiting.push(resolve))
    },
    close: () => rl.close(),
  }
}

async function ask<T>(
  terminal: BridgeTerminal,
  next: () => Promise<string | null>,
  prompt: string,
  fallback: string,
  parse: (text: string) => T | null,
  invalid: (text: string) => string,
  s: Strings,
): Promise<T | null> {
  for (;;) {
    terminal.output.write(`${prompt} [${fallback}]: `)
    const answer = await next()
    if (answer === null) return null
    const text = answer.trim() === '' ? fallback : answer.trim()
    const value = parse(text)
    if (value !== null) return value
    say(terminal, invalid(text))
    say(terminal, s.pickAgain)
  }
}

async function askLog(
  terminal: BridgeTerminal,
  next: () => Promise<string | null>,
  s: Strings,
  dir: string,
): Promise<{ log?: string } | null> {
  for (;;) {
    terminal.output.write(`${s.logPrompt(dir)}: `)
    const answer = await next()
    if (answer === null) return null
    const name = answer.trim()
    if (name === '') return {}
    if (logName(name)) return { log: join(dir, name) }
    say(terminal, s.badLogName(name))
  }
}

type Picked = { device: string; line: LineSettings; log?: string }

async function pickTarget(
  env: BridgeEnv,
  s: Strings,
  log: string | undefined,
  logDir: string | undefined,
): Promise<Picked | null> {
  const { terminal } = env
  const devices = listDevices(env.platform, env.readdir)
  if (devices.length === 0) {
    say(terminal, s.noDevices(deviceGlobs(env.platform).join(', ')))
    return null
  }
  say(terminal, s.devicesHeading)
  devices.forEach((device, index) => say(terminal, `  ${index + 1}) ${device}`))
  const reader = lineReader(terminal.input)
  try {
    const globs = deviceGlobs(env.platform).join(', ')
    const device = await ask(
      terminal,
      reader.next,
      s.devicePrompt,
      '1',
      (text) =>
        /^\d+$/.test(text)
          ? (devices[Number(text) - 1] ?? null)
          : devices.includes(text)
            ? text
            : null,
      (text) => s.badDevice(text, globs),
      s,
    )
    const speed =
      device === null
        ? null
        : await ask(
            terminal,
            reader.next,
            s.speedPrompt(COMMON_SPEEDS.join(', ')),
            String(DEFAULT_SPEED),
            parseSpeed,
            s.badSpeed,
            s,
          )
    const frame =
      speed === null
        ? null
        : await ask(terminal, reader.next, s.framePrompt, DEFAULT_FRAME, parseFrame, s.badFrame, s)
    const logged =
      frame === null
        ? null
        : log !== undefined || logDir === undefined
          ? { log }
          : await askLog(terminal, reader.next, s, logDir)
    if (device === null || speed === null || frame === null || logged === null) {
      say(terminal, '')
      say(terminal, s.inputClosed)
      return null
    }
    return { device, line: { speed, frame }, ...logged }
  } finally {
    reader.close()
  }
}

function openConfigured(
  device: string,
  line: LineSettings,
  env: BridgeEnv,
  s: Strings,
): Promise<{ fd: number } | { message: string }> {
  const { io } = env
  let fd: number
  try {
    fd = io.open(device)
  } catch (err) {
    return Promise.resolve({ message: openFailure(err, device, env.platform, s) })
  }
  return io.configure(fd, sttyArgs(line)).then((failed) => {
    if (failed === null) return { fd }
    io.close(fd)
    return { message: s.sttyFailed(device, failed) }
  })
}

function frameBits({ frame }: LineSettings): number {
  return 1 + frame.dataBits + (frame.parity === 'none' ? 0 : 1) + frame.stopBits
}

function firstLineEnd(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === CR || bytes[i] === LF) return i
  return -1
}

function openSessionLog(
  path: string | undefined,
  env: BridgeEnv,
  s: Strings,
): { file: LogFile | null } | { message: string } {
  if (path === undefined) return { file: null }
  try {
    return { file: (env.openLog ?? openLogFile)(path) }
  } catch (err) {
    return { message: s.logFailed(path, reasonOf(err)) }
  }
}

export async function connectDevice(
  device: string,
  line: LineSettings,
  env: BridgeEnv,
  s: Strings,
  logTo?: string,
): Promise<number> {
  const { terminal, io } = env
  const timing = { ...DEFAULT_TIMING, ...env.timing }
  const opened = await openConfigured(device, line, env, s)
  if ('message' in opened) {
    say(terminal, opened.message)
    return 1
  }
  const logOpened = openSessionLog(logTo, env, s)
  if ('message' in logOpened) {
    io.close(opened.fd)
    say(terminal, logOpened.message)
    return 1
  }
  const logFile = logOpened.file
  let port: DeviceStream
  try {
    port = io.stream(opened.fd)
  } catch (err) {
    io.close(opened.fd)
    logFile?.close()
    say(terminal, openFailure(err, device, env.platform, s))
    return 1
  }
  const title = paneTitle(device, line)
  const setTitle = (text: string): void => {
    terminal.output.write(`\x1b]2;${text}\x07`)
  }
  setTitle(title)
  say(terminal, s.connected(device, lineText(line)))
  if (logTo !== undefined) say(terminal, s.logging(logTo))
  say(terminal, s.quitHint(QUIT_KEY))
  say(terminal, s.secretHint(SECRET_KEY))
  return new Promise((resolve) => {
    let stopped = false
    let secret = false
    let hiding = false
    let hidSome = false
    let hinted = false
    let secretBytes = 0
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    const loop = new EchoLoop()
    let log: SessionLog | null = null
    if (logFile && logTo !== undefined) {
      log = new SessionLog(logFile, timing.logFlushMs, (err) => {
        log = null
        say(terminal, s.logFailed(logTo, reasonOf(err)))
      })
      log.note(`connected ${device} ${lineText(line)}`)
    }

    const stopHiding = (): void => {
      clearTimeout(graceTimer)
      hiding = false
      if (hidSome) log?.hidden('received')
      hidSome = false
    }
    const startSecret = (): void => {
      clearTimeout(graceTimer)
      log?.flushAll()
      secret = true
      hiding = true
      secretBytes = 0
      setTitle(`${SECRET_TITLE_MARK}${title}`)
      say(terminal, '')
      say(terminal, s.secretOn(SECRET_KEY))
    }
    const endSecret = (): void => {
      secret = false
      log?.hidden('sent')
      setTitle(title)
      say(terminal, '')
      say(terminal, s.secretOff)
      const echoMs = Math.ceil((secretBytes * frameBits(line) * 1000) / line.speed)
      graceTimer = setTimeout(stopHiding, timing.secretGraceMs + echoMs)
    }
    const armLoopCheck = (): void => {
      clearTimeout(quietTimer)
      if (hinted || !loop.alive) return
      quietTimer = setTimeout(() => {
        if (stopped || !loop.looped()) return
        hinted = true
        loop.stop()
        say(terminal, '')
        say(terminal, s.loopHint)
      }, timing.loopQuietMs)
    }

    const finish = (code: number, message: string): void => {
      if (stopped) return
      stopped = true
      clearTimeout(quietTimer)
      terminal.input.removeListener('data', onInput)
      terminal.input.setRawMode?.(false)
      terminal.input.pause()
      port.destroy()
      if (secret) {
        log?.hidden('sent')
        setTitle(title)
      }
      stopHiding()
      log?.close('disconnected')
      say(terminal, '')
      say(terminal, message)
      resolve(code)
    }
    const gone = (): void => finish(1, s.gone(device))
    const send = (data: Uint8Array): void => {
      if (data.length === 0 || stopped) return
      if (secret) secretBytes += data.length
      else log?.add('sent', data)
      loop.sent(data)
      armLoopCheck()
      port.write(data, (err) => {
        if (err) gone()
      })
    }
    const onInput = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      let from = 0
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]
        if (b === QUIT_BYTE) {
          send(bytes.subarray(from, i))
          finish(0, s.closed(device))
          return
        }
        if (b === SECRET_BYTE) {
          send(bytes.subarray(from, i))
          from = i + 1
          if (secret) endSecret()
          else startSecret()
        } else if (secret && (b === CR || b === LF)) {
          send(bytes.subarray(from, i + 1))
          from = i + 1
          endSecret()
        }
      }
      send(bytes.subarray(from))
    }
    const shown = (chunk: Buffer): Buffer | null => {
      if (!hiding) return chunk
      const end = secret ? -1 : firstLineEnd(chunk)
      if (end === -1) {
        hidSome = hidSome || chunk.length > 0
        return null
      }
      const cut = chunk[end] === CR && chunk[end + 1] === LF ? end + 2 : end + 1
      hidSome = hidSome || end > 0
      stopHiding()
      return chunk.subarray(cut)
    }
    port.on('data', (chunk) => {
      if (stopped) return
      loop.received(chunk)
      armLoopCheck()
      const visible = shown(chunk)
      if (!visible || visible.length === 0) return
      log?.add('received', visible)
      terminal.output.write(visible)
    })
    port.on('error', gone)
    port.on('end', gone)
    port.on('close', gone)
    terminal.input.setRawMode?.(true)
    terminal.input.on('data', onInput)
    terminal.input.resume()
  })
}

export async function runBridge(args: BridgeArgs, env: BridgeEnv): Promise<number> {
  const s = stringsFor(args.locale)
  if (deviceGlobs(env.platform).length === 0) {
    say(env.terminal, s.unsupported)
    return 2
  }
  const logDir = args.logDir !== undefined && isAbsolute(args.logDir) ? args.logDir : undefined
  if (args.log !== undefined && !logName(args.log)) {
    say(env.terminal, s.badLogName(args.log))
    return 2
  }
  if (args.log !== undefined && logDir === undefined) {
    say(env.terminal, s.noLogDir)
    return 2
  }
  const log = args.log !== undefined && logDir !== undefined ? join(logDir, args.log) : undefined
  if (args.device === undefined) {
    const picked = await pickTarget(env, s, log, logDir)
    if (!picked) return 1
    return connectDevice(picked.device, picked.line, env, s, picked.log)
  }
  if (!isSerialDevice(args.device, env.platform)) {
    say(env.terminal, s.badDevice(args.device, deviceGlobs(env.platform).join(', ')))
    return 2
  }
  const speed = parseSpeed(args.speed ?? String(DEFAULT_SPEED))
  if (speed === null) {
    say(env.terminal, s.badSpeed(args.speed ?? ''))
    return 2
  }
  const frame = parseFrame(args.frame ?? DEFAULT_FRAME)
  if (frame === null) {
    say(env.terminal, s.badFrame(args.frame ?? ''))
    return 2
  }
  return connectDevice(args.device, { speed, frame }, env, s, log)
}
