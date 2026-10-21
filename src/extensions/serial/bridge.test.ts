import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { build } from 'esbuild'
import type { IPty } from 'node-pty'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type BridgeEnv,
  bridgeCommand,
  connectDevice,
  type DeviceIo,
  type DeviceStream,
  nodeDeviceIo,
  openFailure,
  parseBridgeArgs,
  runBridge,
  runStty,
} from './bridge'
import { prepareLogDir, SECRET_ECHO_RECORD, SECRET_SENT_RECORD } from './session'
import { parseFrame, sttyArgs } from './settings'
import { stringsFor } from './strings'

const DEVICE = '/dev/cu.usbserial-A10K2'
const s = stringsFor('en')
const LINE = { speed: 115200, frame: { dataBits: 8, parity: 'none', stopBits: 1 } } as const

function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

class FakePort extends EventEmitter implements DeviceStream {
  written: Buffer[] = []
  writeError: Error | null = null
  destroyed = false
  answer: ((data: Buffer) => string) | null = null

  write(data: Uint8Array, done: (err?: Error | null) => void): boolean {
    if (this.writeError) {
      const err = this.writeError
      queueMicrotask(() => done(err))
      return false
    }
    this.written.push(Buffer.from(data))
    queueMicrotask(() => done(null))
    const reply = this.answer?.(Buffer.from(data))
    if (reply) setTimeout(() => this.emit('data', Buffer.from(reply)), 1)
    return true
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    queueMicrotask(() => this.emit('close'))
  }
}

class FakeDevice implements DeviceIo {
  opened: { path: string; fd: number }[] = []
  closed: number[] = []
  configured: { fd: number; args: string[] }[] = []
  streamed: number[] = []
  openError: Error | null = null
  configureError: string | null = null
  port = new FakePort()
  private next = 10

  open = (path: string): number => {
    if (this.openError) throw this.openError
    const fd = this.next++
    this.opened.push({ path, fd })
    return fd
  }
  close = (fd: number): void => {
    this.closed.push(fd)
  }
  configure = async (fd: number, args: string[]): Promise<string | null> => {
    this.configured.push({ fd, args })
    return this.configureError
  }
  stream = (fd: number): DeviceStream => {
    this.streamed.push(fd)
    return this.port
  }
  emit(bytes: Buffer | null): void {
    if (bytes) this.port.emit('data', bytes)
    else this.port.emit('end')
  }
  sent(): string {
    return Buffer.concat(this.port.written).toString()
  }
}

function terminal() {
  const input = Object.assign(new PassThrough(), { setRawMode: vi.fn() })
  let text = ''
  const output = {
    write: (chunk: string | Uint8Array) => {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    },
  }
  return { input, output, text: () => text }
}

