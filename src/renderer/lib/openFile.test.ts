import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findPane, resetIds } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { openFileInWorkspace } from './openFile'

describe('openFileInWorkspace', () => {
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    sessionsInit = useSessionsStore.getState()
    layoutInit = useLayoutStore.getState()
  })

  afterEach(() => {
    useSessionsStore.setState(sessionsInit, true)
    useLayoutStore.setState(layoutInit, true)
    resetIds()
  })

  const activeEditor = (sessionId: string) => {
    const layout = useLayoutStore.getState().bySession[sessionId]
    return layout ? findPane(layout.root, layout.activePaneId) : null
  }

  it('opens the file in the active session without adding a session', () => {
    useSessionsStore.getState().addSession('/w')
    const sessionId = useSessionsStore.getState().sessions[0].id

    openFileInWorkspace('/w/notes.md')

    expect(useSessionsStore.getState().sessions).toHaveLength(1)
    expect(activeEditor(sessionId)).toMatchObject({ kind: 'editor', filePath: '/w/notes.md' })
  })

  it('opens a session for the file when the user opens one with no sessions', () => {
    openFileInWorkspace('/home/u/notes.md')

    const [only] = useSessionsStore.getState().sessions
    expect(only).toMatchObject({ workDir: '~' })
    expect(activeEditor(only.id)).toMatchObject({ kind: 'editor', filePath: '/home/u/notes.md' })
  })
})
