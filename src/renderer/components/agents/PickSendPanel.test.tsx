import { createPane } from '@/layout/tree'
import { useAgentGroupsStore } from '@/stores/agentGroupsStore'
import { useAttentionStore } from '@/stores/attentionStore'
import { useBlocksStore } from '@/stores/blocksStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useOriginAgentsStore } from '@/stores/originAgentsStore'
import { usePaneRecencyStore } from '@/stores/paneRecencyStore'
import { useSandboxStore } from '@/stores/sandboxStore'
import { type WorkspaceKind, useWorkspacesStore } from '@/stores/workspacesStore'
import type { OriginAgents } from '@shared/types'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

interface Member {
  id: string
  name: string
  groupId?: string
  kind?: WorkspaceKind
  sandboxed?: boolean
  agents?: string[]
  shells?: string[]
}

const GROUPED: Member[] = [
  { id: 'w-web', name: 'web', groupId: 'g-shop', agents: ['p-web'], shells: ['p-web-shell'] },
  { id: 'w-api', name: 'api', groupId: 'g-shop', agents: ['p-api-old', 'p-api-new'] },
  { id: 'w-docs', name: 'docs', groupId: 'g-shop', agents: ['p-docs'], shells: ['p-docs-shell'] },
  { id: 'w-infra', name: 'infra', groupId: 'g-ops', agents: ['p-infra'] },
  { id: 'w-loose', name: 'loose', agents: ['p-loose'] },
]

