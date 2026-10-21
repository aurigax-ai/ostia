import { beforeEach, describe, expect, it } from 'vitest'
import { adoptPane, registerPane, removePane, removeWindow } from '../control/idRegistry'
import {
  claimName,
  dropName,
  dropNamesWhere,
  forgetNames,
  nameOf,
  noteAgentSession,
  panesNamed,
  parseDesc,
  parseName,
} from './paneNames'

beforeEach(forgetNames)

describe('names', () => {
  it('takes a short lowercase slug and refuses anything else, upper case included', () => {
    expect(parseName('coordinator.2')).toEqual({ name: 'coordinator.2' })
    for (const bad of [
      '',
      'Coordinator',
      ' boss',
      'a b',
      '-x',
      'x-',
      'é',
      'a/b',
      'x'.repeat(41),
      5,
      undefined,
      'a\nb',
    ]) {
      expect(parseName(bad), String(bad)).toHaveProperty('message')
    }
  })

  it('refuses a name that reads as a pane id, so it cannot shadow an id prefix', () => {
    expect(parseName('3f6a7ced')).toHaveProperty('message')
    expect(parseName('3f6a7ced-1c2d')).toHaveProperty('message')
    expect(parseName('3f6a7c')).toEqual({ name: '3f6a7c' })
    expect(parseName('3f6a7cedz')).toEqual({ name: '3f6a7cedz' })
  })

  it('takes one line of description and refuses control and format characters', () => {
    expect(parseDesc(undefined)).toEqual({ desc: undefined })
    expect(parseDesc('  builds #1365 ')).toEqual({ desc: 'builds #1365' })
    expect(parseDesc('   ')).toEqual({ desc: undefined })
    for (const bad of ['a\nb', 'a\u001b[31m', 'a‮b', 'x'.repeat(201), 3]) {
      expect(parseDesc(bad), String(bad)).toHaveProperty('message')
    }
  })

  it('has one live holder per name and refuses a second pane without taking it over', () => {
    expect(claimName('p1', 'boss', 'plans', () => true)).toEqual({
      ok: true,
      held: { name: 'boss', desc: 'plans' },
    })
    expect(claimName('p2', 'boss', undefined, () => true)).toEqual({
      ok: false,
      error: 'name-taken',
      name: 'boss',
      holder: 'p1',
    })
    expect(panesNamed('boss')).toEqual(['p1'])
    expect(nameOf('p2')).toBeUndefined()
  })

  it('lets two panes that cannot reach each other hold the same name', () => {
    claimName('far-1', 'boss', undefined, () => true)
    expect(claimName('far-2', 'boss', undefined, () => false)).toMatchObject({ ok: true })
    expect(panesNamed('boss')).toEqual(['far-1', 'far-2'])
    expect(claimName('near', 'boss', undefined, (holder) => holder === 'far-2')).toMatchObject({
      ok: false,
      error: 'name-taken',
      holder: 'far-2',
    })
  })

  it('frees only the dropped pane’s share of a shared name', () => {
    claimName('far-1', 'boss', undefined, () => false)
    claimName('far-2', 'boss', undefined, () => false)
    dropName('far-1')
    expect(panesNamed('boss')).toEqual(['far-2'])
  })

  it('lets the holder claim again, which frees its old name', () => {
    claimName('p1', 'boss', undefined, () => true)
    expect(claimName('p1', 'boss', 'again', () => true).ok).toBe(true)
    claimName('p1', 'lead', undefined, () => true)
    expect(panesNamed('boss')).toEqual([])
    expect(claimName('p2', 'boss', undefined, () => true).ok).toBe(true)
  })

  it('clears a name and frees it', () => {
    claimName('p1', 'boss', undefined, () => true)
    expect(dropName('p1')).toBe(true)
    expect(dropName('p1')).toBe(false)
    expect(panesNamed('boss')).toEqual([])
  })
})

describe('when a name goes away', () => {
  it('drops the name when the pane identity is removed (pane closed)', () => {
    registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'close-me' })
    claimName('close-me', 'closing', undefined, () => true)
    removePane('close-me')
    expect(panesNamed('closing')).toEqual([])
  })

  it('drops every name of a window that closed and keeps the other window’s', () => {
    registerPane({ windowId: 'win-a', workspaceId: 's1', paneId: 'in-a' })
    registerPane({ windowId: 'win-b', workspaceId: 's2', paneId: 'in-b' })
    claimName('in-a', 'name-a', undefined, () => true)
    claimName('in-b', 'name-b', undefined, () => true)
    removeWindow('win-a')
    expect(panesNamed('name-a')).toEqual([])
    expect(panesNamed('name-b')).toEqual(['in-b'])
  })

  it('drops the name of a kept shell that reattaches under a new identity', () => {
    registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'kept-1' })
    claimName('kept-1', 'kept-name', undefined, () => true)
    adoptPane({ windowId: 'w2', workspaceId: 's1', paneId: 'kept-1' })
    expect(panesNamed('kept-name')).toEqual([])
  })

  it('keeps the name when the window only reloads and registers its panes again', () => {
    registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'reload-1' })
    claimName('reload-1', 'reloaded', undefined, () => true)
    registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'reload-1' })
    expect(panesNamed('reloaded')).toEqual(['reload-1'])
  })

  it('drops the names of the panes a predicate picks (workspace closed)', () => {
    claimName('p1', 'one', undefined, () => true)
    claimName('p2', 'two', undefined, () => true)
    dropNamesWhere((paneId) => paneId === 'p1')
    expect(panesNamed('one')).toEqual([])
    expect(panesNamed('two')).toEqual(['p2'])
  })

  it('drops the name when the agent session changes, and keeps it for the same session', () => {
    noteAgentSession('p1', 'claude', 's-1')
    claimName('p1', 'boss', undefined, () => true)
    noteAgentSession('p1', 'claude', 's-1')
    expect(panesNamed('boss')).toEqual(['p1'])
    noteAgentSession('p1', 'claude', 's-2')
    expect(panesNamed('boss')).toEqual([])
  })

  it('drops the name when the agent kind changes', () => {
    noteAgentSession('p1', 'claude', 'same')
    claimName('p1', 'boss', undefined, () => true)
    noteAgentSession('p1', 'codex', 'same')
    expect(panesNamed('boss')).toEqual([])
  })
})
