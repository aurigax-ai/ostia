import { describe, expect, it, vi } from 'vitest'
import type { PaneEntry } from '../panes/paneList'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { RESUME_CLAIM_MS, createResumeClaimer } = await import('./resumeClaims')

const session = { agent: 'claude' as const, id: 'd27bd196' }

function pane(paneId: string, workspaceId: string, extra: Partial<PaneEntry> = {}): PaneEntry {
  return {
    paneId,
    workspaceId,
    kind: 'terminal',
    title: `${paneId} tab`,
    running: false,
    blockCount: 0,
    agentSessionId: session.id,
    ...extra,
  }
}

describe('resume claims across windows', () => {
  it('lets only one of two windows resume the same session at the same time', async () => {
    const windowA = pane('a1', 'wa')
    const windowB = pane('b1', 'wb')
    const claim = createResumeClaimer(async () => [windowA, windowB])

    const [fromA, fromB] = await Promise.all([claim('a1', session), claim('b1', session)])

    expect(fromA).toEqual({ ok: true })
    expect(fromB).toEqual({ ok: false, holder: 'a1 tab' })
  })

  it('refuses a session whose agent runs in another window', async () => {
    const live = pane('a1', 'wa', { agent: 'claude', running: true })
    const claim = createResumeClaimer(async () => [live, pane('b1', 'wb')])

    expect(await claim('b1', session)).toEqual({ ok: false, holder: 'a1 tab' })
    expect(await claim('b1', { agent: 'claude', id: 'other-1' })).toEqual({ ok: true })
  })

  it('frees a claim whose resume never started an agent, or whose pane closed', async () => {
    let now = 1000
    let panes = [pane('a1', 'wa'), pane('b1', 'wb'), pane('c1', 'wc')]
    const claim = createResumeClaimer(
      async () => panes,
      () => now,
    )

    expect(await claim('a1', session)).toEqual({ ok: true })
    now += RESUME_CLAIM_MS
    expect(await claim('b1', session)).toEqual({ ok: true })
    panes = panes.filter((p) => p.paneId !== 'b1')
    expect(await claim('c1', session)).toEqual({ ok: true })
  })
})
