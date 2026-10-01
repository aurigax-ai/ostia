import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { anchorToFocusedPane, startWorkspaceProjects } from './workspaceProjects'

describe('startWorkspaceProjects', () => {
  const init = { layout: useLayoutStore.getState(), workspaces: useWorkspacesStore.getState() }
  let stop: (() => void) | null = null

  afterEach(() => {
    stop?.()
    stop = null
    useLayoutStore.setState(init.layout, true)
    useWorkspacesStore.setState(init.workspaces, true)
    vi.mocked(window.pine.openPath.project).mockReset().mockResolvedValue(null)
  })

  it('names the workspace after the project its focused pane is in, and keeps a name you set', async () => {
    vi.mocked(window.pine.openPath.project).mockImplementation(async (dir) =>
      dir.startsWith('/home/u/Personal/model-runtime')
        ? {
            name: 'model-runtime',
            display: '~/Personal/model-runtime',
            dir: '/home/u/Personal/model-runtime',
          }
        : { name: 'home', display: '~', dir: '/home/u' },
    )
    const pane = createPane('terminal', undefined, '/home/u/Personal/model-runtime/src')
    useWorkspacesStore.setState({
      workspaces: [
        { id: 'w1', name: 'home', kind: 'terminal', workDir: '~', state: 'idle' },
        {
          id: 'w2',
          name: 'home',
          customName: 'Mine',
          kind: 'terminal',
          workDir: '/home/u',
          state: 'idle',
        },
      ],
    })
    useLayoutStore.setState({
      byWorkspace: { w1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })

    stop = startWorkspaceProjects()
    await vi.waitFor(() =>
      expect(useWorkspacesStore.getState().workspaces[0]).toMatchObject({
        name: 'model-runtime',
        projectDir: '~/Personal/model-runtime',
      }),
    )
    expect(useWorkspacesStore.getState().workspaces[1].customName).toBe('Mine')
    expect(useWorkspacesStore.getState().workspaces[0].workDir).toBe(
      '/home/u/Personal/model-runtime',
    )

    useLayoutStore.getState().closePane('w1', pane.id)
    await new Promise((r) => setTimeout(r, 0))
    expect(useWorkspacesStore.getState().workspaces[0]).toMatchObject({
      name: 'model-runtime',
      projectDir: '~/Personal/model-runtime',
      workDir: '/home/u/Personal/model-runtime',
    })
  })

  it('stays on its project once it has one, until the human moves it', async () => {
    vi.mocked(window.pine.openPath.project).mockImplementation(async (dir) => ({
      name: dir.split('/').pop() ?? dir,
      display: dir.replace('/home/u', '~'),
      dir,
    }))
    const pane = createPane('terminal', undefined, '/home/u/other')
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: 'w1',
          name: 'app',
          kind: 'terminal',
          workDir: '/home/u/app',
          projectDir: '~/app',
          state: 'idle',
        },
      ],
    })
    useLayoutStore.setState({
      byWorkspace: { w1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })

    stop = startWorkspaceProjects()
    await new Promise((r) => setTimeout(r, 0))
    expect(window.pine.openPath.project).not.toHaveBeenCalled()
    expect(useWorkspacesStore.getState().workspaces[0]).toMatchObject({
      name: 'app',
      workDir: '/home/u/app',
    })

    expect(await anchorToFocusedPane('w1')).toBe(true)
    expect(useWorkspacesStore.getState().workspaces[0]).toMatchObject({
      name: 'other',
      projectDir: '~/other',
      workDir: '/home/u/other',
    })
  })
})
