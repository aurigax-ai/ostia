import {
  VIEW_MAX_LIST_ITEMS,
  VIEW_MAX_RENDERED_NODES,
  type ViewDoc,
  parseViewText,
} from '@shared/views'
import { describe, expect, it } from 'vitest'
import { type RenderNode, expandView } from './viewExpand'

const fmt = { now: 0, locale: 'en' }

function view(root: unknown): ViewDoc {
  const res = parseViewText(JSON.stringify({ version: 1, title: 'T', placement: 'panel', root }))
  if (!res.ok) throw new Error(JSON.stringify(res.problems))
  return res.doc
}

function expanded(doc: ViewDoc, data: Record<string, unknown>): RenderNode {
  const res = expandView(doc, data, fmt)
  if (!res.ok || !res.root) throw new Error('expected a render')
  return res.root
}

const listOf = (item: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'list',
  for: 'workspaces',
  as: 'ws',
  item,
  ...extra,
})

describe('expandView', () => {
  it('repeats a list item for each entry with its own scope', () => {
    const doc = view(listOf({ type: 'text', text: '{{ws.name}} ({{ws.unread}})' }))
    const root = expanded(doc, {
      workspaces: [{ id: 'w1', name: 'pine', unread: 2 }, { name: 'x' }],
    })
    expect(root.kind).toBe('list')
    if (root.kind !== 'list') return
    expect(root.items.map((i) => (i.kind === 'text' ? i.text : ''))).toEqual(['pine (2)', 'x ()'])
    expect(root.items.map((i) => i.key)).toEqual(['root#w1', 'root@1'])
  })

  it('shows the empty text when the list has nothing', () => {
    const root = expanded(view(listOf({ type: 'divider' }, { empty: 'None' })), { workspaces: [] })
    expect(root).toMatchObject({ kind: 'list', items: [], empty: 'None' })
  })

  it('skips nodes whose if binding is falsy', () => {
    const doc = view({
      type: 'stack',
      children: [
        { type: 'badge', text: 'unread', if: '{{workspace.unread}}' },
        { type: 'badge', text: 'clear', if: '{{workspace.unread | not}}' },
      ],
    })
    const root = expanded(doc, { workspace: { unread: 0 } })
    expect(root.kind === 'stack' && root.children.map((c) => c.kind === 'badge' && c.text)).toEqual(
      ['clear'],
    )
  })

  it('resolves command args per item and keeps the template for trust', () => {
    const doc = view(
      listOf({
        type: 'button',
        label: 'Go',
        action: { command: 'workspace.goto', args: { index: '{{ws.index}}' } },
      }),
    )
    const root = expanded(doc, { workspaces: [{ index: 3 }] })
    const button = root.kind === 'list' ? root.items[0] : null
    expect(button).toMatchObject({
      kind: 'button',
      action: {
        kind: 'command',
        command: 'workspace.goto',
        template: { index: '{{ws.index}}' },
        args: { index: 3 },
      },
    })
  })

  it('drops URLs that do not resolve to http or https', () => {
    const doc = view({
      type: 'stack',
      children: [
        { type: 'link', label: 'a', url: '{{workspace.url}}' },
        { type: 'button', label: 'b', action: { openUrl: '{{workspace.url}}' } },
      ],
    })
    const bad = expanded(doc, { workspace: { url: 'javascript:alert(1)' } })
    expect(bad.kind === 'stack' && bad.children).toEqual([
      expect.objectContaining({ kind: 'link', url: null }),
      expect.objectContaining({ kind: 'button', action: { kind: 'url', url: null } }),
    ])
    const good = expanded(doc, { workspace: { url: 'http://localhost:5173/' } })
    expect(good.kind === 'stack' && good.children[0]).toMatchObject({
      url: 'http://localhost:5173/',
    })
  })

  it('clamps progress to 0..1 of max', () => {
    const doc = view({ type: 'progress', value: '{{approvals.pending}}', max: 4 })
    expect(expanded(doc, { approvals: { pending: 1 } })).toMatchObject({ ratio: 0.25 })
    expect(expanded(doc, { approvals: { pending: 9 } })).toMatchObject({ ratio: 1 })
    expect(expanded(doc, { approvals: {} })).toMatchObject({ ratio: 0 })
  })

  it('fails the budget when a list without a limit is too long', () => {
    const doc = view(listOf({ type: 'divider' }))
    const workspaces = Array.from({ length: VIEW_MAX_LIST_ITEMS + 1 }, (_, i) => ({ i }))
    expect(expandView(doc, { workspaces }, fmt)).toEqual({
      ok: false,
      problem: {
        kind: 'list',
        path: 'root',
        count: VIEW_MAX_LIST_ITEMS + 1,
        max: VIEW_MAX_LIST_ITEMS,
      },
    })
    const limited = view(listOf({ type: 'divider' }, { limit: 5 }))
    const root = expanded(limited, { workspaces })
    expect(root.kind === 'list' && root.items).toHaveLength(5)
  })

  it('fails the budget when nested lists draw too many nodes', () => {
    const doc = view(
      listOf({
        type: 'list',
        for: 'ws.items',
        as: 'it',
        item: { type: 'row', children: [{ type: 'text', text: '{{it}}' }] },
      }),
    )
    const items = Array.from({ length: VIEW_MAX_LIST_ITEMS }, (_, i) => i)
    const workspaces = Array.from({ length: VIEW_MAX_LIST_ITEMS }, () => ({ items }))
    expect(expandView(doc, { workspaces }, fmt)).toEqual({
      ok: false,
      problem: { kind: 'nodes', max: VIEW_MAX_RENDERED_NODES },
    })
  })
})
