import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { firstPaneId } from '@/lib/layout/tree'
import { useLayoutStore } from './layoutStore'
import { releaseSurfaces, setFocusTarget, surfaceHost } from './surfaceSlotsStore'

describe('layoutStore close keyboard', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
  })

  afterEach(() => {
    useLayoutStore.setState(layoutInit, true)
    releaseSurfaces(new Set())
    document.body.replaceChildren()
  })

  function surfaceWithInput(paneId: string): HTMLTextAreaElement {
    const input = document.createElement('textarea')
    surfaceHost(paneId).appendChild(input)
    document.body.appendChild(surfaceHost(paneId))
    setFocusTarget(paneId, () => input)
    return input
  }

  function twoTabs(): { first: string; second: string } {
    useLayoutStore.getState().ensure('ws')
    const first = firstPaneId(useLayoutStore.getState().byWorkspace.ws.root)
    const second = useLayoutStore.getState().newTab('ws', first, 'terminal') as string
    return { first, second }
  }

  it('moves the keyboard to the tab shown after the closed one held it', () => {
    const { first, second } = twoTabs()
    const firstInput = surfaceWithInput(first)
    surfaceWithInput(second).focus()
    useLayoutStore.getState().closePane('ws', second)
    expect(document.activeElement).toBe(firstInput)
  })

  it('leaves the keyboard where it was when the closed tab did not hold it', () => {
    const { first, second } = twoTabs()
    const firstInput = surfaceWithInput(first)
    surfaceWithInput(second)
    const button = document.body.appendChild(document.createElement('button'))
    button.focus()
    useLayoutStore.getState().closePane('ws', second)
    expect(document.activeElement).toBe(button)
    expect(document.activeElement).not.toBe(firstInput)
  })
})
