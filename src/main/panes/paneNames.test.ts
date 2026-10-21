import { beforeEach, describe, expect, it } from 'vitest'
import { adoptPane, registerPane, removePane, removeWindow } from '../control/idRegistry'
import {
  claimName,
  dropName,
  dropNamesWhere,
  forgetNames,
  nameOf,
  noteAgentSession,
  paneNamed,
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
    expect(claimName('p1', 'boss', 'plans')).toEqual({
      ok: true,
      held: { name: 'boss', desc: 'plans' },
    })
    expect(claimName('p2', 'boss', undefined)).toEqual({
      ok: false,
      error: 'name-taken',
      name: 'boss',
      holder: 'p1',
    })
    expect(paneNamed('boss')).toBe('p1')
    expect(nameOf('p2')).toBeUndefined()
  })

  it('refuses a name held anywhere, whatever the claimer reaches, until the holder drops it', () => {
    claimName('far-1', 'boss', undefined)
    expect(claimName('far-2', 'boss', undefined)).toMatchObject({
      ok: false,
      error: 'name-taken',
      holder: 'far-1',
    })
    dropName('far-1')
    expect(claimName('far-2', 'boss', undefined)).toMatchObject({ ok: true })
    expect(paneNamed('boss')).toBe('far-2')
  })

  it('lets the holder claim again, which frees its old name', () => {
    claimName('p1', 'boss', undefined)
    expect(claimName('p1', 'boss', 'again').ok).toBe(true)
    claimName('p1', 'lead', undefined)
    expect(paneNamed('boss')).toBeUndefined()
    expect(claimName('p2', 'boss', undefined).ok).toBe(true)
  })

  it('clears a name and frees it', () => {
    claimName('p1', 'boss', undefined)
    expect(dropName('p1')).toBe(true)
    expect(dropName('p1')).toBe(false)
    expect(paneNamed('boss')).toBeUndefined()
  })
})

describe('when a name goes away', () => {
  it('drops the name when the pane identity is removed (pane closed)', () => {
    registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'close-me' })
    claimName('close-me', 'closing', undefined)
    removePane('close-me')
    expect(paneNamed('closing')).toBeUndefined()
  })

  it('drops every name of a window that closed and keeps the other window’s', () => {
    registerPane({ windowId: 'win-a', workspaceId: 's1', paneId: 'in-a' })
    registerPane({ windowId: 'win-b', workspaceId: 's2', paneId: 'in-b' })
    claimName('in-a', 'name-a', undefined)
    claimName('in-b', 'name-b', undefined)
    removeWindow('win-a')
    expect(paneNamed('name-a')).toBeUndefined()
    expect(paneNamed('name-b')).toBe('in-b')
  })

  it('drops the name of a kept shell that reattaches under a new identity', () => {
    registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'kept-1' })
    claimName('kept-1', 'kept-name', undefined)
    adoptPane({ windowId: 'w2', workspaceId: 's1', paneId: 'kept-1' })
    expect(paneNamed('kept-name')).toBeUndefined()
  })

  it('keeps the name when the window only reloads and registers its panes again', () => {
    registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'reload-1' })
    claimName('reload-1', 'reloaded', undefined)
    registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'reload-1' })
    expect(paneNamed('reloaded')).toBe('reload-1')
  })

  it('drops the names of the panes a predicate picks (workspace closed)', () => {
    claimName('p1', 'one', undefined)
    claimName('p2', 'two', undefined)
    dropNamesWhere((paneId) => paneId === 'p1')
    expect(paneNamed('one')).toBeUndefined()
    expect(paneNamed('two')).toBe('p2')
  })

  it('drops the name when the agent session changes, and keeps it for the same session', () => {
    noteAgentSession('p1', 'claude', 's-1')
    claimName('p1', 'boss', undefined)
    noteAgentSession('p1', 'claude', 's-1')
    expect(paneNamed('boss')).toBe('p1')
    noteAgentSession('p1', 'claude', 's-2')
    expect(paneNamed('boss')).toBeUndefined()
  })

  it('drops the name when the agent kind changes', () => {
    noteAgentSession('p1', 'claude', 'same')
    claimName('p1', 'boss', undefined)
    noteAgentSession('p1', 'codex', 'same')
    expect(paneNamed('boss')).toBeUndefined()
  })
})
