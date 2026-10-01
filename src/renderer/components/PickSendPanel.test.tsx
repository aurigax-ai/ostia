import type { OriginAgents } from '@shared/types'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createPane } from '../layout/tree'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useOriginAgentsStore } from '../stores/originAgentsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { useAgentTargets, useLocalAgentTargets, useNoAgentsText } from './PickSendPanel'

const HOME: OriginAgents = {
  workspaceId: 'w-home',
  workspaceName: 'api',
  targets: [
    { paneId: 'p-far', title: 'fix login', agent: 'claude', state: 'waiting', cwd: '/home/u/api' },
    { paneId: 'p-aider', title: 'aider', agent: 'other', state: 'working' },
  ],
}

describe('useAgentTargets', () => {
  const stores = [
    useAttentionStore,
    useBlocksStore,
    useLayoutStore,
    useOriginAgentsStore,
    useWorkspacesStore,
  ] as const
  let inits: unknown[]

  beforeAll(() => {
    inits = stores.map((store) => store.getState())
  })

  afterEach(() => {
    cleanup()
    stores.forEach((store, i) => {
      store.setState(inits[i] as never, true)
    })
  })

  function seedDetached(localAgent: boolean): void {
    const browser = { ...createPane('browser'), id: 'p-web', title: 'localhost' }
    const agent = { ...createPane('terminal'), id: 'p-near', title: 'codex' }
    useWorkspacesStore.setState({
      workspaces: [
        { id: 'w-moved', name: 'api', kind: 'terminal', workDir: '~/api', state: 'idle' } as never,
      ],
      activeWorkspaceId: 'w-moved',
    })
    useLayoutStore.setState({
      byWorkspace: {
        'w-moved': localAgent
          ? {
              root: {
                type: 'tabs',
                id: 'tabs-1',
                children: [browser, agent],
                activeId: browser.id,
              },
              activePaneId: browser.id,
              zoomedPaneId: null,
            }
          : { root: browser, activePaneId: browser.id, zoomedPaneId: null },
      } as never,
    })
    if (localAgent) {
      useBlocksStore.setState({
        running: { 'p-near': 'b1' },
        agentBlocks: { 'p-near': { blockId: 'b1', agent: 'codex' } },
      })
    }
  }

  it('lists the origin workspace’s agents after the local ones, marked as in the other window', () => {
    seedDetached(true)
    useOriginAgentsStore.getState().setAll({ 'w-moved': HOME })

    const { result } = renderHook(() => useAgentTargets('w-moved'))

    expect(result.current.map((t) => t.paneId)).toEqual(['p-near', 'p-far', 'p-aider'])
    expect(result.current[0]).toMatchObject({ sameWorkspace: true })
    expect(result.current[0].via).toBeUndefined()
    expect(result.current[1]).toMatchObject({
      workspaceId: 'w-home',
      workspaceName: 'api',
      title: 'Claude Code · fix login (api, other window)',
      cwd: '/home/u/api',
      state: 'waiting',
      sameWorkspace: false,
      via: 'w-moved',
    })
    expect(result.current[2].title).toBe('aider (api, other window)')
  })

  it('offers only the origin workspace’s agents when the detached pane has none beside it', () => {
    seedDetached(false)
    useOriginAgentsStore.getState().setAll({ 'w-moved': HOME })

    const { result } = renderHook(() => useAgentTargets('w-moved'))

    expect(result.current.map((t) => t.paneId)).toEqual(['p-far', 'p-aider'])
  })

  it('keeps another workspace’s origin agents out of the list', () => {
    seedDetached(false)
    useOriginAgentsStore.getState().setAll({ 'w-other': HOME })

    const { result } = renderHook(() => useAgentTargets('w-moved'))

    expect(result.current).toEqual([])
  })

  it('never gives the origin workspace’s agents to the local-only list', () => {
    seedDetached(true)
    useOriginAgentsStore.getState().setAll({ 'w-moved': HOME })

    const { result } = renderHook(() => useLocalAgentTargets('w-moved'))

    expect(result.current.map((t) => t.paneId)).toEqual(['p-near'])
  })
})

describe('useNoAgentsText', () => {
  let init: ReturnType<typeof useOriginAgentsStore.getState>

  beforeAll(() => {
    init = useOriginAgentsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useOriginAgentsStore.setState(init, true)
  })

  it('says no agent runs here for a workspace that came from nowhere else', () => {
    const { result } = renderHook(() => useNoAgentsText('w-plain'))

    expect(result.current).toBe('No agent is running in this workspace.')
  })

  it('names the origin workspace when it is open but runs no agent', () => {
    useOriginAgentsStore.getState().setAll({ 'w-moved': { ...HOME, targets: [] } })

    const { result } = renderHook(() => useNoAgentsText('w-moved'))

    expect(result.current).toBe(
      'No agent is running in this workspace or in api, where this pane came from.',
    )
  })

  it('says the origin workspace is no longer open when main cannot find it', () => {
    useOriginAgentsStore.getState().setAll({ 'w-moved': null })

    const { result } = renderHook(() => useNoAgentsText('w-moved'))

    expect(result.current).toBe(
      'No agent is running in this workspace, and the workspace this pane came from is no longer open.',
    )
  })
})
