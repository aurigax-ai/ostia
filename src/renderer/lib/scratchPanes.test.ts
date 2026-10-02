import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useLayoutStore } from '../stores/layoutStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { historyHiddenFrom } from './scratchPanes'

let layoutInit: ReturnType<typeof useLayoutStore.getState>
let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

const pane = (id: string) => ({
  type: 'pane' as const,
  id,
  title: 'zsh',
  kind: 'terminal' as const,
})
const layout = (id: string) => ({ root: pane(id), activePaneId: id, zoomedPaneId: null })

beforeAll(() => {
  layoutInit = useLayoutStore.getState()
  workspacesInit = useWorkspacesStore.getState()
})

afterEach(() => {
  useLayoutStore.setState(layoutInit, true)
  useWorkspacesStore.setState(workspacesInit, true)
  useSandboxStore.setState({ enabled: {} })
})

describe('historyHiddenFrom', () => {
  const seed = (): void => {
    useWorkspacesStore.setState({
      workspaces: [
        { id: 'w1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' },
        { id: 'w2', name: 'b', kind: 'terminal', workDir: '/b', state: 'idle' },
        { id: 'w3', name: 's', kind: 'scratch', workDir: '/tmp/s', state: 'idle' },
      ],
    })
    useLayoutStore.setState({
      byWorkspace: { w1: layout('p1'), w2: layout('p2'), w3: layout('p3') },
    })
  }

  it('hides only scratch panes from an unsandboxed pane', () => {
    seed()
    expect([...historyHiddenFrom('p1')]).toEqual(['p3'])
  })

  it('hides every other workspace from a pane in a sandboxed workspace', () => {
    seed()
    useSandboxStore.setState({ enabled: { w1: true } })
    expect([...historyHiddenFrom('p1')].sort()).toEqual(['p2', 'p3'])
    expect([...historyHiddenFrom('p2')]).toEqual(['p3'])
  })
})
