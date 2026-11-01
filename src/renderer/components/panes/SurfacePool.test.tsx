import '@testing-library/jest-dom/vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPane, findSplitTabByName, firstPaneId, splitOf } from '@/lib/layout/tree'
import { loadGhostty } from '@/lib/terminal/ghosttyEngine'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { surfaceHost } from '@/stores/workspaces/surfaceSlotsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { renderSettled } from '../../../../test/render'
import { SurfacePool } from './SurfacePool'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

class InitialObservation {
  private connected = true
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    setTimeout(() => {
      if (this.connected) {
        this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
    })
  }
  unobserve(): void {}
  disconnect(): void {
    this.connected = false
  }
}

const realGetContext = HTMLCanvasElement.prototype.getContext
const realResizeObserver = globalThis.ResizeObserver

const screenText = (paneId: string): string => {
  const buffer = terminalFor(paneId)?.buffer.active
  const lines: string[] = []
  for (let i = 0; buffer && i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  }
  return lines.join('')
}

describe('SurfacePool', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

  beforeAll(async () => {
    await loadGhostty()
    layoutInit = useLayoutStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    HTMLCanvasElement.prototype.getContext = function getContext(
      this: HTMLCanvasElement,
      kind: string,
    ) {
      if (kind !== '2d') return null
      const noop = () => {}
      return new Proxy(
        { canvas: this, measureText: (text: string) => ({ width: text.length * 8 }) },
        {
          get: (target, key) => (key in target ? target[key as keyof typeof target] : noop),
          set: () => true,
        },
      )
    } as typeof HTMLCanvasElement.prototype.getContext
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
    globalThis.ResizeObserver = InitialObservation as unknown as typeof ResizeObserver
  })

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = realGetContext
    globalThis.ResizeObserver = realResizeObserver
  })

  afterEach(() => {
    cleanup()
    useLayoutStore.setState(layoutInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
  })

  it('never fades in the host of a terminal or the manager, which hold a terminal', async () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w1', name: 'me', kind: 'terminal', workDir: '/home/me', state: 'idle' }],
      activeWorkspaceId: 'w1',
    })
    useLayoutStore.getState().ensure('w1')
    const terminal = firstPaneId(useLayoutStore.getState().byWorkspace.w1.root)
    const manager = createPane('manager', 'manager')
    useLayoutStore.setState({
      byWorkspace: {
        w1: {
          root: splitOf('horizontal', useLayoutStore.getState().byWorkspace.w1.root, manager),
          activePaneId: terminal,
          zoomedPaneId: null,
        },
      },
    })
    await renderSettled(<SurfacePool />)

    expect(surfaceHost(terminal)).not.toHaveClass('surface-enter')
    expect(surfaceHost(manager.id)).not.toHaveClass('surface-enter')
  })

  it('splitting keeps the original terminal DOM node and its history', async () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w1', name: 'me', kind: 'terminal', workDir: '/home/me', state: 'idle' }],
      activeWorkspaceId: 'w1',
    })
    useLayoutStore.getState().ensure('w1')
    const original = firstPaneId(useLayoutStore.getState().byWorkspace.w1.root)
    await renderSettled(<SurfacePool />)
    await waitFor(() => expect(window.ostia.pty.onData).toHaveBeenCalled())
    const deliver = vi.mocked(window.ostia.pty.onData).mock.calls[0][1]
    act(() => deliver('survivor_42\r\n'))
    await waitFor(() => expect(screenText(original)).toContain('survivor_42'))
    const survivor = surfaceHost(original).querySelector('.ghostty-host')
    expect(survivor).not.toBeNull()

    act(() => useLayoutStore.getState().split('w1', original, 'horizontal'))
    const second = useLayoutStore.getState().byWorkspace.w1.activePaneId
    act(() => useLayoutStore.getState().split('w1', second, 'vertical'))
    const third = useLayoutStore.getState().byWorkspace.w1.activePaneId
    await waitFor(() => expect(surfaceHost(third).querySelector('.ghostty-host')).not.toBeNull())

    expect(new Set([original, second, third]).size).toBe(3)
    expect(surfaceHost(original).querySelector('.ghostty-host')).toBe(survivor)
    expect(screenText(original)).toContain('survivor_42')
    expect(
      vi.mocked(window.ostia.pty.attach).mock.calls.filter(([paneId]) => paneId === original),
    ).toHaveLength(1)
  })

  it('joining panes into a split tab and separating them again keeps every terminal DOM node', async () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w1', name: 'me', kind: 'terminal', workDir: '/home/me', state: 'idle' }],
      activeWorkspaceId: 'w1',
    })
    const layout = useLayoutStore.getState()
    layout.ensure('w1')
    const caller = firstPaneId(useLayoutStore.getState().byWorkspace.w1.root)
    const w1 = layout.newTab('w1', caller, 'terminal') ?? ''
    const w2 = layout.newTab('w1', w1, 'terminal') ?? ''
    const panes = [caller, w1, w2]
    await renderSettled(<SurfacePool />)
    const attaches = (id: string) =>
      vi.mocked(window.ostia.pty.attach).mock.calls.filter(([paneId]) => paneId === id)
    await waitFor(() => {
      for (const id of panes) expect(attaches(id)).toHaveLength(1)
    })
    const hosts = panes.map((id) => surfaceHost(id).querySelector('.ghostty-host'))
    expect(hosts).not.toContain(null)
    const expectSameHosts = () => {
      panes.forEach((id, i) =>
        expect(surfaceHost(id).querySelector('.ghostty-host')).toBe(hosts[i]),
      )
    }

    act(() => {
      useLayoutStore.getState().joinTab('w1', [w1, w2], 'workers')
    })
    expect(
      findSplitTabByName(useLayoutStore.getState().byWorkspace.w1.root, 'workers'),
    ).not.toBeNull()
    expectSameHosts()

    act(() => {
      useLayoutStore.getState().joinTab('w1', [w2], null)
    })
    expect(findSplitTabByName(useLayoutStore.getState().byWorkspace.w1.root, 'workers')).toBeNull()
    expectSameHosts()
    for (const id of panes) expect(attaches(id)).toHaveLength(1)
  })
})
