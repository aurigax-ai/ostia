import { describe, expect, it, vi } from 'vitest'
import type { InstallMethod, UpdateRunState } from '../shared/installMethod'
import { type UpdateTerminalRequest, createUpdateRunner } from './updateRun'

function harness(method: InstallMethod, paneId: string | null = 'pane-1') {
  const opened: UpdateTerminalRequest[] = []
  const states: UpdateRunState[] = []
  let resolveOpen: ((id: string | null) => void) | null = null
  const runner = createUpdateRunner({
    method: () => method,
    title: () => 'Update Ostia',
    openTerminal: (req) => {
      opened.push(req)
      return new Promise((resolve) => {
        resolveOpen = resolve
      })
    },
    hostToken: vi.fn((command) => `token:${command}`),
    onChange: (s) => states.push(s),
  })
  const open = (): void => resolveOpen?.(paneId)
  return { runner, opened, states, open }
}

describe('createUpdateRunner', () => {
  it('opens one terminal with the fixed command and a host token for a managed install', async () => {
    const h = harness('apt')
    const start = h.runner.start()
    h.open()
    expect(await start).toBe('opened')
    expect(h.opened).toEqual([
      {
        command: 'sudo apt update && sudo apt install --only-upgrade ostia',
        hostToken: 'token:sudo apt update && sudo apt install --only-upgrade ostia',
        title: 'Update Ostia',
      },
    ])
    expect(h.runner.state()).toEqual({ status: 'running' })
  })

  it('does nothing for an install without a package manager', async () => {
    for (const method of ['local', 'tarball', 'dmg', 'dev'] as const) {
      const h = harness(method)
      expect(await h.runner.start()).toBe('no-action')
      expect(h.opened).toEqual([])
    }
  })

  it('refuses a second run while one is opening or running', async () => {
    const h = harness('brew')
    const first = h.runner.start()
    expect(await h.runner.start()).toBe('busy')
    h.open()
    await first
    expect(await h.runner.start()).toBe('busy')
    expect(h.opened).toHaveLength(1)
  })

  it('is done after the command in its pane ends with code 0, failed otherwise', async () => {
    const h = harness('apt')
    const start = h.runner.start()
    h.open()
    await start
    h.runner.paneState('other', false, 0)
    h.runner.paneState('pane-1', false, undefined)
    h.runner.paneState('pane-1', true, undefined)
    expect(h.runner.state()).toEqual({ status: 'running' })
    h.runner.paneState('pane-1', false, 0)
    expect(h.runner.state()).toEqual({ status: 'done' })
    expect(h.states).toEqual([{ status: 'running' }, { status: 'done' }])

    const f = harness('apt')
    const s2 = f.runner.start()
    f.open()
    await s2
    f.runner.paneState('pane-1', false, 100)
    expect(f.runner.state()).toEqual({ status: 'failed', exitCode: 100 })
    const again = f.runner.start()
    f.open()
    expect(await again).toBe('opened')
  })

  it('fails when its pane closes before the command ends and allows a new run', async () => {
    const h = harness('apt')
    const start = h.runner.start()
    h.open()
    await start
    h.runner.paneClosed('pane-1')
    expect(h.runner.state()).toEqual({ status: 'failed', exitCode: null })
    const again = h.runner.start()
    h.open()
    expect(await again).toBe('opened')
  })

  it('reports not-opened when no window takes the terminal', async () => {
    const h = harness('apt', null)
    const start = h.runner.start()
    h.open()
    expect(await start).toBe('not-opened')
    expect(h.runner.state()).toEqual({ status: 'idle' })
  })
})
