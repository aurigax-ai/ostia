import { afterEach, describe, expect, it } from 'vitest'
import { instanceKey, type PanelInstance } from '@/lib/panes/panelKeepAlive'
import { useSidePanelStore } from './sidePanelStore'

const state = () => useSidePanelStore.getState()
const at = (extId: string, workspaceId = 'w1'): PanelInstance => ({ extId, workspaceId })

describe('sidePanelStore', () => {
  const init = useSidePanelStore.getState()
  afterEach(() => useSidePanelStore.setState(init, true))

  it('starts with the side panel closed', () => {
    expect(state().right).toBeNull()
  })

  it('shows a panel, replaces it with another in the same place, and hides the shown one on toggle', () => {
    state().toggleRight('graphs')
    expect(state().right).toBe('graphs')
    state().toggleRight('activity')
    expect(state().right).toBe('activity')
    state().toggleRight('activity')
    expect(state().right).toBeNull()
  })

  it('hides whatever is shown', () => {
    state().showRight('graphs')
    state().hideRight()
    expect(state().right).toBeNull()
  })

  it('routes the instance of the workspace named, and only when a path comes with it', () => {
    state().showRight('keeper', { workspaceId: 'w1' })
    expect(state().routes).toEqual({})
    state().showRight('keeper', { workspaceId: 'w1', path: '/approvals' })
    state().showRight('keeper', { workspaceId: 'w2', path: '/log' })
    const routes = state().routes
    expect(routes[instanceKey(at('keeper', 'w1'))]?.path).toBe('/approvals')
    expect(routes[instanceKey(at('keeper', 'w2'))]?.path).toBe('/log')
  })

  it('gives a repeated route a new sequence number so the panel navigates again', () => {
    state().showRight('keeper', { workspaceId: 'w1', path: '/log' })
    const first = state().routes[instanceKey(at('keeper'))]
    state().showRight('keeper', { workspaceId: 'w1', path: '/log' })
    expect(state().routes[instanceKey(at('keeper'))]?.seq).toBeGreaterThan(first.seq)
  })

  it('keeps at most three live instances, least recently shown first out', () => {
    for (const id of ['a', 'b', 'c', 'd']) state().keep(at(id))
    expect(state().kept.map((i) => i.extId)).toEqual(['b', 'c', 'd'])
  })

  it('does not change state when the shown instance is already the most recent', () => {
    state().keep(at('a'))
    const kept = state().kept
    state().keep(at('a'))
    expect(state().kept).toBe(kept)
  })

  it('remembers once an instance was revealed, without duplicates', () => {
    state().reveal(at('graphs'))
    state().reveal(at('graphs'))
    expect(state().revealed).toEqual([instanceKey(at('graphs'))])
  })

  it('drops an extension from the kept set and closes the panel when it was shown', () => {
    state().keep(at('graphs'))
    state().keep(at('activity'))
    state().showRight('graphs')
    state().drop('graphs')
    expect(state().right).toBeNull()
    expect(state().kept.map((i) => i.extId)).toEqual(['activity'])
    state().showRight('activity')
    state().drop('graphs')
    expect(state().right).toBe('activity')
  })

  it('forgets the instances, routes and reveals of a workspace that is gone, and nothing else', () => {
    state().keep(at('graphs', 'w1'))
    state().keep(at('graphs', 'w2'))
    state().showRight('graphs', { workspaceId: 'w1', path: '/a' })
    state().showRight('graphs', { workspaceId: 'w2', path: '/b' })
    state().reveal(at('graphs', 'w1'))
    state().reveal(at('graphs', 'w2'))

    state().forgetWorkspaces(new Set(['w2']))

    expect(state().kept).toEqual([at('graphs', 'w2')])
    expect(state().revealed).toEqual([instanceKey(at('graphs', 'w2'))])
    expect(Object.keys(state().routes)).toEqual([instanceKey(at('graphs', 'w2'))])
  })

  it('unloads the instances of a workspace and asks again before they load there', () => {
    state().keep(at('graphs', 'w1'))
    state().keep(at('graphs', 'w2'))
    state().reveal(at('graphs', 'w1'))

    state().unload('w1')

    expect(state().kept).toEqual([at('graphs', 'w2')])
    expect(state().revealed).toEqual([])
  })
})
