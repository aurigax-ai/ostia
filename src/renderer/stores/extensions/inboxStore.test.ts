import { afterEach, describe, expect, it } from 'vitest'
import { inboxItemsOf, useInboxStore } from './inboxStore'

describe('inbox store', () => {
  const init = useInboxStore.getState()

  afterEach(() => {
    useInboxStore.setState(init, true)
  })

  it('keeps the entries main pushes and finds the items of one extension in one workspace', () => {
    const item = { id: 'abcdefghij', text: 'Set the key', at: 5 }
    useInboxStore.getState().setEntries([
      { extId: 'activity', workspaceId: 'w1', items: [item] },
      { extId: 'activity', workspaceId: 'w2', items: [{ ...item, id: 'bcdefghijk' }] },
    ])
    const { entries } = useInboxStore.getState()
    expect(inboxItemsOf(entries, 'activity', 'w1')).toEqual([item])
    expect(inboxItemsOf(entries, 'activity', 'w3')).toEqual([])
    expect(inboxItemsOf(entries, 'other', 'w1')).toEqual([])
  })

  it('answers the same empty list for every miss so a selector does not re-render', () => {
    const { entries } = useInboxStore.getState()
    expect(inboxItemsOf(entries, 'a', 'w1')).toBe(inboxItemsOf(entries, 'b', 'w2'))
  })
})
