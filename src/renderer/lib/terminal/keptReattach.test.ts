import type { PaneNode } from '@/lib/layout/types'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { startKeptReattach } from './keptReattach'
import { registerOffscreenStarter, resetOffscreenStartForTests } from './offscreenStart'

let layoutInit: ReturnType<typeof useLayoutStore.getState>

function terminal(id: string, extra: Partial<PaneNode> = {}): PaneNode {
  return { type: 'pane', id, title: 'zsh', kind: 'terminal', ...extra }
}

function seed(): void {
  useLayoutStore.setState({
    byWorkspace: {
      w1: {
        root: {
          type: 'tabs',
          id: 'tabs-1',
          activeId: 'shown',
          children: [
            terminal('kept-behind'),
            terminal('kept-asleep', { hibernated: true }),
            terminal('shown'),
          ],
        },
        activePaneId: 'shown',
        zoomedPaneId: null,
      },
      w2: {
        root: terminal('kept-other-workspace'),
        activePaneId: 'kept-other-workspace',
        zoomedPaneId: null,
      },
    },
  })
}

function waiting(paneIds: string[]): void {
  vi.mocked(window.ostia.pty.keptWaiting).mockResolvedValueOnce(paneIds)
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('startKeptReattach', () => {
  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
  })

  afterEach(() => {
    useLayoutStore.setState(layoutInit, true)
    resetOffscreenStartForTests()
    vi.mocked(window.ostia.pty.keptWaiting).mockReset().mockResolvedValue([])
  })

  it('attaches a kept shell waiting in a tab that is not shown, once its terminal is on the page', async () => {
    seed()
    waiting(['kept-behind', 'kept-other-workspace'])
    const behind = vi.fn()
    registerOffscreenStarter('kept-behind', behind)
    const shown = vi.fn()
    registerOffscreenStarter('shown', shown)
    startKeptReattach()
    await settle()
    expect(behind).toHaveBeenCalledTimes(1)
    expect(behind).toHaveBeenCalledWith({ keepSize: true })
    expect(shown).toHaveBeenCalledWith({})
    const other = vi.fn()
    registerOffscreenStarter('kept-other-workspace', other)
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('leaves alone a hibernated pane and a kept shell no pane of this window names', async () => {
    seed()
    waiting(['kept-asleep', 'kept-elsewhere'])
    const asleep = vi.fn()
    registerOffscreenStarter('kept-asleep', asleep)
    startKeptReattach()
    await settle()
    const elsewhere = vi.fn()
    registerOffscreenStarter('kept-elsewhere', elsewhere)
    expect(asleep).not.toHaveBeenCalled()
    expect(elsewhere).not.toHaveBeenCalled()
  })

  it('starts restored terminals of a workspace that is not shown, without keepSize', async () => {
    useLayoutStore.setState({
      byWorkspace: {
        w1: { root: terminal('shown'), activePaneId: 'shown', zoomedPaneId: null },
        w2: {
          root: {
            type: 'tabs',
            id: 'tabs-2',
            activeId: 'plain',
            children: [
              terminal('plain'),
              terminal('asleep', { hibernated: true }),
              terminal('agent', {
                resume: { agent: 'claude', id: 's1' },
                resumePending: true,
              }),
            ],
          },
          activePaneId: 'plain',
          zoomedPaneId: null,
        },
      },
    })
    waiting([])
    const plain = vi.fn()
    const asleep = vi.fn()
    const agent = vi.fn()
    registerOffscreenStarter('plain', plain)
    registerOffscreenStarter('asleep', asleep)
    registerOffscreenStarter('agent', agent)
    startKeptReattach()
    await settle()
    expect(plain).toHaveBeenCalledTimes(1)
    expect(plain).toHaveBeenCalledWith({})
    expect(asleep).not.toHaveBeenCalled()
    expect(agent).not.toHaveBeenCalled()
  })

  it('still starts terminals when the main process cannot say which shells wait', async () => {
    seed()
    vi.mocked(window.ostia.pty.keptWaiting).mockRejectedValueOnce(new Error('gone'))
    const behind = vi.fn()
    registerOffscreenStarter('kept-behind', behind)
    startKeptReattach()
    await settle()
    expect(behind).toHaveBeenCalledWith({})
  })
})
