import type { OstiaExtension } from '@aurigax-ai/ostia-extension-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { ActivityNote } from './hookEvent'
import { Journal } from './journal'
import { createNeedsYou } from './needsYou'

const NOW = 1_000_000

function note(id: string, extra: Partial<ActivityNote> = {}): ActivityNote {
  return { v: 2, t: NOW, id, pane: 'p1', kind: 'note', text: id, ...extra }
}

function setup() {
  const journal = new Journal({ dir: null, now: () => NOW })
  const ext = {
    setInboxItems: vi.fn(async (_workspaceId: string, _items: unknown[]) => ({ ok: true })),
    setSidebarItem: vi.fn(async (_item: unknown) => ({ ok: true })),
    startWithWindow: vi.fn(async () => ({ ok: true })),
  }
  const show = createNeedsYou({
    ext: ext as unknown as OstiaExtension,
    journal,
    translate: () => (key: string) => key,
    state: { locale: 'en' },
  })
  return { journal, ext, show }
}

describe('needs-you items published to the inbox', () => {
  it('sends the open items of each workspace with their pane and time, and clears a workspace once none is open', async () => {
    const { journal, ext, show } = setup()
    journal.append('w1', note('openaaaaaa', { needsYou: true, t: 5 }), false)
    journal.append('w1', note('plainnoteaa'), false)
    journal.append('w2', note('openbbbbbb', { needsYou: true, pane: 'p2' }), false)
    await show()
    expect(ext.setInboxItems).toHaveBeenCalledWith('w1', [
      { id: 'openaaaaaa', text: 'openaaaaaa', paneId: 'p1', at: 5 },
    ])
    expect(ext.setInboxItems).toHaveBeenCalledWith('w2', [
      { id: 'openbbbbbb', text: 'openbbbbbb', paneId: 'p2', at: NOW },
    ])
    journal.markDone('w1', 'openaaaaaa', NOW)
    ext.setInboxItems.mockClear()
    await show()
    expect(ext.setInboxItems).toHaveBeenCalledWith('w1', [])
  })

  it('sends at most fifty items', async () => {
    const { journal, ext, show } = setup()
    for (let i = 0; i < 60; i++) {
      journal.append('w1', note(`item${String(i).padStart(6, 'a')}`, { needsYou: true }), false)
    }
    await show()
    const items = ext.setInboxItems.mock.calls[0]?.[1] ?? []
    expect(items).toHaveLength(50)
  })

  it('shows the count once, as the badge, with a plain label as the text', async () => {
    const { journal, ext, show } = setup()
    journal.append('w1', note('openaaaaaa', { needsYou: true }), false)
    await show()
    expect(ext.setSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', text: 'needsYou', badge: '1' }),
    )
  })
})
