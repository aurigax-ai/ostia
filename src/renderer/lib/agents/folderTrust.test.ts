import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFolderTrustStore } from '@/stores/agents/folderTrustStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

vi.mock('@/lib/terminal/blockActions', () => ({ runWhenIdle: vi.fn(() => vi.fn()) }))

const { runWhenIdle } = await import('@/lib/terminal/blockActions')
const {
  alwaysTrustWorkspaceFolders,
  claudeTrustGate,
  resumeAnyway,
  startFolderTrustAsks,
  trustForClaude,
} = await import('./folderTrust')
const { resumeWhenIdle } = await import('./resumeFolder')
const { resumeWorkspaces } = await import('./hibernationScheduler')

const folderTrust = () => vi.mocked(window.ostia.agentSession.folderTrust)
const trustFolder = () => vi.mocked(window.ostia.agentSession.trustFolder)

async function settled<T>(promise: Promise<T>): Promise<T | 'waiting'> {
  return Promise.race([promise, new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 20))])
}

const pane = (id: string) => ({
  type: 'pane' as const,
  id,
  title: 'claude',
  kind: 'terminal' as const,
})

function seedPanes(...ids: string[]): void {
  useLayoutStore.setState({
    byWorkspace: {
      w1: {
        root:
          ids.length === 1
            ? pane(ids[0])
            : { type: 'tabs', id: 't1', activeId: ids[0], children: ids.map(pane) },
        activePaneId: ids[0],
        zoomedPaneId: null,
      },
    },
  })
}

describe('claudeTrustGate', () => {
  let init: ReturnType<typeof useSettingsStore.getState>
  let layout: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    init = useSettingsStore.getState()
    layout = useLayoutStore.getState()
  })

  beforeEach(() => seedPanes('p1', 'p2'))

  afterEach(() => {
    vi.mocked(runWhenIdle).mockClear()
    useFolderTrustStore.setState({ byPane: {} })
    useSettingsStore.setState(init, true)
    useLayoutStore.setState(layout, true)
  })

  it('CFT-C9 goes on at once when the folder is trusted or not Ostia’s to offer', async () => {
    folderTrust().mockResolvedValueOnce({ state: 'trusted' })
    expect(await claudeTrustGate('p1', 'claude')).toBe(true)
    folderTrust().mockResolvedValueOnce({ state: 'unknown' })
    expect(await claudeTrustGate('p1', 'claude')).toBe(true)
    expect(await claudeTrustGate('p1', 'codex')).toBe(true)
    expect(folderTrust()).toHaveBeenCalledTimes(2)
    expect(useFolderTrustStore.getState().byPane).toEqual({})
  })

  it('CFT-C10 holds the resume on the note until the human picks Trust for Claude', async () => {
    folderTrust().mockResolvedValueOnce({ state: 'ask', folder: '/w/repo' })
    const gate = claudeTrustGate('p1', 'claude')
    expect(await settled(gate)).toBe('waiting')
    expect(useFolderTrustStore.getState().byPane).toEqual({
      p1: { folder: '/w/repo', kind: 'resume' },
    })
    expect(trustFolder()).not.toHaveBeenCalled()
    await trustForClaude('p1')
    expect(await gate).toBe(true)
    expect(trustFolder()).toHaveBeenCalledWith('p1', '/w/repo')
    expect(useFolderTrustStore.getState().byPane).toEqual({})
  })

  it('CFT-C11 Always turns the setting on and lets every waiting pane go on, trusted', async () => {
    folderTrust().mockResolvedValue({ state: 'ask', folder: '/w/repo' })
    const first = claudeTrustGate('p1', 'claude')
    const second = claudeTrustGate('p2', 'claude')
    await settled(first)
    await alwaysTrustWorkspaceFolders()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(
      trustFolder()
        .mock.calls.map(([pane]) => pane)
        .sort(),
    ).toEqual(['p1', 'p2'])
    expect(useSettingsStore.getState().agents.trustWorkspaceFolders).toBe(true)
  })

  it('CFT-C12 Resume anyway goes on without writing anything', async () => {
    folderTrust().mockResolvedValueOnce({ state: 'ask', folder: '/w/repo' })
    const gate = claudeTrustGate('p1', 'claude')
    await settled(gate)
    resumeAnyway('p1')
    expect(await gate).toBe(true)
    expect(trustFolder()).not.toHaveBeenCalled()
  })

  it('CFT-C13 an agent-driven resume never asks main or shows the note', async () => {
    folderTrust().mockResolvedValue({ state: 'ask', folder: '/w/repo' })
    resumeWhenIdle('p1', { agent: 'claude', id: 'abc' })
    const allowed = vi.mocked(runWhenIdle).mock.calls[0]?.[3]
    await allowed?.()
    expect(folderTrust()).not.toHaveBeenCalled()
    expect(useFolderTrustStore.getState().byPane).toEqual({})

    resumeWhenIdle('p1', { agent: 'claude', id: 'abc' }, undefined, undefined, undefined, true)
    const asking = vi.mocked(runWhenIdle).mock.calls[1]?.[3]
    void asking?.()
    await vi.waitFor(() =>
      expect(useFolderTrustStore.getState().byPane).toEqual({
        p1: { folder: '/w/repo', kind: 'resume' },
      }),
    )
    expect(folderTrust()).toHaveBeenCalledWith('p1')
    resumeAnyway('p1')
  })

  it('CFT-C36 asks main about the pane alone: the current account is the one every start uses', async () => {
    folderTrust().mockResolvedValue({ state: 'trusted' })
    await claudeTrustGate('p3', 'claude')
    expect(folderTrust()).toHaveBeenLastCalledWith('p3')
  })

  it('CFT-C30 a pane closed while its note waits stops the resume and leaves nothing behind', async () => {
    folderTrust().mockResolvedValue({ state: 'ask', folder: '/w/repo' })
    const gate = claudeTrustGate('p2', 'claude')
    await vi.waitFor(() =>
      expect(useFolderTrustStore.getState().byPane).toEqual({
        p2: { folder: '/w/repo', kind: 'resume' },
      }),
    )
    useLayoutStore.getState().closePane('w1', 'p2')
    expect(await gate).toBe(false)
    expect(useFolderTrustStore.getState().byPane).toEqual({})
  })

  it('CFT-C31 bulk resume moves on to the next wave while earlier panes wait on their notes', async () => {
    folderTrust().mockResolvedValue({ state: 'ask', folder: '/w/repo' })
    const ids = ['h1', 'h2', 'h3', 'h4']
    useLayoutStore.setState({
      byWorkspace: {
        w1: {
          root: {
            type: 'tabs',
            id: 't1',
            activeId: 'h1',
            children: ids.map((id) => ({
              ...pane(id),
              hibernated: true as const,
              resume: { agent: 'claude' as const, id: `s-${id}` },
            })),
          },
          activePaneId: 'h1',
          zoomedPaneId: null,
        },
      },
    })
    resumeWorkspaces(['w1'])
    expect(vi.mocked(runWhenIdle).mock.calls).toHaveLength(3)
    for (const call of vi.mocked(runWhenIdle).mock.calls.slice(0, 3)) void call[3]?.()
    await vi.waitFor(() => expect(vi.mocked(runWhenIdle).mock.calls).toHaveLength(4))
    for (const id of ids) resumeAnyway(id)
  })
})

