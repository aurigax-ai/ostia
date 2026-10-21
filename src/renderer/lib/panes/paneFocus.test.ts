import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPane, tabsOf } from '@/lib/layout/tree'
import { layoutOf } from '@/lib/panes/layoutPatch'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { focusPaneWhenReady, showPaneWhenReady, useGuestReady } from './paneFocus'

const waiting = vi.hoisted(() => vi.fn())

vi.mock('@/stores/workspaces/surfaceSlotsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/workspaces/surfaceSlotsStore')>()),
  focusSurfaceWhenReady: waiting,
}))

function webview(guestReached: boolean): HTMLElement {
  const el = document.createElement('webview')
  Object.defineProperty(el, 'getWebContentsId', {
    value: () => {
      if (!guestReached) throw new Error('The WebView must be attached to the DOM')
      return 7
    },
  })
  return el
}

describe('useGuestReady', () => {
  it('waits for dom-ready when the guest has not reached it yet', () => {
    const el = webview(false)
    const { result } = renderHook(() => useGuestReady(el))
    expect(result.current).toBeNull()
    act(() => {
      el.dispatchEvent(new Event('dom-ready'))
    })
    expect(result.current).toBe(el)
  })

  it('takes a guest whose dom-ready fired before the hook listened', () => {
    const el = webview(true)
    const { result } = renderHook(() => useGuestReady(el))
    expect(result.current).toBe(el)
  })
})

describe('showPaneWhenReady', () => {
  const layoutInit = useLayoutStore.getState()
  const attentionInit = useAttentionStore.getState()

  afterEach(() => {
    useLayoutStore.setState(layoutInit, true)
    useAttentionStore.setState(attentionInit, true)
    waiting.mockClear()
  })

  function seed(): void {
    const a = { ...createPane('terminal'), id: 'pa' }
    const b = { ...createPane('terminal'), id: 'pb' }
    useLayoutStore.setState({
      byWorkspace: { w1: { ...layoutOf(tabsOf('pa', a, b)), zoomedPaneId: 'pa' } },
    })
  }

  it('shows the tab, unzooms another pane, marks it viewed and waits for the surface instead of timing the focus', () => {
    seed()
    expect(showPaneWhenReady('w1', 'pb')).toBe(true)
    const layout = useLayoutStore.getState().byWorkspace.w1
    expect(layout?.activePaneId).toBe('pb')
    expect(layout?.zoomedPaneId).toBeNull()
    expect(waiting).toHaveBeenCalledTimes(1)
    expect(waiting.mock.calls[0]?.[0]).toBe('pb')
  })

  it('does nothing for a pane that is not in that workspace', () => {
    seed()
    expect(showPaneWhenReady('w1', 'gone')).toBe(false)
    expect(showPaneWhenReady('w2', 'pb')).toBe(false)
    expect(waiting).not.toHaveBeenCalled()
    focusPaneWhenReady('pa')
    expect(waiting).toHaveBeenCalledTimes(1)
  })
})
