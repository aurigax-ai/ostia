import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findPane, resetIds } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { openFileInWorkspace } from './openFile'

describe('openFileInWorkspace', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
  })

  afterEach(() => {
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    resetIds()
  })

  const activeEditor = (workspaceId: string) => {
    const layout = useLayoutStore.getState().byWorkspace[workspaceId]
    return layout ? findPane(layout.root, layout.activePaneId) : null
  }

  it('opens the file in the active workspace without adding a workspace', () => {
    useWorkspacesStore.getState().addWorkspace('/w')
    const workspaceId = useWorkspacesStore.getState().workspaces[0].id

    openFileInWorkspace('/w/notes.md')

    expect(useWorkspacesStore.getState().workspaces).toHaveLength(1)
    expect(activeEditor(workspaceId)).toMatchObject({ kind: 'editor', filePath: '/w/notes.md' })
  })

  it('opens a workspace for the file when the user opens one with no workspaces', () => {
    openFileInWorkspace('/home/u/notes.md')

    const [only] = useWorkspacesStore.getState().workspaces
    expect(only).toMatchObject({ workDir: '~' })
    expect(activeEditor(only.id)).toMatchObject({ kind: 'editor', filePath: '/home/u/notes.md' })
  })
})
