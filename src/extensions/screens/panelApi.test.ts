import type {
  ConfirmRequest,
  OpenTerminalOptions,
  OpenTerminalResult,
} from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateGate } from './createGate'
import { installState } from './install'
import { type PanelScopeWithSandbox, panelHandlers } from './panelApi'
import { ScreensService } from './screensService'
import { type FakeScreens, fakeScreens, translate } from './testFake'
import { Viewers } from './viewers'

const scope = (workspaceId: string, sandboxed = false): PanelScopeWithSandbox => ({
  workspaceId,
  locale: 'en',
  panel: 'p',
  sandboxed,
})

const nothingOnPath = (): boolean => false
const onlyApt = (name: string): boolean => name === 'apt-get'

describe('the Screens panel', () => {
  let fake: FakeScreens
  let service: ScreensService
  let gate: CreateGate
  let confirm: ReturnType<typeof vi.fn<(req: ConfirmRequest) => Promise<boolean>>>
  let openTerminal: ReturnType<
    typeof vi.fn<(opts: OpenTerminalOptions) => Promise<OpenTerminalResult>>
  >
  let onPath: (name: string) => boolean
  let panel: ReturnType<typeof panelHandlers>

  beforeEach(() => {
    fake = fakeScreens()
    service = new ScreensService()
    confirm = vi.fn(async () => true)
    openTerminal = vi.fn(async () => ({ ok: true as const, paneId: 'p1' }))
    gate = new CreateGate({ confirm, card: () => ({ title: 't', message: 'm' }) })
    onPath = nothingOnPath
    panel = panelHandlers({
      service,
      gate,
      phones: () => null,
      translate,
      installState: (reason) => installState(reason, (name) => onPath(name)),
      confirm,
      openTerminal,
      sandboxDomains: async () => ({ ok: true, domains: ['example.test'] }),
      viewers: new Viewers(),
      now: () => Date.now(),
    })
  })

  afterEach(() => {
    service.stopAllNow()
    fake.restore()
  })

  const stateOf = async (workspaceId: string) => {
    const res = await panel.state({}, scope(workspaceId))
    return (res as { data: Record<string, unknown> }).data as {
      install: ReturnType<typeof installState>
      screens: { id: string }[]
      always: boolean
    }
  }

  it('SCX-C2 says the service is missing and installs it in a terminal only after the human confirms; system packages go through the system extension', async () => {
    onPath = onlyApt
    const state = await stateOf('A')
    expect(state.install).toMatchObject({ service: false, missingPrograms: ['Xvnc', 'xdotool'] })
    expect(await panel.install({}, scope('A'))).toEqual({ ok: true })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0].hostTerminal).toEqual([
      'pnpm',
      'add',
      '-g',
      '@aurigax-ai/screens@latest',
    ])
    expect(openTerminal).toHaveBeenCalledWith({
      command: ['pnpm', 'add', '-g', '@aurigax-ai/screens@latest'],
      host: true,
      workspaceId: 'A',
      title: 'Install screens',
    })
    expect(await panel.installSystem({}, scope('A'))).toEqual({ ok: true })
    const system = openTerminal.mock.calls[1][0].command
    expect(system.slice(0, 5)).toEqual([
      'ostia',
      'system',
      'install',
      'tigervnc-standalone-server',
      'xdotool',
    ])
    expect(system).toContain('--reason')
    expect(JSON.stringify(openTerminal.mock.calls)).not.toMatch(/\bnpm (install|i)\b|"npm"/)
  })

  it('SCX-C2 asks to update a screens older than 0.1.1 and starts no screen on it', async () => {
    fake.restore()
    fake = fakeScreens({ version: '0.1.0' })
    onPath = () => true
    const state = (await panel.state({}, scope('A'))) as {
      data: { install: Record<string, unknown> }
    }
    expect(state.data.install).toMatchObject({ service: true, version: '0.1.0', outdated: true })
    const created = await panel.create({}, scope('A'))
    expect(created).toMatchObject({ ok: false, error: 'outdated' })
    expect((created as { message: string }).message).toContain('0.1.1')
    expect(fake.screens()).toEqual([])
    expect(await panel.update({}, scope('A'))).toEqual({ ok: true })
    expect(confirm.mock.calls[0][0].hostTerminal).toEqual([
      'pnpm',
      'add',
      '-g',
      '@aurigax-ai/screens@latest',
    ])
    expect(openTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ command: ['pnpm', 'add', '-g', '@aurigax-ai/screens@latest'] }),
    )
  })

  it('SCX-C3 installs and types nothing when the human cancels the install card', async () => {
    confirm.mockResolvedValue(false)
    expect(await panel.install({}, scope('A'))).toMatchObject({ ok: false, error: 'cancelled' })
    expect(openTerminal).not.toHaveBeenCalled()
    expect((await stateOf('A')).install.service).toBe(false)
  })

  it('offers no system install when no package manager it knows is on PATH', async () => {
    expect((await stateOf('A')).install.systemInstall).toBeNull()
    expect(await panel.installSystem({}, scope('A'))).toMatchObject({ ok: false })
    expect(openTerminal).not.toHaveBeenCalled()
  })

  it('SCX-C10 lists only the screens of its own workspace and stops none of another', async () => {
    await panel.create({}, scope('A'))
    await panel.create({}, scope('B'))
    const a = await stateOf('A')
    const b = await stateOf('B')
    expect(a.screens).toHaveLength(1)
    expect(b.screens).toHaveLength(1)
    expect(a.screens[0].id).not.toBe(b.screens[0].id)
    expect(await panel.stop({ id: b.screens[0].id }, scope('A'))).toMatchObject({
      ok: false,
      error: 'refused',
    })
    expect(fake.screens()).toHaveLength(2)
    expect(confirm).not.toHaveBeenCalled()
    expect(JSON.stringify([a, b])).not.toMatch(/[0-9a-f]{64}/)
  })

  it('starts a sandboxed workspace screen from the panel with its domains', async () => {
    await panel.create({}, scope('S', true))
    expect(fake.screens()[0].allow).toEqual(['example.test'])
  })

  it('shows the standing grant and revokes it', async () => {
    await gate.allows('A', 'A')
    expect((await stateOf('A')).always).toBe(true)
    await panel.revoke({}, scope('A'))
    expect((await stateOf('A')).always).toBe(false)
  })
})
