import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resetIds } from '../layout/tree'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import {
  NOTIFY_AFTER_MS,
  aggregateSessionState,
  shouldNotifyCommandEnd,
  syncSessionState,
} from './sessionActivity'

describe('aggregateSessionState', () => {
  it('is working whenever any pane runs a command', () => {
    expect(aggregateSessionState('idle', true)).toBe('working')
    expect(aggregateSessionState('waiting', true)).toBe('working')
  })

  it('falls back to idle only from working, keeping states set by others', () => {
    expect(aggregateSessionState('working', false)).toBe('idle')
    expect(aggregateSessionState('waiting', false)).toBe('waiting')
    expect(aggregateSessionState('done', false)).toBe('done')
  })
})

describe('shouldNotifyCommandEnd', () => {
  it('notifies only for long commands while the window is unfocused', () => {
    expect(shouldNotifyCommandEnd(NOTIFY_AFTER_MS, false)).toBe(true)
    expect(shouldNotifyCommandEnd(NOTIFY_AFTER_MS - 1, false)).toBe(false)
    expect(shouldNotifyCommandEnd(NOTIFY_AFTER_MS * 3, true)).toBe(false)
  })
})

describe('syncSessionState', () => {
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>

  beforeAll(() => {
    sessionsInit = useSessionsStore.getState()
    layoutInit = useLayoutStore.getState()
    blocksInit = useBlocksStore.getState()
  })

  afterEach(() => {
    useSessionsStore.setState(sessionsInit, true)
    useLayoutStore.setState(layoutInit, true)
    useBlocksStore.setState(blocksInit, true)
    resetIds()
  })

  const setup = (): { sessionId: string; panes: string[] } => {
    const sessionId = useSessionsStore.getState().sessions[0].id
    useLayoutStore.getState().ensure(sessionId)
    const first = useLayoutStore.getState().bySession[sessionId].activePaneId
    useLayoutStore.getState().split(sessionId, first, 'horizontal')
    const layout = useLayoutStore.getState().bySession[sessionId]
    const panes = [first, layout.activePaneId].filter((id, i, all) => all.indexOf(id) === i)
    return { sessionId, panes }
  }
  const stateOf = (id: string) =>
    useSessionsStore.getState().sessions.find((s) => s.id === id)?.state

  it('marks the session working while any of its panes runs, idle when all finish', () => {
    const { sessionId, panes } = setup()
    expect(panes).toHaveLength(2)
    const [a, b] = panes
    const blocks = () => useBlocksStore.getState()

    blocks().commandStart(a, { line: 1 })
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('working')

    blocks().commandStart(b, { line: 1 })
    blocks().commandEnd(a, { line: 3 }, 0)
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('working')

    blocks().commandEnd(b, { line: 4 }, 1)
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('idle')
  })

  it('returns to idle when the pane running a command is dropped', () => {
    const { sessionId, panes } = setup()
    useBlocksStore.getState().commandStart(panes[1], { line: 1 })
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('working')

    useBlocksStore.getState().dropPane(panes[1])
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('idle')
  })

  it('ignores running panes that belong to another session', () => {
    const { sessionId } = setup()
    useBlocksStore.getState().commandStart('elsewhere', { line: 1 })
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('idle')
  })
})
