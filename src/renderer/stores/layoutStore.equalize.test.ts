import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { firstPaneId } from '../layout/tree'
import type { SplitNode } from '../layout/types'
import { useLayoutStore } from './layoutStore'
import { useSettingsStore } from './settingsStore'

const layoutOf = () => useLayoutStore.getState().byWorkspace.s1

describe('layoutStore equalize on split', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    useLayoutStore.setState(layoutInit, true)
    useSettingsStore.setState(settingsInit, true)
  })

  function unevenTwoPanes(): string {
    useLayoutStore.getState().ensure('s1')
    const first = firstPaneId(layoutOf().root)
    useLayoutStore.getState().split('s1', first, 'horizontal')
    const root = layoutOf().root as SplitNode
    useLayoutStore.getState().resize('s1', root.id, [900, 100])
    return first
  }

  it('keeps sizes and the render epoch alone by default', () => {
    const first = unevenTwoPanes()
    useLayoutStore.getState().split('s1', first, 'vertical')
    const root = layoutOf().root as SplitNode
    expect(root.sizes).toEqual([900, 100])
    expect(layoutOf().equalized).toBeUndefined()
  })

  it('equalizes every split and bumps the epoch when a pane is created', () => {
    const first = unevenTwoPanes()
    useSettingsStore.getState().setPanes({ equalizeOnSplit: true })
    useLayoutStore.getState().split('s1', first, 'vertical')
    const root = layoutOf().root as SplitNode
    expect(root.sizes).toEqual([1, 1])
    expect(layoutOf().equalized).toBe(1)
  })

  it('does not touch sizes when a tab is added', () => {
    const first = unevenTwoPanes()
    useSettingsStore.getState().setPanes({ equalizeOnSplit: true })
    useLayoutStore.getState().newTab('s1', first, 'terminal')
    expect((layoutOf().root as SplitNode).sizes).toEqual([900, 100])
    expect(layoutOf().equalized).toBeUndefined()
  })
})
