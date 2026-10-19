import type { ConfirmRequest, OpenTerminalResult } from '@aurigax-ai/ostia-extension-sdk'
import type {
  ExtensionCaller,
  OpenTerminalOptions,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { describe, expect, it, vi } from 'vitest'
import { serialCommands } from './commands'
import { CONNECT_USAGE } from './strings'

const DEVICE = '/dev/cu.usbserial-A10K2'

function setup(opened: OpenTerminalResult = { ok: true, paneId: 'pane-serial' }, approve = true) {
  const deps = {
    platform: 'darwin' as NodeJS.Platform,
    devices: vi.fn(() => [DEVICE]),
    execPath: '/Applications/Ostia.app/Contents/MacOS/Ostia',
    script: '/ext/serial/main.js',
    confirm: vi.fn<(req: ConfirmRequest) => Promise<boolean>>(async () => approve),
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
  it('opens a picker pane from the palette with no arguments and no dialog', async () => {
    const { commands, deps } = setup()
    const res = await commands.connect(null, caller('user', { locale: 'zh-Hant' }))
    expect(res).toEqual({ ok: true, data: { approved: true, pick: true, paneId: 'pane-serial' } })
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.openTerminal).toHaveBeenCalledWith({
      command: [
        'env',
        'ELECTRON_RUN_AS_NODE=1',
        deps.execPath,
        deps.script,
        'bridge',
        '--locale',
        'zh-Hant',
      ],
      workspaceId: 'ws-1',
      afterPaneId: 'pane-1',
      title: 'Serial',
    })
  })

  it('asks the human before a pane opens a device, then names device and speed in the title', async () => {
    const { commands, deps } = setup()
    const res = await commands.connect({ argv: [DEVICE, '9600', '7e1'] }, caller('pane'))
    expect(deps.confirm).toHaveBeenCalledTimes(1)
    expect(deps.confirm.mock.calls[0][0].detail).toContain(DEVICE)
    expect(deps.confirm.mock.calls[0][0].detail).toContain('9600 7E1')
    expect(res).toEqual({
      ok: true,
      data: { approved: true, device: DEVICE, speed: 9600, frame: '7E1', paneId: 'pane-serial' },
    })
    const opts = deps.openTerminal.mock.calls[0][0]
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
    ])
  })

  it('defaults to 115200 8N1', async () => {
    const { commands, deps } = setup()
    await commands.connect({ argv: [DEVICE] }, caller('user'))
    expect(deps.openTerminal.mock.calls[0][0].title).toBe('cu.usbserial-A10K2 115200 8N1')
  })

  it('opens nothing when the human denies', async () => {
    const { commands, deps } = setup(undefined, false)
    const res = await commands.connect({ argv: [DEVICE] }, caller('pane'))
    expect(res).toMatchObject({ ok: false, error: 'denied', data: { approved: false } })
    expect(deps.openTerminal).not.toHaveBeenCalled()
  })

  it('refuses bad devices, speeds, frames and extra arguments before asking', async () => {
    const { commands, deps } = setup()
    const cases: [string[], string][] = [
      [['/dev/disk0'], 'is not a serial device'],
      [['/dev/ttyUSB0'], 'is not a serial device'],
      [[DEVICE, '12345'], 'not a supported speed'],
      [[DEVICE, '115200', '9Z9'], 'is not a frame'],
      [[DEVICE, '115200', '8N1', 'x'], CONNECT_USAGE],
    ]
    for (const [argv, message] of cases) {
      const res = await commands.connect({ argv }, caller('pane'))
      expect(res, argv.join(' ')).toMatchObject({ ok: false, error: 'invalid-args' })
      expect(res.ok ? '' : res.message).toContain(message)
    }
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.openTerminal).not.toHaveBeenCalled()
  })

  it('reports a terminal that could not open', async () => {
    const { commands } = setup({ ok: false, error: 'rate-limited' })
    const res = await commands.connect({ argv: [DEVICE] }, caller('user'))
    expect(res).toMatchObject({ ok: false, error: 'not-opened' })
    expect(res.ok ? '' : res.message).toContain('rate-limited')
  })

  it('refuses a sandboxed caller', async () => {
    const { commands, deps } = setup()
    const res = await commands.connect({ argv: [DEVICE] }, caller('pane', { sandboxed: true }))
    expect(res).toMatchObject({ ok: false, error: 'sandboxed' })
    expect(deps.openTerminal).not.toHaveBeenCalled()
  })
})
