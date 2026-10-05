import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { allPanes, findPane, resetIds } from '../layout/tree'
import { useEditorRevealStore } from '../stores/editorRevealStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import {
  openFileInWorkspace,
  openFileTabs,
  openRequestedFiles,
  reportFileProblem,
} from './openFile'

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

describe('openFileTabs', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let revealInit: ReturnType<typeof useEditorRevealStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    revealInit = useEditorRevealStore.getState()
  })

  afterEach(() => {
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useEditorRevealStore.setState(revealInit, true)
    resetIds()
  })

  it('opens one tab per file in the order given and asks the editor to jump to a line', () => {
    useWorkspacesStore.getState().addWorkspace('/w')
    const workspaceId = useWorkspacesStore.getState().workspaces[0].id
    useLayoutStore.getState().ensure(workspaceId)
    const terminal = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId

    openFileTabs(
      workspaceId,
      [{ path: '/var/log/app.log', line: 12, column: 3 }, { path: '/tmp/shot.png' }],
      terminal,
    )

    const { root } = useLayoutStore.getState().byWorkspace[workspaceId]
    expect(allPanes(root).map((p) => p.filePath)).toEqual([
      undefined,
      '/var/log/app.log',
      '/tmp/shot.png',
    ])
    expect(useEditorRevealStore.getState().pending).toEqual({
      '/var/log/app.log': { line: 12, column: 3 },
    })
  })
})

describe('openRequestedFiles', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let revealInit: ReturnType<typeof useEditorRevealStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    revealInit = useEditorRevealStore.getState()
  })

  afterEach(() => {
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useEditorRevealStore.setState(revealInit, true)
    resetIds()
  })

  const editors = (workspaceId: string) =>
    allPanes(useLayoutStore.getState().byWorkspace[workspaceId].root)
      .filter((p) => p.kind === 'editor')
      .map((p) => p.filePath)

  it('shows one file where the human opens files, reusing the editor tab', () => {
    useWorkspacesStore.getState().addWorkspace('/w')
    const workspaceId = useWorkspacesStore.getState().workspaces[0].id
    useLayoutStore.getState().ensure(workspaceId)

    openRequestedFiles(workspaceId, [{ path: '/tmp/a.log' }])
    openRequestedFiles(workspaceId, [{ path: '/tmp/b.log', line: 4 }])

    expect(editors(workspaceId)).toEqual(['/tmp/b.log'])
    expect(useEditorRevealStore.getState().pending).toEqual({
      '/tmp/b.log': { line: 4, column: 1 },
    })
  })

  it('gives several files a tab each', () => {
    useWorkspacesStore.getState().addWorkspace('/w')
    const workspaceId = useWorkspacesStore.getState().workspaces[0].id
    useLayoutStore.getState().ensure(workspaceId)

    openRequestedFiles(workspaceId, [{ path: '/tmp/a.log' }, { path: '/tmp/b.png' }])

    expect(editors(workspaceId)).toEqual(['/tmp/a.log', '/tmp/b.png'])
  })
})

describe('reportFileProblem', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
  })

  afterEach(() => {
    useLayoutStore.setState(layoutInit, true)
    resetIds()
  })

  it('posts an in-app error on the active pane of the workspace', () => {
    useLayoutStore.getState().ensure('w1')
    const paneId = useLayoutStore.getState().byWorkspace.w1.activePaneId

    reportFileProblem('w1', 'Could not open /x.')

    expect(window.ostia.notifications.post).toHaveBeenCalledWith({
      paneId,
      kind: 'error',
      title: 'Could not open /x.',
      desktop: false,
    })
  })
})
