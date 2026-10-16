import { describe, expect, it, vi } from 'vitest'
import { PaneLifecycleEvents } from './paneLifecycleEvents'

describe('PaneLifecycleEvents', () => {
  it('sends the external pane id, its workspace and the state, and nothing for a pane it does not know', () => {
    const emit = vi.fn()
    const events = new PaneLifecycleEvents({
      identity: (paneId) =>
        paneId === 'p1' ? { externalId: 'ext-1', workspaceId: 'w1' } : undefined,
      emit,
    })
    events.change('p1', 'hibernated')
    events.change('p1', 'woken')
    events.change('gone', 'woken')
    expect(emit.mock.calls).toEqual([
      [{ paneId: 'ext-1', workspaceId: 'w1', state: 'hibernated' }],
      [{ paneId: 'ext-1', workspaceId: 'w1', state: 'woken' }],
    ])
  })
})
