import type { ExtensionCaller, OstiaExtension, ParkedItem } from '@aurigax-ai/ostia-extension-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from './hookEvent'
import { Journal } from './journal'
import { createOpenListing, LISTING_TTL_MS } from './openListing'
import { activityPanelCommands } from './panelCommands'
import { RememberStore } from './remember'

const caller = { workspaceId: 'w1' } as ExtensionCaller

function setup() {
  let now = 1_000_000
  const journal = new Journal({ dir: null, now: () => now })
  const hostJournal = new Journal({ dir: null, now: () => now })
  const listWorkspaces = vi.fn(async () => [{ workspaceId: 'w1', name: 'shop' }])
  const titles = { current: 'Fix upload' }
  const states = { current: 'working' }
  const listPanes = vi.fn(async () => [
    { paneId: 'p1', title: titles.current, agentState: states.current },
  ])
  const listing = createOpenListing({ listWorkspaces, listPanes, now: () => now })
  const changed = vi.fn()
  const parked: { items: ParkedItem[] } = { items: [] }
  const parkedList = vi.fn(async () => ({ ok: true as const, items: parked.items }))
  const parkedResume = vi.fn(async (_id: string) => ({ ok: true as const }))
  const parkedForget = vi.fn(async (_id: string) => ({ ok: true as const }))
  const remembered = new RememberStore({ dir: null, now: () => now })
  const commands = activityPanelCommands({
    ext: { parkedList, parkedResume, parkedForget } as unknown as OstiaExtension,
    journal,
    hostJournal,
    remembered,
    state: { showActivity: true, rememberDays: 14 },
    settingsLoaded: Promise.resolve(),
    listing,
    changed,
  })
  const record = (text: string): ActivityEvent => ({
    v: 2,
    t: now,
    id: 'eventidaaa',
    pane: 'p1',
    agent: 'claude',
    session: 's',
    kind: 'prompt',
    text,
  })
  const snapshot = async (rev?: string) =>
    (await commands.snapshot(rev === undefined ? {} : { rev }, caller)) as {
      ok: boolean
      data: {
        unchanged?: true
        rev?: string
        workspace?: { agents: { label: { title?: string } }[] }
      }
    }
  return {
    journal,
    remembered,
    parked,
    parkedResume,
    parkedForget,
    commands,
    listing,
    listWorkspaces,
    listPanes,
    titles,
    states,
    record,
    snapshot,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('snapshot', () => {
  it('answers unchanged for the revision it handed out, and lists panes once for any number of asks', async () => {
    const s = setup()
    s.journal.append('w1', s.record('go'), false)
    const first = await s.snapshot()
    expect(first.data.rev).toBeTruthy()
    expect(first.data.workspace?.agents[0].label.title).toBe('Fix upload')

    for (let i = 0; i < 5; i++) {
      expect((await s.snapshot(first.data.rev)).data).toEqual({ unchanged: true })
    }
    expect(s.listPanes).toHaveBeenCalledTimes(1)
    expect(s.listWorkspaces).toHaveBeenCalledTimes(1)
  })

  it('sends a new model once the journal of that workspace changes, and not for another workspace', async () => {
    const s = setup()
    s.journal.append('w1', s.record('go'), false)
    const first = await s.snapshot()
    s.journal.append('w2', s.record('elsewhere'), false)
    expect((await s.snapshot(first.data.rev)).data.unchanged).toBe(true)
    s.journal.append('w1', s.record('again'), false)
    const next = await s.snapshot(first.data.rev)
    expect(next.data.unchanged).toBeUndefined()
    expect(next.data.rev).not.toBe(first.data.rev)
  })

  it('refreshes the pane titles at most once per window, and at once after a pane event', async () => {
    const s = setup()
    s.journal.append('w1', s.record('go'), false)
    const first = await s.snapshot()
    s.titles.current = 'Renamed'

    s.advance(LISTING_TTL_MS - 1)
    expect((await s.snapshot(first.data.rev)).data.unchanged).toBe(true)
    expect(s.listPanes).toHaveBeenCalledTimes(1)

    s.advance(2)
    const renamed = await s.snapshot(first.data.rev)
    expect(s.listPanes).toHaveBeenCalledTimes(2)
    expect(renamed.data.workspace?.agents[0].label.title).toBe('Renamed')

    s.titles.current = 'Again'
    s.listing.invalidate()
    const again = await s.snapshot(renamed.data.rev)
    expect(s.listPanes).toHaveBeenCalledTimes(3)
    expect(again.data.workspace?.agents[0].label.title).toBe('Again')
  })

  it('shows a status change at once after a pane event, with a new revision', async () => {
    const s = setup()
    s.journal.append('w1', s.record('go'), false)
    const first = await s.snapshot()
    s.states.current = 'done'
    expect((await s.snapshot(first.data.rev)).data.unchanged).toBe(true)
    s.listing.invalidate()
    const next = await s.snapshot(first.data.rev)
    expect(next.data.rev).not.toBe(first.data.rev)
    expect((next.data.workspace?.agents[0] as unknown as { state?: string }).state).toBe('done')
  })

  it('fails as unavailable when the panes cannot be listed', async () => {
    const s = setup()
    s.listPanes.mockRejectedValueOnce(new Error('down'))
    expect(await s.snapshot()).toMatchObject({ ok: false, error: 'unavailable' })
    expect((await s.snapshot()).ok).toBe(true)
  })
})

describe('parked sessions and remembered tasks in the snapshot', () => {
  const item = (id: string, sessionId = 's1'): ParkedItem => ({
    id,
    workspaceId: 'w1',
    agent: 'claude',
    sessionId,
    title: 'export-tests',
    summary: 'Flaky on CI',
    folder: '/home/u/work/api',
    parkedAt: 1_000_000,
  })

  it('lists the workspace’s parked items with the tasks remembered for their session and a new revision when one is parked', async () => {
    const s = setup()
    const first = await s.snapshot()
    s.parked.items = [item('parkeda001')]
    s.remembered.add(
      'w1',
      {
        v: 1,
        id: 'taskaaaaaa',
        t: 1_000_000,
        pane: 'gone',
        session: 's1',
        agent: 'claude',
        text: 'Bisect',
        state: 'open',
      },
      false,
    )
    const next = (await s.snapshot(first.data.rev)) as unknown as {
      data: {
        parked: { id: string; tasks: number }[]
        remember: { groups: { open: { where: string }[] } }
      }
    }
    expect(next.data.parked).toEqual([expect.objectContaining({ id: 'parkeda001', tasks: 1 })])
    expect(next.data.remember.groups.open[0]?.where).toBe('parked')
  })

  it('resumes and forgets only an item of the caller’s workspace and passes the refusal on', async () => {
    const s = setup()
    s.parked.items = [item('parkeda001')]
    expect(await s.commands.parkedResume({ id: 'parkeda001' }, caller)).toEqual({ ok: true })
    expect(s.parkedResume).toHaveBeenCalledWith('parkeda001')
    expect(await s.commands.parkedForget({ id: 'parkeda001' }, caller)).toEqual({ ok: true })
    expect(s.parkedForget).toHaveBeenCalledWith('parkeda001')
    expect(await s.commands.parkedResume({ id: 'other00000' }, caller)).toMatchObject({
      ok: false,
      error: 'unknown-parked',
    })
    expect(await s.commands.parkedResume({}, caller)).toMatchObject({
      ok: false,
      error: 'invalid-args',
    })
    s.parkedResume.mockResolvedValueOnce({
      ok: false,
      error: 'folder-gone',
      message: '/home/u/work/api',
    } as never)
    expect(await s.commands.parkedResume({ id: 'parkeda001' }, caller)).toEqual({
      ok: false,
      error: 'folder-gone',
      message: '/home/u/work/api',
    })
  })

  it('moves a remembered task between states for the caller’s workspace only', async () => {
    const s = setup()
    s.remembered.add(
      'w1',
      {
        v: 1,
        id: 'taskaaaaaa',
        t: 1_000_000,
        pane: 'p1',
        session: 's1',
        agent: 'claude',
        text: 'Bisect',
        state: 'open',
      },
      false,
    )
    expect(await s.commands.rememberState({ id: 'taskaaaaaa', state: 'done' }, caller)).toEqual({
      ok: true,
    })
    expect(s.remembered.find('w1', 'taskaaaaaa')?.state).toBe('done')
    expect(await s.commands.rememberState({ id: 'taskaaaaaa', state: 'open' }, caller)).toEqual({
      ok: true,
    })
    expect(s.remembered.find('w1', 'taskaaaaaa')?.state).toBe('open')
    expect(
      await s.commands.rememberState({ id: 'taskaaaaaa', state: 'open' }, {
        workspaceId: 'w2',
      } as ExtensionCaller),
    ).toMatchObject({ ok: false })
    expect(
      await s.commands.rememberState({ id: 'taskaaaaaa', state: 'gone' }, caller),
    ).toMatchObject({ ok: false, error: 'invalid-args' })
  })
})
