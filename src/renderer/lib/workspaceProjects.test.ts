import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { startWorkspaceProjects } from './workspaceProjects'

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
        ? { name: 'model-runtime', display: '~/Personal/model-runtime' }
        : { name: 'home', display: '~' },
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
  })
})
