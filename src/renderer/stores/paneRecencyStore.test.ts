import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetIds } from '../layout/tree'
import { useLayoutStore } from './layoutStore'
import { startPaneRecencySync, usePaneRecencyStore } from './paneRecencyStore'
import { useSessionsStore } from './sessionsStore'

let sessionsInit: ReturnType<typeof useSessionsStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let recencyInit: ReturnType<typeof usePaneRecencyStore.getState>

beforeAll(() => {
  sessionsInit = useSessionsStore.getState()
  layoutInit = useLayoutStore.getState()
  recencyInit = usePaneRecencyStore.getState()
})

afterEach(() => {
  useSessionsStore.setState(sessionsInit, true)
  useLayoutStore.setState(layoutInit, true)
  usePaneRecencyStore.setState(recencyInit, true)
  resetIds()
  vi.useRealTimers()
})

describe('startPaneRecencySync', () => {
  it('stamps a pane each time it becomes the active pane of its session', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const sessionId = useSessionsStore.getState().sessions[0].id
    useLayoutStore.getState().ensure(sessionId)
    const a = useLayoutStore.getState().bySession[sessionId].activePaneId
    const stop = startPaneRecencySync()
    expect(usePaneRecencyStore.getState().touchedAt[a]).toBe(1000)

    vi.setSystemTime(2000)
    useLayoutStore.getState().split(sessionId, a, 'horizontal')
    const b = useLayoutStore.getState().bySession[sessionId].activePaneId
    expect(usePaneRecencyStore.getState().touchedAt[b]).toBe(2000)

    vi.setSystemTime(3000)
    useLayoutStore.getState().focusPane(sessionId, a)
    expect(usePaneRecencyStore.getState().touchedAt[a]).toBe(3000)

    stop()
    vi.setSystemTime(4000)
    useLayoutStore.getState().focusPane(sessionId, b)
    expect(usePaneRecencyStore.getState().touchedAt[b]).toBe(2000)
  })
})
