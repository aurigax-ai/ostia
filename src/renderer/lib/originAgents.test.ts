import type { OriginAgents } from '@shared/types'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useOriginAgentsStore } from '../stores/originAgentsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { originWorkspaceId, refreshOriginAgents, startOriginAgentsSync } from './originAgents'

const HOME: OriginAgents = {
  workspaceId: 'w-home',
  workspaceName: 'api',
  targets: [{ paneId: 'p-far', title: 'claude', agent: 'claude', state: 'working' }],
}

function workspace(id: string, origin?: string): never {
  return {
    id,
    name: id,
    kind: 'terminal',
    workDir: '~/api',
    state: 'idle',
    ...(origin ? { origin: { workspaceId: origin, index: 0 } } : {}),
  } as never
}

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let originInit: ReturnType<typeof useOriginAgentsStore.getState>

beforeAll(() => {
  workspacesInit = useWorkspacesStore.getState()
  originInit = useOriginAgentsStore.getState()
})

afterEach(() => {
  useWorkspacesStore.setState(workspacesInit, true)
  useOriginAgentsStore.setState(originInit, true)
  vi.mocked(window.pine.windows.originAgents).mockReset().mockResolvedValue(null)
  vi.mocked(window.pine.windows.onOriginAgentsChanged).mockReset()
})

describe('originWorkspaceId', () => {
  it('names the workspace a pane left, and nothing for a workspace that moved whole', () => {
    expect(originWorkspaceId({ id: 'w-moved', origin: { workspaceId: 'w-home' } })).toBe('w-home')
    expect(originWorkspaceId({ id: 'w-whole', origin: { workspaceId: 'w-whole' } })).toBeNull()
    expect(originWorkspaceId({ id: 'w-plain' })).toBeNull()
  })
})

describe('refreshOriginAgents', () => {
  it('asks main only for workspaces that came from another one and stores each answer', async () => {
    useWorkspacesStore.setState({
      workspaces: [
        workspace('w-moved', 'w-home'),
        workspace('w-lost', 'w-closed'),
        workspace('w-whole', 'w-whole'),
        workspace('w-plain'),
      ],
    })
    vi.mocked(window.pine.windows.originAgents).mockImplementation(async (id) =>
      id === 'w-moved' ? HOME : null,
    )

    await refreshOriginAgents()

    expect(vi.mocked(window.pine.windows.originAgents).mock.calls).toEqual([
      ['w-moved'],
      ['w-lost'],
    ])
    expect(useOriginAgentsStore.getState().byWorkspace).toEqual({ 'w-moved': HOME, 'w-lost': null })
  })

  it('keeps the newer answer when an older request finishes last', async () => {
    useWorkspacesStore.setState({ workspaces: [workspace('w-moved', 'w-home')] })
    let finishOld: (value: OriginAgents | null) => void = () => {}
    vi.mocked(window.pine.windows.originAgents)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve
          }),
      )
      .mockResolvedValueOnce(HOME)

    const old = refreshOriginAgents()
    await refreshOriginAgents()
    finishOld(null)
    await old

    expect(useOriginAgentsStore.getState().byWorkspace).toEqual({ 'w-moved': HOME })
  })
})

describe('startOriginAgentsSync', () => {
  it('asks again when main says the agents changed and when a workspace with an origin arrives', async () => {
    let changed: () => void = () => {}
    vi.mocked(window.pine.windows.onOriginAgentsChanged).mockImplementation((cb) => {
      changed = cb
      return () => {}
    })
    const stop = startOriginAgentsSync()
    await vi.waitFor(() => expect(useOriginAgentsStore.getState().byWorkspace).toEqual({}))
    expect(window.pine.windows.originAgents).not.toHaveBeenCalled()

    useWorkspacesStore.setState({ workspaces: [workspace('w-moved', 'w-home')] })
    await vi.waitFor(() =>
      expect(useOriginAgentsStore.getState().byWorkspace).toEqual({ 'w-moved': null }),
    )

    vi.mocked(window.pine.windows.originAgents).mockResolvedValue(HOME)
    changed()
    await vi.waitFor(() =>
      expect(useOriginAgentsStore.getState().byWorkspace).toEqual({ 'w-moved': HOME }),
    )
    stop()
  })
})
