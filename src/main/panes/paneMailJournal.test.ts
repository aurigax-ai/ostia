import { describe, expect, it, vi } from 'vitest'

const { journalDelivered } = await import('./paneMailJournal')
const { registerPane } = await import('../control/idRegistry')

const worker = registerPane({ windowId: '1', workspaceId: 'ws1', paneId: 'pmj-worker' })
const observation = (phase: 'queued' | 'delivered' | 'failed', to: string) => ({
  id: 'm1',
  from: 'ostia',
  to,
  kind: 'message' as const,
  phase,
})

describe('journalDelivered', () => {
  it('records a delivered message in the receiving pane’s journal, and nothing else', () => {
    const journal = { mail: vi.fn() }
    journalDelivered(journal, observation('queued', worker.externalId))
    journalDelivered(journal, observation('failed', worker.externalId))
    journalDelivered(journal, observation('delivered', 'not-a-pane'))
    expect(journal.mail).not.toHaveBeenCalled()
    journalDelivered(journal, observation('delivered', worker.externalId))
    expect(journal.mail).toHaveBeenCalledWith(worker.paneId)
  })
})
