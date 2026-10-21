import { afterEach, describe, expect, it } from 'vitest'
import { toolbarStateOf, usePanelToolbarStore } from './panelToolbarStore'

const store = () => usePanelToolbarStore.getState()
const shown = (extId: string) => toolbarStateOf(store().entries, extId, 'w1')

afterEach(() => usePanelToolbarStore.setState({ entries: [], pending: {} }))

describe('panelToolbarStore', () => {
  it('keeps a chosen tab through an update that does not carry it, then lets the page confirm it', () => {
    store().setEntries([{ extId: 'a', workspaceId: 'w1', state: { tab: 'board' } }])
    store().selectTab('a', 'w1', 'vault')
    store().setEntries([
      { extId: 'a', workspaceId: 'w1', state: { tab: 'board' } },
      { extId: 'b', workspaceId: 'w1', state: { tab: 'x' } },
    ])
    expect(shown('a').tab).toBe('vault')
    expect(shown('b').tab).toBe('x')
    store().setEntries([{ extId: 'a', workspaceId: 'w1', state: { tab: 'vault' } }])
    expect(shown('a').tab).toBe('vault')
    expect(store().pending).toEqual({})
  })

  it('takes the state the page sends when it differs from what was shown before the click', () => {
    store().setEntries([{ extId: 'a', workspaceId: 'w1', state: { tab: 'board' } }])
    store().selectTab('a', 'w1', 'vault')
    store().setEntries([{ extId: 'a', workspaceId: 'w1', state: { tab: 'board', back: 'Edit' } }])
    expect(shown('a')).toEqual({ tab: 'board', back: 'Edit' })
    expect(store().pending).toEqual({})
  })

  it('shows a chosen tab before any state exists', () => {
    store().selectTab('a', 'w1', 'vault')
    store().setEntries([])
    expect(shown('a').tab).toBe('vault')
  })
})
