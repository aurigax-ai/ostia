import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OpenTerminalResult } from '@aurigax-ai/ostia-extension-sdk'
import type {
  ExtensionCaller,
  OpenTerminalOptions,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { describe, expect, it, vi } from 'vitest'
import { serialCommands } from './commands'
import { CONNECT_USAGE } from './strings'

const DEVICE = '/dev/cu.usbserial-A10K2'
const LOG_DIR = '/Users/me/Library/Application Support/Ostia/extension-data/serial/logs'

function setup(opened: OpenTerminalResult = { ok: true, paneId: 'pane-serial' }) {
  const deps = {
    platform: 'darwin' as NodeJS.Platform,
    logDir: () => LOG_DIR,
    prepareLogDir: vi.fn<(dir: string) => void>(),
    reveal: vi.fn<(dir: string) => Promise<string | null>>(async () => null),
    devices: vi.fn(() => [DEVICE]),
    execPath: '/Applications/Ostia.app/Contents/MacOS/Ostia',
    script: '/ext/serial/main.js',
    openTerminal: vi.fn<(opts: OpenTerminalOptions) => Promise<OpenTerminalResult>>(
      async () => opened,
    ),
  }
  return { deps, commands: serialCommands(deps) }
}

function caller(kind: 'pane' | 'user', extra: Partial<ExtensionCaller> = {}): ExtensionCaller {
  return { kind, paneId: 'pane-1', workspaceId: 'ws-1', capabilities: [], ...extra }
}

describe('serial ls', () => {
  it('returns the device list', async () => {
    const { commands } = setup()
    expect(await commands.ls(null, caller('pane'))).toEqual({
      ok: true,
      data: { devices: [DEVICE] },
    })
  })

  it('refuses a sandboxed caller and an unsupported platform', async () => {
    const { commands, deps } = setup()
    const sandboxed = await commands.ls(null, caller('pane', { sandboxed: true }))
    expect(sandboxed).toMatchObject({ ok: false, error: 'sandboxed' })
    expect(deps.devices).not.toHaveBeenCalled()
    const other = serialCommands({ ...deps, platform: 'win32' })
    expect(await other.ls(null, caller('user'))).toMatchObject({ ok: false, error: 'unsupported' })
  })
})

describe('serial connect', () => {
  it('opens a picker pane from the palette with no arguments', async () => {
    const { commands, deps } = setup()
    const res = await commands.connect(null, caller('user', { locale: 'zh-Hant' }))
    expect(res).toEqual({ ok: true, data: { pick: true, paneId: 'pane-serial' } })
    expect(deps.openTerminal).toHaveBeenCalledWith({
      command: [
        'env',
        'ELECTRON_RUN_AS_NODE=1',
        deps.execPath,
        deps.script,
        'bridge',
        '--locale',
        'zh-Hant',
        '--log-dir',
        LOG_DIR,
      ],
      workspaceId: 'ws-1',
      afterPaneId: 'pane-1',
      title: 'Serial',
    })
  })

  it('lets an agent open a device at once and answers the new pane id', async () => {
    const { commands, deps } = setup()
    const res = await commands.connect({ argv: [DEVICE, '9600', '7e1'] }, caller('pane'))
    expect(res).toEqual({
      ok: true,
      data: { device: DEVICE, speed: 9600, frame: '7E1', paneId: 'pane-serial' },
    })
    expect(deps.openTerminal).toHaveBeenCalledTimes(1)
    const opts = deps.openTerminal.mock.calls[0][0]
    expect(opts.workspaceId).toBe('ws-1')
    expect(opts.afterPaneId).toBe('pane-1')
    expect(opts.title).toBe('cu.usbserial-A10K2 9600 7E1')
    expect(opts.command).toEqual([
      'env',
      'ELECTRON_RUN_AS_NODE=1',
      deps.execPath,
      deps.script,
      'bridge',
      '--device',
      DEVICE,
      '--speed',
      '9600',
      '--frame',
      '7E1',
      '--log-dir',
      LOG_DIR,
    ])
  })

  it('keeps an agent log in the extension logs folder, by file name only', async () => {
    const { commands, deps } = setup()
    const res = await commands.connect(
      { argv: [DEVICE, '--log', 'sw1-2026.log', '9600'] },
      caller('pane'),
    )
    const log = join(LOG_DIR, 'sw1-2026.log')
    expect(res).toEqual({
      ok: true,
      data: { device: DEVICE, speed: 9600, frame: '8N1', log, paneId: 'pane-serial' },
    })
    expect(deps.openTerminal.mock.calls[0][0].command.slice(-4)).toEqual([
      '--log-dir',
      LOG_DIR,
      '--log',
      'sw1-2026.log',
    ])
    expect(deps.prepareLogDir).toHaveBeenCalledWith(LOG_DIR)
    const picked = await commands.connect({ argv: ['--log', 's.log'] }, caller('user'))
    expect(picked).toMatchObject({ ok: true, data: { pick: true, log: join(LOG_DIR, 's.log') } })
  })

  it('refuses a log path, so an agent cannot append to any other file', async () => {
    const { commands, deps } = setup()
    for (const name of [
      join(homedir(), '.zshrc'),
      '/tmp/s.log',
      '~/.zshrc',
      '../.zshrc',
      '..',
      '.',
      '.zshrc',
      'logs/s.log',
      'a\\b.log',
      '',
      'x'.repeat(129),
    ]) {
      const res = await commands.connect({ argv: [DEVICE, '--log', name] }, caller('pane'))
      expect(res, name).toMatchObject({ ok: false, error: 'invalid-args' })
      expect(res.ok ? '' : res.message).toContain('not a log file name')
    }
    expect(deps.openTerminal).not.toHaveBeenCalled()
    const noData = serialCommands({ ...deps, logDir: () => null })
    expect(
      await noData.connect({ argv: [DEVICE, '--log', 's.log'] }, caller('pane')),
    ).toMatchObject({ ok: false, error: 'unsupported' })
  })

  it('refuses a log in a logs folder that is a link or not the user’s, and opens without one', async () => {
    const { commands, deps } = setup()
    deps.prepareLogDir.mockImplementation(() => {
      throw new Error(`${LOG_DIR} is not a folder`)
    })
    const res = await commands.connect({ argv: [DEVICE, '--log', 's.log'] }, caller('pane'))
    expect(res).toMatchObject({ ok: false, error: 'unsupported' })
    expect(res.ok ? '' : res.message).toContain(`${LOG_DIR} is not a folder`)
    expect(deps.openTerminal).not.toHaveBeenCalled()
    expect(await commands.connect(null, caller('user'))).toMatchObject({ ok: true })
    expect(deps.openTerminal.mock.calls[0][0].command).not.toContain('--log-dir')
  })

  it('gives a pane caller the folder and opens no window', async () => {
    const { commands, deps } = setup()
    expect(await commands.logs(null, caller('pane'))).toEqual({ ok: true, data: { dir: LOG_DIR } })
    expect(deps.prepareLogDir).toHaveBeenCalledWith(LOG_DIR)
    expect(deps.reveal).not.toHaveBeenCalled()
  })

  it('reveals the logs folder in the file manager', async () => {
    const { commands, deps } = setup()
    expect(await commands.logs(null, caller('user'))).toEqual({ ok: true, data: { dir: LOG_DIR } })
    expect(deps.prepareLogDir).toHaveBeenCalledWith(LOG_DIR)
    expect(deps.reveal).toHaveBeenCalledWith(LOG_DIR)
    deps.reveal.mockResolvedValueOnce('spawn xdg-open ENOENT')
    expect(await commands.logs(null, caller('user'))).toMatchObject({
      ok: false,
      error: 'not-opened',
    })
    const noData = serialCommands({ ...deps, logDir: () => null })
    expect(await noData.logs(null, caller('user'))).toMatchObject({
      ok: false,
      error: 'unsupported',
    })
  })

  it('defaults to 115200 8N1', async () => {
    const { commands, deps } = setup()
    await commands.connect({ argv: [DEVICE] }, caller('user'))
    expect(deps.openTerminal.mock.calls[0][0].title).toBe('cu.usbserial-A10K2 115200 8N1')
  })

  it('opens only serial device paths, never other files', async () => {
    const { commands, deps } = setup()
    for (const device of [
      '/etc/passwd',
      '/dev/disk0',
      '/dev/tty.usbserial-A10K2',
      '/dev/ttyUSB0',
      '/dev/cu.usbserial/../../etc/passwd',
      'cu.usbserial-A10K2',
      `${DEVICE} `,
      '',
    ]) {
      const res = await commands.connect({ argv: [device] }, caller('pane'))
      expect(res, device).toMatchObject({ ok: false, error: 'invalid-args' })
      expect(res.ok ? '' : res.message).toContain('is not a serial device')
    }
    const linux = serialCommands({ ...deps, platform: 'linux' })
    for (const device of ['/dev/ttyS0', '/dev/sda', DEVICE, '/dev/ttyUSB0x']) {
      expect(await linux.connect({ argv: [device] }, caller('pane')), device).toMatchObject({
        ok: false,
        error: 'invalid-args',
      })
    }
    expect(await linux.connect({ argv: ['/dev/ttyACM0'] }, caller('pane'))).toMatchObject({
      ok: true,
      data: { device: '/dev/ttyACM0', paneId: 'pane-serial' },
    })
    expect(deps.openTerminal).toHaveBeenCalledTimes(1)
  })

  it('refuses bad speeds, frames and extra arguments', async () => {
    const { commands, deps } = setup()
    const cases: [string[], string][] = [
      [[DEVICE, '12345'], 'not a supported speed'],
      [[DEVICE, '115200', '9Z9'], 'is not a frame'],
      [[DEVICE, '115200', '8N1', 'x'], CONNECT_USAGE],
    ]
    for (const [argv, message] of cases) {
      const res = await commands.connect({ argv }, caller('pane'))
      expect(res, argv.join(' ')).toMatchObject({ ok: false, error: 'invalid-args' })
      expect(res.ok ? '' : res.message).toContain(message)
    }
    expect(deps.openTerminal).not.toHaveBeenCalled()
  })

  it('reports a terminal that could not open', async () => {
    const { commands } = setup({ ok: false, error: 'rate-limited' })
    const res = await commands.connect({ argv: [DEVICE] }, caller('pane'))
    expect(res).toMatchObject({ ok: false, error: 'not-opened' })
    expect(res.ok ? '' : res.message).toContain('rate-limited')
  })

  it('refuses a sandboxed caller, from a pane or the palette', async () => {
    const { commands, deps } = setup()
    for (const who of [caller('pane', { sandboxed: true }), caller('user', { sandboxed: true })]) {
      expect(await commands.connect({ argv: [DEVICE] }, who)).toMatchObject({
        ok: false,
        error: 'sandboxed',
      })
      expect(await commands.connect(null, who)).toMatchObject({ ok: false, error: 'sandboxed' })
    }
    expect(deps.openTerminal).not.toHaveBeenCalled()
  })
})
