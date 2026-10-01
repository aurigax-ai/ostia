import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { reportForeignDrop } from './paneDrag'

let init: ReturnType<typeof useWorkspacesStore.getState>

beforeAll(() => {
  init = useWorkspacesStore.getState()
})

afterEach(() => {
  useWorkspacesStore.setState(init, true)
})

function seed(kind: 'terminal' | 'scratch'): void {
  useWorkspacesStore.setState({
    workspaces: [{ id: 'w1', name: 'api', kind, workDir: '/home/u/api', state: 'idle' }],
    activeWorkspaceId: 'w1',
  })
}

describe('reportForeignDrop', () => {
  it('tells main a pane from another window landed in this workspace', () => {
    seed('terminal')
    reportForeignDrop('pane-x', { paneId: 'pane-1', zone: 'right' })
    expect(window.pine.windows.dropPane).toHaveBeenCalledWith({
      paneId: 'pane-x',
      workspaceId: 'w1',
      placement: { paneId: 'pane-1', zone: 'right' },
    })
  })

  it('never takes a pane from another window into a scratch workspace', () => {
    seed('scratch')
    vi.mocked(window.pine.windows.dropPane).mockClear()
    reportForeignDrop('pane-x', { paneId: 'pane-1', zone: 'center' })
    expect(window.pine.windows.dropPane).not.toHaveBeenCalled()
  })
})
