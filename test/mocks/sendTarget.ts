import { useLayoutStore } from '../../src/renderer/stores/layoutStore'
import { useWorkspacesStore } from '../../src/renderer/stores/workspacesStore'

export const TARGET_PANE = 'term-target'

export function seedSendTarget(workspaceId: string): () => void {
  const workspacesInit = useWorkspacesStore.getState()
  const layoutInit = useLayoutStore.getState()
  useWorkspacesStore.setState({
    workspaces: [{ id: workspaceId, name: 'Main', kind: 'terminal', workDir: '/w', state: 'idle' }],
    activeWorkspaceId: workspaceId,
  } as Partial<ReturnType<typeof useWorkspacesStore.getState>>)
  useLayoutStore.setState({
    byWorkspace: {
      [workspaceId]: {
        root: { type: 'pane', id: TARGET_PANE, title: 'agent shell', kind: 'terminal', cwd: '/w' },
        activePaneId: TARGET_PANE,
        zoomedPaneId: null,
      },
    },
  })
  return () => {
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
  }
}
