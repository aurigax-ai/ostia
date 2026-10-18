import type { ExtensionCaller, OstiaExtension } from '@aurigax-ai/ostia-extension-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from './hookEvent'
import { Journal } from './journal'
import { LISTING_TTL_MS, createOpenListing } from './openListing'
import { activityPanelCommands } from './panelCommands'

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
  const commands = activityPanelCommands({
    ext: {} as OstiaExtension,
    journal,
    hostJournal,
    state: { showActivity: true },
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
