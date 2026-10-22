import { beforeEach, describe, expect, it } from 'vitest'
import type { ControlMethodContext } from '../control/controlServer'
import { markManager, registerPane } from '../control/idRegistry'
import { forgetClosedPanes, rememberClosedPane } from './closedPanes'
import { claimName, forgetNames } from './paneNames'
import { type PaneRefDeps, refFailure, resolvePaneRef } from './paneRef'

const caller = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'ref-caller' })
const sibling = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'ref-sibling' })
const near = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'ref-near' })
const far = registerPane({ windowId: 'w1', workspaceId: 'ws9', paneId: 'ref-far' })
const manager = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'ref-manager' })
markManager('ref-manager')

const named = new Map<string, string[]>()
const sandboxed = new Set<string>()
const confined = new Set<string>()
const deps: PaneRefDeps = {
  processPane: async (ref) => named.get(ref) ?? [],
  visible: async () => (workspaceId) => workspaceId === 'ws2',
  isSandboxed: (workspaceId) => sandboxed.has(workspaceId),
  isConfined: (paneId) => confined.has(paneId),
}
const ctx = { identity: caller } as unknown as ControlMethodContext

beforeEach(() => {
  named.clear()
  sandboxed.clear()
  confined.clear()
  forgetClosedPanes()
  forgetNames()
})

