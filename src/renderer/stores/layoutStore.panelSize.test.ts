import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLocalStorage } from '../../../test/mocks/memoryStorage'
import { panelFractions } from '../layout/panelSize'
import { findPane, firstPaneId, paneIds } from '../layout/tree'
import type { SplitNode } from '../layout/types'
import { rememberPanelFractions } from '../lib/panelSizes'
import { useLayoutStore } from './layoutStore'
import { useSettingsStore } from './settingsStore'

const layoutOf = () => useLayoutStore.getState().byWorkspace.s1
const rootSplit = () => layoutOf().root as SplitNode
const panelShare = (paneId: string) => {
  const split = rootSplit()
  const idx = split.children.findIndex((c) => c.id === paneId)
  return split.sizes[idx] / split.sizes.reduce((sum, n) => sum + n, 0)
}

function dragRootSplit(sizes: number[]): void {
  const split = rootSplit()
  useLayoutStore.getState().resize('s1', split.id, sizes)
  rememberPanelFractions(panelFractions(rootSplit(), sizes))
}

function openedPane(open: () => string | null): string {
  const paneId = open()
  if (!paneId) throw new Error('nothing opened')
  return paneId
}

describe('layoutStore remembered panel size', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    installLocalStorage()
    useLayoutStore.getState().ensure('s1')
  })

  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
    window.localStorage.clear()
    useLayoutStore.setState(layoutInit, true)
    useSettingsStore.setState(settingsInit, true)
  })

  it('opens a panel at 50/50 when nothing is remembered', () => {
    const panel = openedPane(() =>
      useLayoutStore.getState().openExtensionPanel('s1', 'assistant', 'Assistant'),
    )

    expect(panelShare(panel)).toBeCloseTo(0.5)
  })

  it('reopens an extension panel at the size the human dragged it to', () => {
    const store = useLayoutStore.getState()
    const panel = openedPane(() => store.openExtensionPanel('s1', 'assistant', 'Assistant'))
    dragRootSplit([900, 300])
    store.closePane('s1', panel)

    const reopened = openedPane(() => store.openExtensionPanel('s1', 'assistant', 'Assistant'))

    expect(reopened).not.toBe(panel)
    expect(panelShare(reopened)).toBeCloseTo(0.25)
  })

  it('reopens at the remembered size after the write reached storage', () => {
    const store = useLayoutStore.getState()
    const panel = openedPane(() => store.openView('s1', 'deploys', 'Deploys'))
    dragRootSplit([400, 800])
    vi.runAllTimers()
    store.closePane('s1', panel)

    const reopened = openedPane(() => store.openView('s1', 'deploys', 'Deploys'))

    expect(panelShare(reopened)).toBeCloseTo(2 / 3)
  })

  it('remembers the chat pane on its own key', () => {
    const store = useLayoutStore.getState()
    const chat = openedPane(() => store.openChat('s1', 'Chat'))
    dragRootSplit([700, 300])
    store.closePane('s1', chat)

    const ext = openedPane(() => store.openExtensionPanel('s1', 'assistant', 'Assistant'))
    expect(panelShare(ext)).toBeCloseTo(0.5)
    store.closePane('s1', ext)

    const reopened = openedPane(() => store.openChat('s1', 'Chat'))
    expect(findPane(layoutOf().root, reopened)?.kind).toBe('chat')
    expect(panelShare(reopened)).toBeCloseTo(0.3)
  })

  it('applies the remembered size in another workspace', () => {
    const store = useLayoutStore.getState()
    const panel = openedPane(() => store.openExtensionPanel('s1', 'assistant', 'Assistant'))
    dragRootSplit([800, 200])
    store.closePane('s1', panel)
    store.ensure('s2')

    const other = openedPane(() => store.openExtensionPanel('s2', 'assistant', 'Assistant'))
    const split = useLayoutStore.getState().byWorkspace.s2.root as SplitNode

    expect(split.children[1].id).toBe(other)
    expect(split.sizes[1] / (split.sizes[0] + split.sizes[1])).toBeCloseTo(0.2)
  })

  it('keeps the remembered size even when splits equalize', () => {
    useSettingsStore.setState({
      panes: { ...useSettingsStore.getState().panes, equalizeOnSplit: true },
    })
    const store = useLayoutStore.getState()
    const panel = openedPane(() => store.openExtensionPanel('s1', 'assistant', 'Assistant'))
    dragRootSplit([700, 300])
    store.closePane('s1', panel)

    const reopened = openedPane(() => store.openExtensionPanel('s1', 'assistant', 'Assistant'))

    expect(panelShare(reopened)).toBeCloseTo(0.3)
  })

  it('leaves an already open panel at its current size', () => {
    const store = useLayoutStore.getState()
    const panel = openedPane(() => store.openExtensionPanel('s1', 'assistant', 'Assistant'))
    dragRootSplit([900, 300])
    store.resize('s1', rootSplit().id, [600, 600])
    store.focusPane('s1', firstPaneId(layoutOf().root))

    store.openExtensionPanel('s1', 'assistant', 'Assistant')

    expect(paneIds(layoutOf().root)).toHaveLength(2)
    expect(panelShare(panel)).toBeCloseTo(0.5)
  })
})