describe('useAgentTargets in a sidebar group', () => {
  const stores = [
    useAgentGroupsStore,
    useAttentionStore,
    useBlocksStore,
    useLayoutStore,
    useOriginAgentsStore,
    usePaneRecencyStore,
    useSandboxStore,
    useWorkspacesStore,
  ] as const
  let inits: unknown[]

  beforeAll(() => {
    inits = stores.map((store) => store.getState())
  })

  afterEach(() => {
    cleanup()
    vi.mocked(window.ostia.sandbox.get).mockReset().mockResolvedValue(null)
    stores.forEach((store, i) => {
      store.setState(inits[i] as never, true)
    })
  })

  function seed(members: Member[]): void {
    const panesOf = (m: Member) => [...(m.agents ?? []), ...(m.shells ?? [])]
    useWorkspacesStore.setState({
      workspaces: members.map((m) => ({
        id: m.id,
        name: m.name,
        kind: m.kind ?? 'terminal',
        workDir: `~/${m.name}`,
        state: 'idle',
        ...(m.groupId ? { groupId: m.groupId } : {}),
      })) as never,
      groups: [
        { id: 'g-shop', name: 'shop' },
        { id: 'g-ops', name: 'ops' },
      ],
      activeWorkspaceId: members[0].id,
    })
    useLayoutStore.setState({
      byWorkspace: Object.fromEntries(
        members.map((m) => {
          const panes = panesOf(m).map((id) => ({ ...createPane('terminal'), id, title: id }))
          return [
            m.id,
            {
              root: { type: 'tabs', id: `tabs-${m.id}`, children: panes, activeId: panes[0].id },
              activePaneId: panes[0].id,
              zoomedPaneId: null,
            },
          ]
        }),
      ) as never,
    })
    const agents = members.flatMap((m) => m.agents ?? [])
    useBlocksStore.setState({
      running: Object.fromEntries(agents.map((id) => [id, `b-${id}`])),
      agentBlocks: Object.fromEntries(
        agents.map((id) => [id, { blockId: `b-${id}`, agent: 'claude' as const }]),
      ),
    })
    useSandboxStore.setState({
      enabled: Object.fromEntries(members.map((m) => [m.id, m.sandboxed === true])),
    })
    useAgentGroupsStore.getState().setPlacements([])
    usePaneRecencyStore.setState({ touchedAt: { 'p-api-new': 20, 'p-api-old': 10, 'p-docs': 5 } })
  }

  const offered = (workspaceId: string): string[] =>
    renderHook(() => useAgentTargets(workspaceId)).result.current.map((t) => t.paneId)

  it('lists the agents of the other workspaces of the group after its own, named by workspace', () => {
    seed(GROUPED)

    const { result } = renderHook(() => useAgentTargets('w-web'))

    expect(result.current.map((t) => t.paneId)).toEqual([
      'p-web',
      'p-api-new',
      'p-api-old',
      'p-docs',
    ])
    expect(result.current[0]).toMatchObject({ sameWorkspace: true, title: 'Claude Code · p-web' })
    expect(result.current[1]).toMatchObject({
      workspaceId: 'w-api',
      sameWorkspace: false,
      title: 'Claude Code · p-api-new (api)',
    })
    expect(result.current.every((t) => t.via === undefined)).toBe(true)
  })

  it('offers an ungrouped workspace only its own agents, and gives none of them to a group', () => {
    seed(GROUPED)

    expect(offered('w-loose')).toEqual(['p-loose'])
    expect(offered('w-infra')).toEqual(['p-infra'])
  })

  it('leaves out a sandboxed member, and offers a sandboxed workspace nothing from its group', () => {
    seed(GROUPED.map((m) => (m.id === 'w-api' ? { ...m, sandboxed: true } : m)))

    expect(offered('w-web')).toEqual(['p-web', 'p-docs'])
    expect(offered('w-api')).toEqual(['p-api-new', 'p-api-old'])
  })

  it('leaves out a scratch member and a member holding the manager, on either side', () => {
    seed(
      GROUPED.map((m) =>
        m.id === 'w-api'
          ? { ...m, kind: 'scratch' as const }
          : m.id === 'w-docs'
            ? { ...m, kind: 'manager' as const }
            : m,
      ),
    )

    expect(offered('w-web')).toEqual(['p-web'])
    expect(offered('w-api')).toEqual(['p-api-new', 'p-api-old'])
    expect(offered('w-docs')).toEqual(['p-docs'])
  })

  it('counts a membership an agent set only after the human confirmed it', () => {
    seed(GROUPED)
    useAgentGroupsStore.getState().setPlacements([{ workspaceId: 'w-api', groupId: 'g-shop' }])

    const { result } = renderHook(() => useAgentTargets('w-web'))
    expect(result.current.map((t) => t.paneId)).toEqual(['p-web', 'p-docs'])
    expect(offered('w-api')).toEqual(['p-api-new', 'p-api-old'])

    act(() => useAgentGroupsStore.getState().setPlacements([]))

    expect(result.current.map((t) => t.paneId)).toEqual([
      'p-web',
      'p-api-new',
      'p-api-old',
      'p-docs',
    ])
  })

  it('counts a group the human moved the workspace to after an agent put it elsewhere', () => {
    seed(GROUPED)
    useAgentGroupsStore.getState().setPlacements([{ workspaceId: 'w-api', groupId: 'g-ops' }])

    expect(offered('w-web')).toEqual(['p-web', 'p-api-new', 'p-api-old', 'p-docs'])
  })

  it('offers nothing from the group until main said which memberships agents set', () => {
    seed(GROUPED)
    useAgentGroupsStore.setState({ placements: null })

    expect(offered('w-web')).toEqual(['p-web'])
  })

  it('asks main whether a member is sandboxed before offering its agents', async () => {
    seed(GROUPED)
    useSandboxStore.setState({ enabled: { 'w-web': false, 'w-docs': false } })
    vi.mocked(window.ostia.sandbox.get).mockImplementation(async (id) =>
      id === 'w-api' ? ({ enabled: false } as never) : null,
    )

    const { result } = renderHook(() => useAgentTargets('w-web'))
    expect(result.current.map((t) => t.paneId)).toEqual(['p-web', 'p-docs'])

    await waitFor(() =>
      expect(result.current.map((t) => t.paneId)).toEqual([
        'p-web',
        'p-api-new',
        'p-api-old',
        'p-docs',
      ]),
    )
  })

  it('keeps the group out of the list that presses Enter', () => {
    seed(GROUPED)

    const { result } = renderHook(() => useLocalAgentTargets('w-web'))

    expect(result.current.map((t) => t.paneId)).toEqual(['p-web'])
  })

  it('says the group runs no agent either when a grouped workspace finds none', () => {
    seed(
      GROUPED.map((m) => ({
        ...m,
        shells: [...(m.agents ?? []), ...(m.shells ?? [])],
        agents: [],
      })),
    )

    expect(renderHook(() => useNoAgentsText('w-web')).result.current).toBe(
      'No agent is running in this workspace or its group.',
    )
    expect(renderHook(() => useNoAgentsText('w-loose')).result.current).toBe(
      'No agent is running in this workspace.',
    )
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
