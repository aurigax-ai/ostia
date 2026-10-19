import { spawn } from 'node:child_process'
import { constants, closeSync, openSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { ReadStream } from 'node:tty'
import { parseFlags } from '@aurigax-ai/ostia-extension-sdk'
import {
  COMMON_SPEEDS,
  DEFAULT_FRAME,
  DEFAULT_SPEED,
  type LineSettings,
  deviceGlobs,
  frameText,
  isSerialDevice,
  listDevices,
  parseFrame,
  parseSpeed,
  sttyArgs,
} from './settings'
import { QUIT_KEY, type Strings, stringsFor } from './strings'

export const BRIDGE_MODE = 'bridge'
const QUIT_BYTE = 0x1d
const STTY_TIMEOUT_MS = 5000
const OPEN_FLAGS = constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK

export interface BridgeArgs {
  locale?: string
  device?: string
  speed?: string
  frame?: string
}

export interface BridgeTerminal {
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
  const { flags } = parseFlags(argv, ['locale', 'device', 'speed', 'frame'])
  return { locale: flags.locale, device: flags.device, speed: flags.speed, frame: flags.frame }
}

export function bridgeCommand(
  execPath: string,
  script: string,
  locale: string | undefined,
  target?: { device: string; line: LineSettings },
): string[] {
  const argv = ['env', 'ELECTRON_RUN_AS_NODE=1', execPath, script, BRIDGE_MODE]
  if (locale) argv.push('--locale', locale)
  if (target) {
    argv.push('--device', target.device, '--speed', String(target.line.speed))
    argv.push('--frame', frameText(target.line.frame))
  }
  return argv
}

export function lineText(line: LineSettings): string {
  return `${line.speed} ${frameText(line.frame)}`
}

export function paneTitle(device: string, line: LineSettings): string {
  return `${device.slice(device.lastIndexOf('/') + 1)} ${lineText(line)}`
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined
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
  return s.openFailed(device, code ?? (err instanceof Error ? err.message : String(err)))
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

export async function pickTarget(
  env: BridgeEnv,
  s: Strings,
): Promise<{ device: string; line: LineSettings } | null> {
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
    if (device === null || speed === null || frame === null) {
      say(terminal, '')
      say(terminal, s.inputClosed)
      return null
    }
    return { device, line: { speed, frame } }
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

export async function connectDevice(
  device: string,
  line: LineSettings,
  env: BridgeEnv,
  s: Strings,
): Promise<number> {
  const { terminal, io } = env
  const opened = await openConfigured(device, line, env, s)
  if ('message' in opened) {
    say(terminal, opened.message)
    return 1
  }
  let port: DeviceStream
  try {
    port = io.stream(opened.fd)
  } catch (err) {
    io.close(opened.fd)
    say(terminal, openFailure(err, device, env.platform, s))
    return 1
  }
  terminal.output.write(`\x1b]2;${paneTitle(device, line)}\x07`)
  say(terminal, s.connected(device, lineText(line)))
  say(terminal, s.quitHint(QUIT_KEY))
  return new Promise((resolve) => {
    let stopped = false
    const finish = (code: number, message: string): void => {
      if (stopped) return
      stopped = true
      terminal.input.removeListener('data', onInput)
      terminal.input.setRawMode?.(false)
      terminal.input.pause()
      port.destroy()
      say(terminal, '')
      say(terminal, message)
      resolve(code)
    }
    const gone = (): void => finish(1, s.gone(device))
    const send = (data: Uint8Array): void => {
      if (data.length === 0 || stopped) return
      port.write(data, (err) => {
        if (err) gone()
      })
    }
    const onInput = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      const quit = bytes.indexOf(QUIT_BYTE)
      if (quit === -1) {
        send(bytes)
        return
      }
      send(bytes.subarray(0, quit))
      finish(0, s.closed(device))
    }
    port.on('data', (chunk) => {
      if (!stopped) terminal.output.write(chunk)
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
  if (args.device === undefined) {
    const picked = await pickTarget(env, s)
    if (!picked) return 1
    return connectDevice(picked.device, picked.line, env, s)
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
  return connectDevice(args.device, { speed, frame }, env, s)
}
