import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { build } from 'esbuild'
import type { IPty } from 'node-pty'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type BridgeEnv,
  type DeviceIo,
  type DeviceStream,
  bridgeCommand,
  connectDevice,
  nodeDeviceIo,
  openFailure,
  parseBridgeArgs,
  runBridge,
  runStty,
} from './bridge'
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

  write(data: Uint8Array, done: (err?: Error | null) => void): boolean {
    if (this.writeError) {
      const err = this.writeError
      queueMicrotask(() => done(err))
      return false
    }
    this.written.push(Buffer.from(data))
    queueMicrotask(() => done(null))
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
