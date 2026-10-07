import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const guests = new Map<number, { id: number; isDestroyed: () => boolean }>()

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: (id: number) => guests.get(id) ?? null },
}))
vi.mock('./controlElevation', () => ({ ensureCaps: vi.fn(async () => {}) }))

const { ensureCaps } = await import('./controlElevation')
const { SHARED_PROFILE_DETAIL, defaultBrowserPane, resolveGuest } = await import('./browse')
const { registerPane, removePane } = await import('./idRegistry')
const { ownWorkspaceReach } = await import('../../test/reach')

const shared = new Set<string>()
const browserPanes = new Map<string, number>()
const deps = {
  browserPanes,
  isSharedPane: (paneId: string) => shared.has(paneId),
  reach: ownWorkspaceReach(),
}

let caller: ReturnType<typeof registerPane>
let humanTab: ReturnType<typeof registerPane>
let agentTab: ReturnType<typeof registerPane>

function ctx() {
  return { identity: caller, authed: { externalId: caller.externalId } as never }
}

beforeAll(() => {
  caller = registerPane({ windowId: 'w1', workspaceId: 'ws', paneId: 'term' })
  humanTab = registerPane({ windowId: 'w1', workspaceId: 'ws', paneId: 'human-tab' })
  agentTab = registerPane({ windowId: 'w1', workspaceId: 'ws', paneId: 'agent-tab' })
})

afterAll(() => {
  for (const id of ['term', 'human-tab', 'agent-tab']) removePane(id)
})

beforeEach(() => {
  vi.mocked(ensureCaps).mockReset()
  vi.mocked(ensureCaps).mockResolvedValue(undefined)
  guests.clear()
  browserPanes.clear()
  shared.clear()
  guests.set(1, { id: 1, isDestroyed: () => false })
  guests.set(2, { id: 2, isDestroyed: () => false })
  browserPanes.set('human-tab', 1)
  shared.add('human-tab')
})

describe('resolveGuest on the human’s shared browser profile', () => {
  it('asks for credentials with a card that says it is the human’s signed-in browser', async () => {
    const res = await resolveGuest(deps, ctx(), humanTab.externalId)
    expect(res).toMatchObject({ ok: true, rendererPaneId: 'human-tab' })
    expect(ensureCaps).toHaveBeenCalledTimes(1)
    const [, identity, caps, action, detail] = vi.mocked(ensureCaps).mock.calls[0]
    expect(identity).toBe(caller)
    expect(caps).toEqual(['credentials'])
    expect(action).toBe('browse')
    expect(detail).toContain(SHARED_PROFILE_DETAIL)
    expect(detail).toContain('signed-in browser')
  })

  it('does not reach the page when the human denies the card', async () => {
    vi.mocked(ensureCaps).mockRejectedValue(new Error('denied: credentials'))
    await expect(resolveGuest(deps, ctx(), humanTab.externalId)).rejects.toThrow('denied')
  })

  it('reports needs-elevation when no card can be shown', async () => {
    vi.mocked(ensureCaps).mockRejectedValue(new Error('needs-elevation: credentials'))
    expect(await resolveGuest(deps, ctx(), humanTab.externalId)).toEqual({
      ok: false,
      error: 'needs-elevation',
    })
  })

  it('drives an isolated pane in the caller’s workspace without asking', async () => {
    browserPanes.set('agent-tab', 2)
    const res = await resolveGuest(deps, ctx(), agentTab.externalId)
    expect(res).toMatchObject({ ok: true, rendererPaneId: 'agent-tab' })
    expect(ensureCaps).not.toHaveBeenCalled()
  })
})

describe('the default browser pane', () => {
  it('never falls back to the human’s shared pane', async () => {
    expect(defaultBrowserPane(deps, ctx())).toBeUndefined()
    expect(await resolveGuest(deps, ctx())).toEqual({ ok: false, error: 'no-browser-pane' })
    expect(ensureCaps).not.toHaveBeenCalled()
  })

  it('picks an isolated pane over the shared one', async () => {
    browserPanes.set('agent-tab', 2)
    expect(defaultBrowserPane(deps, ctx())).toBe('agent-tab')
    expect(await resolveGuest(deps, ctx())).toMatchObject({ ok: true, rendererPaneId: 'agent-tab' })
    expect(ensureCaps).not.toHaveBeenCalled()
  })
})