describe('start asks from main', () => {
  let layout: ReturnType<typeof useLayoutStore.getState>
  let ask: (paneId: string, folder: string, inside: boolean) => void
  let stop: () => void
  const done = () => vi.mocked(window.ostia.agentSession.folderTrustDone)

  beforeAll(() => {
    layout = useLayoutStore.getState()
  })

  beforeEach(() => {
    seedPanes('p1', 'p2')
    vi.mocked(window.ostia.agentSession.onFolderTrustAsk).mockImplementationOnce((cb) => {
      ask = cb
      return () => {}
    })
    stop = startFolderTrustAsks()
    done().mockClear()
    trustFolder().mockClear()
  })

  afterEach(() => {
    stop()
    useFolderTrustStore.setState({ byPane: {} })
    useLayoutStore.setState(layout, true)
  })

  it('CFT-C71 an ask for a folder inside the workspace holds a start note with the Always choice', () => {
    ask('p1', '/w/repo', true)
    expect(useFolderTrustStore.getState().byPane).toEqual({
      p1: { folder: '/w/repo', kind: 'start' },
    })
    expect(done()).not.toHaveBeenCalled()
  })

  it('CFT-C72 an ask for a folder outside the workspace holds an outside note', () => {
    ask('p1', '/o/repo', false)
    expect(useFolderTrustStore.getState().byPane).toEqual({
      p1: { folder: '/o/repo', kind: 'outside' },
    })
  })

  it('CFT-C73 Trust writes the shown folder, then tells main the start can go on', async () => {
    ask('p1', '/o/repo', false)
    await trustForClaude('p1')
    expect(trustFolder()).toHaveBeenCalledWith('p1', '/o/repo')
    expect(done()).toHaveBeenCalledWith('p1')
    expect(useFolderTrustStore.getState().byPane).toEqual({})
  })

  it('CFT-C74 Let Claude ask tells main to go on and writes nothing', () => {
    ask('p1', '/o/repo', false)
    resumeAnyway('p1')
    expect(trustFolder()).not.toHaveBeenCalled()
    expect(done()).toHaveBeenCalledWith('p1')
  })

  it('CFT-C75 Always never trusts a folder outside the workspace', async () => {
    ask('p1', '/w/repo', true)
    ask('p2', '/o/repo', false)
    await alwaysTrustWorkspaceFolders()
    expect(trustFolder()).toHaveBeenCalledTimes(1)
    expect(trustFolder()).toHaveBeenCalledWith('p1', '/w/repo')
    resumeAnyway('p2')
  })

  it('CFT-C76 an ask for a pane that is gone tells main to go on and shows nothing', () => {
    ask('gone', '/o/repo', false)
    expect(done()).toHaveBeenCalledWith('gone')
    expect(useFolderTrustStore.getState().byPane).toEqual({})
  })

  it('CFT-C77 a pane closed while its start note waits tells main to go on', () => {
    ask('p2', '/o/repo', false)
    useLayoutStore.getState().closePane('w1', 'p2')
    expect(done()).toHaveBeenCalledWith('p2')
    expect(useFolderTrustStore.getState().byPane).toEqual({})
  })
})