describe('resolvePaneRef', () => {
  it('takes an exact id first, even of a pane out of reach', async () => {
    expect(await resolvePaneRef(deps, far.externalId, ctx, true)).toEqual({ found: far })
  })

  it('takes a process name, the newest first, and refuses a shared name only when asked to', async () => {
    named.set('w-1', ['ref-sibling', 'ref-near'])
    expect(await resolvePaneRef(deps, 'w-1', ctx, false)).toEqual({ found: sibling })
    expect(await resolvePaneRef(deps, 'w-1', ctx, true)).toEqual({ ambiguous: [sibling, near] })
    named.set('w-2', ['ref-near'])
    expect(await resolvePaneRef(deps, 'w-2', ctx, true)).toEqual({ found: near })
  })

  it('takes a registered name after an exact id and before an id prefix', async () => {
    claimName('ref-near', 'deadbeefz', undefined)
    expect(await resolvePaneRef(deps, 'deadbeefz', ctx, true)).toEqual({ found: near })
    claimName('ref-sibling', 'boss', undefined)
    expect(await resolvePaneRef(deps, 'boss', ctx, true)).toEqual({ found: sibling })
    expect(await resolvePaneRef(deps, 'Boss', ctx, true)).toEqual({ unknown: true })
  })

  it('answers ambiguous-pane, never the bus name, when a tab --name in reach is the same word', async () => {
    claimName('ref-sibling', 'boss', undefined)
    named.set('boss', ['ref-near'])
    expect(await resolvePaneRef(deps, 'boss', ctx, false)).toEqual({ ambiguous: [sibling, near] })
    named.set('boss', ['ref-sibling'])
    expect(await resolvePaneRef(deps, 'boss', ctx, false)).toEqual({ found: sibling })
  })

  it('resolves a registered name only to a pane the caller reaches', async () => {
    claimName('ref-near', 'near-name', undefined)
    claimName('ref-far', 'far-name', undefined)
    expect(await resolvePaneRef(deps, 'near-name', ctx, false)).toEqual({ found: near })
    expect(await resolvePaneRef(deps, 'far-name', ctx, false)).toEqual({ unknown: true })
  })

  it('never resolves a registered name of a manager pane', async () => {
    claimName('ref-manager', 'mgr-name', undefined)
    expect(await resolvePaneRef(deps, 'mgr-name', ctx, false)).toEqual({ unknown: true })
  })

  it('lets a sandboxed caller reach a named pane only when it is a confined pane of its workspace', async () => {
    sandboxed.add('ws1')
    claimName('ref-sibling', 'sib', undefined)
    claimName('ref-near', 'nr', undefined)
    expect(await resolvePaneRef(deps, 'sib', ctx, false)).toEqual({ unknown: true })
    confined.add('ref-sibling')
    confined.add('ref-near')
    expect(await resolvePaneRef(deps, 'sib', ctx, false)).toEqual({ found: sibling })
    expect(await resolvePaneRef(deps, 'nr', ctx, false)).toEqual({ unknown: true })
  })

  it('takes 8 or more characters of an id among the panes of the caller and its reach', async () => {
    const prefix = (id: string, length: number) => id.slice(0, length)
    expect(await resolvePaneRef(deps, prefix(sibling.externalId, 8), ctx, true)).toEqual({
      found: sibling,
    })
    expect(
      await resolvePaneRef(deps, prefix(near.externalId, 12).toUpperCase(), ctx, true),
    ).toEqual({ found: near })
    expect(await resolvePaneRef(deps, prefix(sibling.externalId, 7), ctx, true)).toEqual({
      unknown: true,
    })
  })

  it('never reveals a pane outside the caller’s reach or a manager by a prefix', async () => {
    expect(await resolvePaneRef(deps, far.externalId.slice(0, 8), ctx, false)).toEqual({
      unknown: true,
    })
    expect(await resolvePaneRef(deps, manager.externalId.slice(0, 8), ctx, false)).toEqual({
      unknown: true,
    })
  })

  it('never matches a tab title or anything that is not an id prefix', async () => {
    expect(await resolvePaneRef(deps, 'ref-sibling', ctx, false)).toEqual({ unknown: true })
    expect(await resolvePaneRef(deps, 'zzzzzzzzzz', ctx, false)).toEqual({ unknown: true })
  })

  it('lists every visible pane that shares a prefix instead of choosing', async () => {
    const twin = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'ref-twin' })
    twin.externalId = `${sibling.externalId.slice(0, 8)}-ffff-4fff-8fff-ffffffffffff`
    const ambiguous = await resolvePaneRef(deps, sibling.externalId.slice(0, 8), ctx, false)
    expect(ambiguous).toMatchObject({ ambiguous: expect.arrayContaining([sibling, twin]) })
    expect(refFailure('x', ambiguous as never)).toMatch(
      /^ambiguous-pane: x matches .*\(ws1\).*; pass one of those ids$/,
    )
  })

  it('shows a sandboxed caller only the confined panes of its own workspace, and nothing closed', async () => {
    sandboxed.add('ws1')
    confined.add('ref-sibling')
    named.set('w-1', ['ref-sibling', 'ref-near'])
    expect(await resolvePaneRef(deps, 'w-1', ctx, true)).toEqual({ found: sibling })
    expect(await resolvePaneRef(deps, sibling.externalId.slice(0, 8), ctx, true)).toEqual({
      found: sibling,
    })
    expect(await resolvePaneRef(deps, near.externalId.slice(0, 8), ctx, false)).toEqual({
      unknown: true,
    })
    expect(await resolvePaneRef(deps, manager.externalId.slice(0, 8), ctx, false)).toEqual({
      unknown: true,
    })
    rememberClosedPane({
      externalId: 'e6546de6-0000-4000-8000-000000000000',
      workspaceId: 'ws1',
      closedAt: 1,
    })
    expect(await resolvePaneRef(deps, 'e6546de6', ctx, false)).toEqual({ unknown: true })
  })

  it('says when and as what a pane closed, only to a caller who could see it', async () => {
    rememberClosedPane({
      externalId: 'e6546de6-0000-4000-8000-000000000000',
      workspaceId: 'ws1',
      name: 'w-1241',
      closedAt: Date.now() - 7_200_000,
    })
    rememberClosedPane({
      externalId: 'aaaaaaaa-0000-4000-8000-000000000000',
      workspaceId: 'ws9',
      closedAt: Date.now(),
    })
    const closed = await resolvePaneRef(deps, 'e6546de6', ctx, false)
    expect(refFailure('e6546de6', closed as never)).toBe(
      'unknown-pane: e6546de6 closed 2h ago (w-1241). List the panes still open with ostia pane list',
    )
    expect(await resolvePaneRef(deps, 'aaaaaaaa', ctx, false)).toEqual({ unknown: true })
    expect(refFailure('nope', { unknown: true })).toBe(
      'unknown-pane: nope. List the panes you can reach with ostia pane list',
    )
  })
})
