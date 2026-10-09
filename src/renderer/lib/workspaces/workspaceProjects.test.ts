import { createPane } from '@/layout/tree'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { anchorToFocusedPane, startWorkspaceProjects } from './workspaceProjects'

describe('startWorkspaceProjects', () => {
  const init = { layout: useLayoutStore.getState(), workspaces: useWorkspacesStore.getState() }
  let stop: (() => void) | null = null

  afterEach(() => {
    stop?.()
    stop = null
    useLayoutStore.setState(init.layout, true)
    useWorkspacesStore.setState(init.workspaces, true)
    vi.mocked(window.ostia.openPath.project).mockReset().mockResolvedValue(null)
  })

  it('names the workspace after the project its focused pane is in, and keeps a name you set', async () => {
    vi.mocked(window.ostia.openPath.project).mockImplementation(async (dir) =>
      dir.startsWith('/home/u/Personal/model-runtime')
        ? {
            name: 'model-runtime',
            display: '~/Personal/model-runtime',
            dir: '/home/u/Personal/model-runtime',
            repo: true,
          }
        : { name: 'home', display: '~', dir: '/home/u', repo: false },
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

  it('follows a pane through plain folders and sticks at the first git repository', async () => {
    vi.mocked(window.ostia.openPath.project).mockImplementation(async (dir) => ({
      name: dir.split('/').pop() ?? dir,
      display: dir.replace('/home/u', '~'),
      dir,
      repo: dir === '/home/u/app',
    }))
    const pane = createPane('terminal', undefined, '/home/u/notes')
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w1', name: 'home', kind: 'terminal', workDir: '/home/u', state: 'idle' }],
    })
    useLayoutStore.setState({
      byWorkspace: { w1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
    const workspace = () => useWorkspacesStore.getState().workspaces[0]

    stop = startWorkspaceProjects()
    await vi.waitFor(() => expect(workspace().workDir).toBe('/home/u/notes'))
    expect(workspace().anchored).toBeUndefined()

    useLayoutStore.getState().setCwd('w1', pane.id, '/home/u/app')
    await vi.waitFor(() => expect(workspace()).toMatchObject({ name: 'app', anchored: true }))

    useLayoutStore.getState().setCwd('w1', pane.id, '/home/u/other')
    await new Promise((r) => setTimeout(r, 0))
    expect(workspace()).toMatchObject({ name: 'app', workDir: '/home/u/app' })
  })

  it('stays on its project once it is set, until the human moves it', async () => {
    vi.mocked(window.ostia.openPath.project).mockImplementation(async (dir) => ({
      name: dir.split('/').pop() ?? dir,
      display: dir.replace('/home/u', '~'),
      dir,
      repo: false,
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
          anchored: true,
          state: 'idle',
        },
      ],
    })
    useLayoutStore.setState({
      byWorkspace: { w1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })

    stop = startWorkspaceProjects()
    await new Promise((r) => setTimeout(r, 0))
    expect(window.ostia.openPath.project).not.toHaveBeenCalled()

    useSandboxStore.setState({ enabled: { w1: true } })
    expect(await anchorToFocusedPane('w1')).toBe(false)
    expect(useWorkspacesStore.getState().workspaces[0].workDir).toBe('/home/u/app')

    useSandboxStore.setState({ enabled: {} })
    expect(await anchorToFocusedPane('w1')).toBe(true)
    expect(window.ostia.openPath.project).toHaveBeenLastCalledWith('/home/u/other', true)
    expect(useWorkspacesStore.getState().workspaces[0]).toMatchObject({
      name: 'other',
      projectDir: '~/other',
      workDir: '/home/u/other',
      anchored: true,
    })
    expect(window.ostia.lifecycle.emit).toHaveBeenCalledWith({
      type: 'workspace-added',
      workspaceId: 'w1',
      workDir: '/home/u/other',
    })
  })
})