function env(device: FakeDevice, platform: NodeJS.Platform = 'darwin', names: string[] = []) {
  const term = terminal()
  const bridgeEnv: BridgeEnv = {
    platform,
    readdir: () => names,
    terminal: { input: term.input, output: term.output },
    io: device,
  }
  return { term, bridgeEnv }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('serial bridge arguments', () => {
  it('round-trips the pane command into bridge arguments', () => {
    const frame = parseFrame('7E2')
    if (!frame) throw new Error('frame')
    const argv = bridgeCommand('/bin/ostia', '/ext/main.js', 'zh-Hant', {
      device: DEVICE,
      line: { speed: 9600, frame },
    })
    expect(argv.slice(0, 5)).toEqual([
      'env',
      'ELECTRON_RUN_AS_NODE=1',
      '/bin/ostia',
      '/ext/main.js',
      'bridge',
    ])
    expect(parseBridgeArgs(argv.slice(5))).toEqual({
      locale: 'zh-Hant',
      device: DEVICE,
      speed: '9600',
      frame: '7E2',
    })
    expect(parseBridgeArgs([])).toEqual({})
    const logged = bridgeCommand('/bin/ostia', '/ext/main.js', undefined, undefined, {
      dir: LOG_DIR,
      name: 'sw1.log',
    })
    expect(parseBridgeArgs(logged.slice(5))).toMatchObject({ logDir: LOG_DIR, log: 'sw1.log' })
  })

  it('refuses bad arguments in the pane without opening anything', async () => {
    const device = new FakeDevice()
    for (const [args, message] of [
      [{ device: '/dev/disk0' }, 'is not a serial device'],
      [{ device: DEVICE, speed: '5' }, 'not a supported speed'],
      [{ device: DEVICE, frame: '8N9' }, 'is not a frame'],
    ] as const) {
      const { term, bridgeEnv } = env(device)
      expect(await runBridge(args, bridgeEnv)).toBe(2)
      expect(term.text()).toContain(message)
    }
    const { term, bridgeEnv } = env(device, 'win32')
    expect(await runBridge({ device: DEVICE }, bridgeEnv)).toBe(2)
    expect(term.text()).toContain('macOS and Linux only')
    expect(device.opened).toEqual([])
  })
})

describe('serial bridge errors', () => {
  it('explains busy, missing and forbidden devices', () => {
    expect(openFailure(errno('EBUSY'), DEVICE, 'darwin', s)).toContain('is busy')
    expect(openFailure(errno('ENOENT'), DEVICE, 'darwin', s)).toContain('does not exist')
    expect(openFailure(errno('ENXIO'), DEVICE, 'darwin', s)).toContain('does not exist')
    expect(openFailure(errno('EACCES'), '/dev/ttyUSB0', 'linux', s)).toContain('dialout')
    expect(openFailure(errno('EACCES'), DEVICE, 'darwin', s)).not.toContain('dialout')
    expect(openFailure(errno('EIO'), DEVICE, 'darwin', s)).toBe(`Could not open ${DEVICE}: EIO`)
  })

  it('prints a busy device in the pane and exits non-zero at once', async () => {
    const device = new FakeDevice()
    device.openError = errno('EBUSY')
    const { term, bridgeEnv } = env(device)
    expect(await runBridge({ device: DEVICE }, bridgeEnv)).toBe(1)
    expect(term.text()).toContain(`${DEVICE} is busy`)
    expect(term.input.setRawMode).not.toHaveBeenCalled()
  })

  it('closes the device when stty fails and says why', async () => {
    const device = new FakeDevice()
    device.configureError = 'unable to perform all requested operations'
    const { term, bridgeEnv } = env(device)
    expect(await runBridge({ device: DEVICE }, bridgeEnv)).toBe(1)
    expect(term.text()).toContain('Could not set the line settings')
    expect(term.text()).toContain('unable to perform all requested operations')
    expect(device.closed).toEqual([device.opened[0].fd])
    expect(device.streamed).toEqual([])
  })

  it('reports a device that goes away and gives the terminal back', async () => {
    const device = new FakeDevice()
    const { term, bridgeEnv } = env(device)
    const done = runBridge({ device: DEVICE }, bridgeEnv)
    await until(() => term.text().includes('Connected'))
    device.emit(null)
    expect(await done).toBe(1)
    expect(term.text()).toContain('went away')
    expect(term.input.setRawMode).toHaveBeenLastCalledWith(false)
    expect(device.port.destroyed).toBe(true)
  })

  it('stops when a write to the device fails', async () => {
    const device = new FakeDevice()
    device.port.writeError = errno('EIO')
    const { term, bridgeEnv } = env(device)
    const done = runBridge({ device: DEVICE }, bridgeEnv)
    await until(() => term.text().includes('Connected'))
    term.input.write('x')
    expect(await done).toBe(1)
    expect(term.text()).toContain('went away')
  })
})

describe('serial bridge forwarding', () => {
  it('configures the line on the open descriptor and streams it', async () => {
    const device = new FakeDevice()
    const { term, bridgeEnv } = env(device)
    const done = connectDevice(DEVICE, LINE, bridgeEnv, s)
    await until(() => term.text().includes('Connected'))
    expect(device.opened.map((o) => o.path)).toEqual([DEVICE])
    expect(device.configured).toEqual([{ fd: device.opened[0].fd, args: sttyArgs(LINE) }])
    expect(device.streamed).toEqual([device.opened[0].fd])
    expect(device.closed).toEqual([])
    expect(term.text()).toContain('\x1b]2;cu.usbserial-A10K2 115200 8N1\x07')
    expect(term.text()).toContain('Connected to /dev/cu.usbserial-A10K2 at 115200 8N1.')
    expect(term.text()).toContain('Ctrl-]')
    expect(term.input.setRawMode).toHaveBeenCalledWith(true)

    term.input.write('show version\r')
    device.emit(Buffer.from('Cumulus Linux 5.9\r\n'))
    await until(
      () => device.sent() === 'show version\r' && term.text().includes('Cumulus Linux 5.9'),
    )

    term.input.write(Buffer.from([0x61, 0x1d, 0x62]))
    expect(await done).toBe(0)
    expect(device.sent()).toBe('show version\ra')
    expect(term.text()).toContain('Disconnected from /dev/cu.usbserial-A10K2.')
    expect(term.input.setRawMode).toHaveBeenLastCalledWith(false)
    expect(device.port.destroyed).toBe(true)
    device.emit(Buffer.from('late'))
    expect(term.text()).not.toContain('late')
  })
})

describe('serial bridge picker', () => {
  const names = ['cu.Bluetooth-Incoming-Port', 'cu.usbserial-A10K2']

  it('says so when there is no device', async () => {
    const device = new FakeDevice()
    const { term, bridgeEnv } = env(device, 'linux', ['ttyS0'])
    expect(await runBridge({}, bridgeEnv)).toBe(1)
    expect(term.text()).toContain('No serial device found (looked for /dev/ttyUSB*, /dev/ttyACM*)')
  })

  it('takes the defaults on Enter and connects to the first USB device', async () => {
    const device = new FakeDevice()
    const { term, bridgeEnv } = env(device, 'darwin', names)
    const done = runBridge({}, bridgeEnv)
    term.input.write('\n\n\n')
    await until(() => term.text().includes('Connected'))
    expect(term.text()).toContain('  1) /dev/cu.usbserial-A10K2')
    expect(term.text()).toContain('  2) /dev/cu.Bluetooth-Incoming-Port')
    expect(term.text()).toContain(
      'Speed (9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600) [115200]: ',
    )
    expect(term.text()).toContain('Frame, data bits/parity/stop bits like 8N1 or 7E1 [8N1]: ')
    expect(device.configured[0].args).toEqual(sttyArgs(LINE))
    term.input.write(Buffer.from([0x1d]))
    expect(await done).toBe(0)
  })

  it('asks again after a bad answer and takes a custom frame', async () => {
    const device = new FakeDevice()
    const { term, bridgeEnv } = env(device, 'darwin', names)
    const done = runBridge({ locale: 'en' }, bridgeEnv)
    term.input.write('7\n2\n12345\n9600\n8Q1\n7e1\n')
    await until(() => term.text().includes('Connected'))
    expect(term.text()).toContain('7 is not a serial device')
    expect(term.text()).toContain('12345 is not a supported speed')
    expect(term.text()).toContain('8Q1 is not a frame')
    expect(device.opened[0].path).toBe('/dev/cu.Bluetooth-Incoming-Port')
    expect(term.text()).toContain('at 9600 7E1')
    term.input.write(Buffer.from([0x1d]))
    expect(await done).toBe(0)
  })

  it('opens nothing when the input ends before the answers', async () => {
    const device = new FakeDevice()
    const { term, bridgeEnv } = env(device, 'darwin', names)
    const done = runBridge({ locale: 'zh-Hant' }, bridgeEnv)
    term.input.end('1\n')
    expect(await done).toBe(1)
    expect(term.text()).toContain('沒有收到回答')
    expect(device.opened).toEqual([])
  })
})

const FAST = { logFlushMs: 20, loopQuietMs: 40, secretGraceMs: 300 }
const LOG_DIR = '/var/log/serial'
const LOG = `${LOG_DIR}/switch.log`
const PASSWORD = 'hunter2-Secret'

function memoryLog() {
  const files: { path: string; text: string; closed: boolean }[] = []
  const openLog = (path: string) => {
    const file = { path, text: '', closed: false }
    files.push(file)
    return {
      write: (text: string) => {
        file.text += text
      },
      close: () => {
        file.closed = true
      },
    }
  }
  return { files, openLog }
}

function consoleAnswer(prompt: string) {
  return (data: Buffer): string => {
    const text = data.toString()
    return text.replace(/\r/g, `\r\n${prompt}`)
  }
}

function loopback(data: Buffer): string {
  return data.toString('latin1')
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('serial session log and secret input', () => {
  it('logs the session in both directions but never the secret input or its echo', async () => {
    const device = new FakeDevice()
    let prompt = 'Password: '
    device.port.answer = (data) => {
      const reply = consoleAnswer(prompt)(data)
      if (data.includes(0x0d)) prompt = 'switch# '
      return reply
    }
    const memory = memoryLog()
    const { term, bridgeEnv } = env(device)
    bridgeEnv.openLog = memory.openLog
    bridgeEnv.timing = FAST
    const done = connectDevice(DEVICE, LINE, bridgeEnv, s, LOG)
    await until(() => term.text().includes('Connected'))
    expect(term.text()).toContain(`Logging this session to ${LOG}.`)
    expect(term.text()).toContain('Press Ctrl-\\ before typing a password')

    term.input.write('admin\r')
    await until(() => term.text().includes('Password: '))
    term.input.write(Buffer.from([0x1c]))
    await until(() => term.text().includes('[Secret input on'))
    expect(term.text()).toContain('\x1b]2;🔒 cu.usbserial-A10K2 115200 8N1\x07')
    for (const ch of PASSWORD) term.input.write(ch)
    term.input.write('\r')
    await until(() => term.text().includes('switch# '))
    term.input.write('show version\r')
    await until(() => term.text().split('switch# ').length > 2)
    term.input.write(Buffer.from([0x1d]))
    expect(await done).toBe(0)

    expect(device.sent()).toBe(`admin\r${PASSWORD}\rshow version\r`)
    expect(term.text()).toContain('[Secret input off.]')
    expect(term.text()).toContain('\x1b]2;cu.usbserial-A10K2 115200 8N1\x07')
    expect(term.text()).not.toContain(PASSWORD)
    expect(term.text()).not.toContain('hunter')
    expect(term.text()).not.toContain('network (Ethernet) port')

    const [file] = memory.files
    expect(file.path).toBe(LOG)
    expect(file.closed).toBe(true)
    expect(file.text).not.toContain('hunter')
    const records = file.text.trimEnd().split('\n')
    for (const record of records) expect(record).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z [<>#] /)
    const bodies = records.map((r) => r.slice(r.indexOf(' ') + 1))
    const stream = (mark: '<' | '>') =>
      bodies
        .filter((body) => body.startsWith(`${mark} `))
        .map((body) => body.slice(2))
        .join('')
    const sent = stream('>')
    const received = stream('<')
    expect(bodies[0]).toBe(`# connected ${DEVICE} 115200 8N1`)
    expect(bodies).toContain('> admin\\r')
    expect(sent).toContain('admin\\r')
    expect(received).toContain('admin\\r\\n')
    expect(bodies).toContain(`> ${SECRET_SENT_RECORD}`)
    expect(bodies).toContain(`< ${SECRET_ECHO_RECORD}`)
    expect(bodies).toContain('> show version\\r')
    expect(sent).toContain('show version\\r')
    expect(received).toContain('switch# show version\\r\\n')
    expect(bodies.at(-1)).toBe('# disconnected')
    expect(sent.indexOf(SECRET_SENT_RECORD)).toBeGreaterThan(sent.indexOf('admin\\r'))
    expect(sent.indexOf(SECRET_SENT_RECORD)).toBeLessThan(sent.indexOf('show version\\r'))
    expect(received).toContain('Password: ')
    expect(received.indexOf(SECRET_ECHO_RECORD)).toBeGreaterThan(received.indexOf('Password: '))
    expect(received.indexOf(SECRET_ECHO_RECORD)).toBeLessThan(
      received.indexOf('switch# show version'),
    )
  })

  it('hides a password that arrives in one chunk with its echo, and Ctrl-\\ stops early', async () => {
    const device = new FakeDevice()
    device.port.answer = consoleAnswer('switch# ')
    const memory = memoryLog()
    const { term, bridgeEnv } = env(device)
    bridgeEnv.openLog = memory.openLog
    bridgeEnv.timing = FAST
    const done = connectDevice(DEVICE, LINE, bridgeEnv, s, LOG)
    await until(() => term.text().includes('Connected'))
    term.input.write(`\x1c${PASSWORD}\rdate\r`)
    await until(() => term.text().includes('date\r\nswitch# '))
    term.input.write(`\x1c${PASSWORD}\x1c`)
    await settle(20)
    device.emit(Buffer.from('x'))
    await settle(FAST.secretGraceMs + 50)
    device.emit(Buffer.from('after'))
    await until(() => term.text().includes('after'))
    term.input.write(Buffer.from([0x1d]))
    expect(await done).toBe(0)
    expect(device.sent()).toBe(`${PASSWORD}\rdate\r${PASSWORD}`)
    expect(term.text()).not.toContain('hunter')
    expect(memory.files[0].text).not.toContain('hunter')
    expect(memory.files[0].text).toContain('> date\\r')
  })

  it('writes a real log file the owner alone can read, and appends to it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'serial-log-'))
    try {
      const path = join(dir, 'console.log')
      for (const command of ['first\r', 'second\r']) {
        const device = new FakeDevice()
        device.port.answer = consoleAnswer('# ')
        const { term, bridgeEnv } = env(device)
        bridgeEnv.timing = FAST
        const done = connectDevice(DEVICE, LINE, bridgeEnv, s, path)
        await until(() => term.text().includes('Connected'))
        term.input.write(`\x1c${PASSWORD}\r`)
        term.input.write(command)
        await until(() => term.text().includes(command.replace('\r', '\r\n# ')))
        term.input.write(Buffer.from([0x1d]))
        expect(await done).toBe(0)
      }
      const text = readFileSync(path, 'utf8')
      expect(text).toContain('> first\\r')
      expect(text).toContain('> second\\r')
      expect(text.match(/# connected/g)).toHaveLength(2)
      expect(text).not.toContain('hunter')
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('takes only a log file name inside the logs folder, and reports a log that cannot be opened', async () => {
    const device = new FakeDevice()
    for (const [args, message] of [
      [{ device: DEVICE, log: '/Users/justin/.zshrc', logDir: LOG_DIR }, 'not a log file name'],
      [{ device: DEVICE, log: '../.zshrc', logDir: LOG_DIR }, 'not a log file name'],
      [{ device: DEVICE, log: 'switch.log' }, 'no data folder'],
      [{ device: DEVICE, log: 'switch.log', logDir: 'logs' }, 'no data folder'],
    ] as const) {
      const { term, bridgeEnv } = env(device)
      expect(await runBridge(args, bridgeEnv), args.log).toBe(2)
      expect(term.text()).toContain(message)
    }
    expect(device.opened).toEqual([])
    const failing = env(device)
    failing.bridgeEnv.openLog = () => {
      throw errno('EACCES')
    }
    expect(
      await runBridge({ device: DEVICE, log: 'switch.log', logDir: LOG_DIR }, failing.bridgeEnv),
    ).toBe(1)
    expect(failing.term.text()).toContain(`Could not write the session log ${LOG}: EACCES`)
    expect(device.closed).toEqual([device.opened[0].fd])
    expect(device.streamed).toEqual([])
  })

  it('asks for a log file name in the picker and refuses a path typed there', async () => {
    const device = new FakeDevice()
    const memory = memoryLog()
    const { term, bridgeEnv } = env(device, 'darwin', ['cu.usbserial-A10K2'])
    bridgeEnv.openLog = memory.openLog
    const done = runBridge({ logDir: LOG_DIR }, bridgeEnv)
    term.input.write('\n\n\n/Users/justin/.zshrc\n~/.zshrc\nlogs/a.log\n..\nswitch.log\n')
    await until(() => term.text().includes('Connected'))
    expect(term.text()).toContain(`Session log file name, kept in ${LOG_DIR} (Enter for none): `)
    for (const bad of ['/Users/justin/.zshrc', '~/.zshrc', 'logs/a.log', '..']) {
      expect(term.text()).toContain(`${bad} is not a log file name`)
    }
    expect(memory.files.map((f) => f.path)).toEqual([LOG])
    term.input.write(Buffer.from([0x1d]))
    expect(await done).toBe(0)
  })

  it('does not ask for a log in the picker without a logs folder', async () => {
    const device = new FakeDevice()
    const { term, bridgeEnv } = env(device, 'darwin', ['cu.usbserial-A10K2'])
    const done = runBridge({}, bridgeEnv)
    term.input.write('\n\n\n')
    await until(() => term.text().includes('Connected'))
    expect(term.text()).not.toContain('Session log')
    term.input.write(Buffer.from([0x1d]))
    expect(await done).toBe(0)
  })
})

describe('serial session log file safety', () => {
  let dir = ''

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  async function open(path: string, device = new FakeDevice()) {
    const { term, bridgeEnv } = env(device)
    bridgeEnv.timing = FAST
    const done = connectDevice(DEVICE, LINE, bridgeEnv, s, path)
    const settled = await Promise.race([done, until(() => term.text().includes('Connected'))])
    if (typeof settled === 'number') return { code: settled, term, device }
    term.input.write(Buffer.from([0x1d]))
    return { code: await done, term, device }
  }

  it('refuses a symbolic link and anything but a regular file, and closes the device', async () => {
    dir = mkdtempSync(join(tmpdir(), 'serial-log-'))
    const target = join(dir, 'rc')
    writeFileSync(target, 'export PATH\n')
    const link = join(dir, 'link.log')
    symlinkSync(target, link)
    const folder = join(dir, 'folder.log')
    mkdirSync(folder)
    const hard = join(dir, 'hard.log')
    linkSync(target, hard)
    chmodSync(target, 0o644)
    for (const path of [link, folder, hard]) {
      const { code, term, device } = await open(path)
      expect(code, path).toBe(1)
      expect(term.text()).toContain(`Could not write the session log ${path}`)
      expect(device.closed).toEqual([device.opened[0].fd])
    }
    expect(readFileSync(target, 'utf8')).toBe('export PATH\n')
    expect(statSync(target).mode & 0o777).toBe(0o644)
  })

  it('creates no log when the device cannot be opened', async () => {
    dir = mkdtempSync(join(tmpdir(), 'serial-log-'))
    const path = join(dir, 'never.log')
    const device = new FakeDevice()
    device.openError = errno('EBUSY')
    const { code, term } = await open(path, device)
    expect(code).toBe(1)
    expect(term.text()).toContain('is busy')
    expect(existsSync(path)).toBe(false)
  })

  it('narrows an existing log file to the owner', async () => {
    dir = mkdtempSync(join(tmpdir(), 'serial-log-'))
    const path = join(dir, 'old.log')
    writeFileSync(path, 'earlier\n')
    chmodSync(path, 0o644)
    expect((await open(path)).code).toBe(0)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toMatch(/^earlier\n.*# connected/)
  })

  it('writes the name the human types in the picker into the logs folder', async () => {
    dir = mkdtempSync(join(tmpdir(), 'serial-log-'))
    const device = new FakeDevice()
    const { term, bridgeEnv } = env(device, 'darwin', ['cu.usbserial-A10K2'])
    const done = runBridge({ logDir: dir }, bridgeEnv)
    term.input.write('\n\n\npicked.log\n')
    await until(() => term.text().includes('Connected'))
    term.input.write(Buffer.from([0x1d]))
    expect(await done).toBe(0)
    expect(readFileSync(join(dir, 'picked.log'), 'utf8')).toContain('# disconnected')
  })

  it('makes the logs folder private and refuses a link, a file or another owner', () => {
    dir = mkdtempSync(join(tmpdir(), 'serial-log-'))
    const logs = join(dir, 'logs')
    prepareLogDir(logs)
    expect(statSync(logs).mode & 0o777).toBe(0o700)
    chmodSync(logs, 0o755)
    prepareLogDir(logs)
    expect(statSync(logs).mode & 0o777).toBe(0o700)
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    const link = join(dir, 'link')
    symlinkSync(elsewhere, link)
    expect(() => prepareLogDir(link)).toThrow('is not a folder')
    const file = join(dir, 'file')
    writeFileSync(file, '')
    expect(() => prepareLogDir(file)).toThrow()
    const uid = statSync(logs).uid
    expect(() => prepareLogDir(logs, uid + 1)).toThrow('belongs to another user')
  })
})

describe('serial secret echo at a low speed', () => {
  it('keeps hiding while the secret bytes are still on the line', async () => {
    const device = new FakeDevice()
    const memory = memoryLog()
    const { term, bridgeEnv } = env(device)
    bridgeEnv.openLog = memory.openLog
    bridgeEnv.timing = { ...FAST, secretGraceMs: 100 }
    const slow = { speed: 300, frame: LINE.frame }
    const done = connectDevice(DEVICE, slow, bridgeEnv, s, LOG)
    await until(() => term.text().includes('Connected'))
    term.input.write(`\x1c${PASSWORD}\r`)
    await settle(300)
    device.emit(Buffer.from(PASSWORD))
    await settle(400)
    device.emit(Buffer.from('later'))
    await until(() => term.text().includes('later'))
    term.input.write(Buffer.from([0x1d]))
    expect(await done).toBe(0)
    expect(term.text()).not.toContain('hunter')
    expect(memory.files[0].text).not.toContain('hunter')
  })
})

describe('serial echo-loop hint', () => {
  const hint = 'The cable may be in a network (Ethernet) port'

  async function session(answer: ((data: Buffer) => string) | null, typed: string[]) {
    const device = new FakeDevice()
    device.port.answer = answer
    const { term, bridgeEnv } = env(device)
    bridgeEnv.timing = FAST
    const done = connectDevice(DEVICE, LINE, bridgeEnv, s)
    await until(() => term.text().includes('Connected'))
    for (const text of typed) {
      term.input.write(text)
      await settle(5)
    }
    await settle(FAST.loopQuietMs * 4)
    const text = term.text()
    term.input.write(Buffer.from([0x1d]))
    expect(await done).toBe(0)
    return text
  }

  it('shows the hint once when every byte comes straight back', async () => {
    const text = await session(loopback, ['\r', '\r', 'show\r', '\r'])
    expect(text).toContain(hint)
    expect(text.split(hint)).toHaveLength(2)
  })

  it('shows the hint for a looped password too, without showing the password', async () => {
    const text = await session(loopback, ['\r', `\x1c${PASSWORD}\r`, '\r'])
    expect(text).toContain(hint)
    expect(text).not.toContain('hunter')
  })

  it('stays quiet for a console that echoes and answers Enter with its own output', async () => {
    expect(await session(consoleAnswer('switch# '), ['\r', '\r', 'show\r', '\r'])).not.toContain(
      hint,
    )
    expect(
      await session((data) => data.toString().replace(/\r/g, '\r\n'), ['\r\r\r\r']),
    ).not.toContain(hint)
  })

  it('stays quiet before Enter, below the byte count, and for a silent or chatty device', async () => {
    expect(await session(loopback, ['abcdef'])).not.toContain(hint)
    expect(await session(loopback, ['\r', '\r'])).not.toContain(hint)
    expect(await session(null, ['\r', '\r', 'show\r', '\r'])).not.toContain(hint)
    const device = new FakeDevice()
    device.port.answer = loopback
    const { term, bridgeEnv } = env(device)
    bridgeEnv.timing = FAST
    const done = connectDevice(DEVICE, LINE, bridgeEnv, s)
    await until(() => term.text().includes('Connected'))
    device.emit(Buffer.from('U-Boot 2023.04\r\n'))
    term.input.write('\r\r\r\r')
    await settle(FAST.loopQuietMs * 4)
    expect(term.text()).not.toContain(hint)
    term.input.write(Buffer.from([0x1d]))
    expect(await done).toBe(0)
  })
})

const nodePty = await import('node-pty').catch(() => null)

function spawnsPty(): boolean {
  try {
    nodePty?.spawn('/bin/sh', ['-c', 'exit 0'], {}).kill()
    return nodePty !== null
  } catch {
    return false
  }
}

const ptyRequired = process.env.CI === 'true' && process.platform === 'linux'

describe.skipIf(!ptyRequired && !spawnsPty())('serial bridge on a pseudo-terminal', () => {
  let pty: IPty | null = null

  afterEach(() => {
    pty?.kill()
    pty = null
  })

  async function slave(): Promise<{ pty: IPty; path: string; seen: () => string }> {
    if (!nodePty) throw new Error('node-pty')
    const term = nodePty.spawn('/bin/sh', ['-c', 'tty; exec sleep 60'], { cols: 80, rows: 24 })
    pty = term
    let out = ''
    term.onData((data) => {
      out += data
    })
    await until(() => /\/dev\/\S+\r?\n/.test(out))
    const path = /(\/dev\/\S+)\r?\n/.exec(out)?.[1] ?? ''
    const start = out.length
    return { pty: term, path, seen: () => out.slice(start) }
  }

  it('forwards both ways between the pane and the device, and reports the device going away', async () => {
    const device = await slave()
    const { term, bridgeEnv } = env(new FakeDevice(), process.platform)
    bridgeEnv.io = { ...nodeDeviceIo, configure: (fd) => runStty(fd, ['raw', '-echo']) }
    const done = connectDevice(device.path, LINE, bridgeEnv, s)
    await until(() => term.text().includes('Connected'))

    term.input.write('hello device\r')
    await until(() => device.seen().includes('hello device'))
    device.pty.write('hello pane\r')
    await until(() => term.text().includes('hello pane'))

    device.pty.kill('SIGKILL')
    pty = null
    expect(await done).toBe(1)
    expect(term.text()).toContain('went away')
  })

  it('shows the echo-loop hint on a terminal device that sends every byte back', async () => {
    const device = await slave()
    device.pty.onData((data) => device.pty.write(data))
    const { term, bridgeEnv } = env(new FakeDevice(), process.platform)
    bridgeEnv.io = { ...nodeDeviceIo, configure: (fd) => runStty(fd, ['raw', '-echo']) }
    bridgeEnv.timing = FAST
    const done = connectDevice(device.path, LINE, bridgeEnv, s)
    await until(() => term.text().includes('Connected'))
    term.input.write('show\r\r')
    await until(() => term.text().includes('network (Ethernet) port'))
    term.input.write(Buffer.from([0x1d]))
    expect(await done).toBe(0)
  })

  it.runIf(process.platform === 'darwin')(
    'applies the full stty arguments to a terminal device',
    async () => {
      const device = await slave()
      const fd = nodeDeviceIo.open(device.path)
      try {
        expect(
          await runStty(
            fd,
            sttyArgs({ speed: 9600, frame: { dataBits: 7, parity: 'even', stopBits: 2 } }),
          ),
        ).toBeNull()
      } finally {
        nodeDeviceIo.close(fd)
      }
    },
  )

  it('reports stty errors', async () => {
    const device = await slave()
    const fd = nodeDeviceIo.open(device.path)
    try {
      expect(await runStty(fd, ['no-such-setting'])).toMatch(/no-such-setting/)
    } finally {
      nodeDeviceIo.close(fd)
    }
  })

  describe('as its own process', () => {
    let dir = ''
    let bundle = ''
    let child: ChildProcess | null = null

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'serial-bridge-'))
      const entry = join(dir, 'entry.ts')
      writeFileSync(
        entry,
        [
          `import { connectDevice, nodeDeviceIo, runStty } from ${JSON.stringify(join(__dirname, 'bridge.ts'))}`,
          `import { stringsFor } from ${JSON.stringify(join(__dirname, 'strings.ts'))}`,
          'const line = { speed: 115200, frame: { dataBits: 8, parity: "none", stopBits: 1 } } as const',
          'const io = { ...nodeDeviceIo, configure: (fd: number) => runStty(fd, ["raw", "-echo"]) }',
          'const terminal = { input: process.stdin, output: process.stdout }',
          'const env = { platform: process.platform, readdir: () => [], terminal, io }',
          'connectDevice(process.argv[2], line, env, stringsFor("en")).then((code) => process.exit(code))',
        ].join('\n'),
      )
      bundle = join(dir, 'bridge.cjs')
      await build({
        entryPoints: [entry],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'warning',
      })
    })

    afterEach(() => {
      child?.kill('SIGKILL')
      child = null
    })

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('exits at once on Ctrl-] while the device is quiet and lets the device be opened again', async () => {
      const device = await slave()
      const proc = spawn(process.execPath, [bundle, device.path], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child = proc
      let out = ''
      proc.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString()
      })
      proc.stderr?.on('data', (chunk: Buffer) => {
        out += chunk.toString()
      })
      const exited = new Promise<number | null>((resolve) =>
        proc.on('exit', (code) => resolve(code)),
      )
      await until(() => out.includes('Connected'))

      proc.stdin?.write('ping\r')
      await until(() => device.seen().includes('ping'))
      device.pty.write('pong\r')
      await until(() => out.includes('pong'))

      await new Promise((resolve) => setTimeout(resolve, 200))
      proc.stdin?.write(Buffer.from([0x1d]))
      const code = await Promise.race([
        exited,
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3000)),
      ])
      expect(code).toBe(0)
      expect(out).toContain('Disconnected from')
      child = null

      const fd = nodeDeviceIo.open(device.path)
      nodeDeviceIo.close(fd)
    })
  })
})
