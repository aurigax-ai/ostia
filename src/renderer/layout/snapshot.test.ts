import type { AppSnapshot } from '@shared/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildSnapshot, restoreSnapshot } from './snapshot'
import { createPane, resetIds, splitOf } from './tree'
import type { LayoutNode } from './types'

beforeEach(() => resetIds())

const WORKSPACE = { id: 's1', name: 'proj', kind: 'terminal' as const, workDir: '/home/u/proj' }

function build(root: LayoutNode, activePaneId = root.id): AppSnapshot {
  return buildSnapshot({
    workspaces: [WORKSPACE],
    activeWorkspaceId: 's1',
    layouts: { s1: { root, activePaneId } },
    savedAt: '2026-08-06T00:00:00.000Z',
  })
}

describe('buildSnapshot', () => {
  it('captures each workspace with its tree and focused pane', () => {
    const root = createPane('terminal', 'zsh', '/home/u/proj')
    const snapshot = build(root)
    expect(snapshot).toMatchObject({
      v: 1,
      savedAt: '2026-08-06T00:00:00.000Z',
      activeWorkspaceId: 's1',
      workspaces: [{ ...WORKSPACE, activePaneId: root.id }],
    })
    expect(snapshot?.workspaces[0].root).toMatchObject({
      id: root.id,
      kind: 'terminal',
      cwd: '/home/u/proj',
    })
  })

  it('carries a split’s direction, sizes and children', () => {
    const a = createPane()
    const b = createPane()
    const root = splitOf('vertical', a, b)
    const captured = build(root, a.id)?.workspaces[0].root
    expect(captured).toMatchObject({ type: 'split', direction: 'vertical', sizes: [1, 1] })
    expect(captured?.type === 'split' && captured.children.map((c) => c.id)).toEqual([a.id, b.id])
  })

  it('carries an editor’s file path and a browser’s url', () => {
    const editor: LayoutNode = {
      type: 'pane',
      id: 'pane-1',
      title: 'a.ts',
      kind: 'editor',
      filePath: '/p/a.ts',
    }
    const browser: LayoutNode = {
      type: 'pane',
      id: 'pane-2',
      title: 'x',
      kind: 'browser',
      url: 'http://x/',
    }
    const captured = build(splitOf('horizontal', editor, browser), 'pane-1')?.workspaces[0].root
    expect(captured?.type === 'split' && captured.children).toEqual([editor, browser])
  })

  it('deep-copies the tree so the snapshot never aliases live store state', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    const captured = build(root, root.children[0].id)?.workspaces[0].root
    expect(captured).not.toBe(root)
    expect(captured?.type === 'split' && captured.children[0]).not.toBe(root.children[0])
  })

  it('saves a workspace that has no layout as an empty workspace', () => {
    const root = createPane()
    const snapshot = buildSnapshot({
      workspaces: [WORKSPACE, { id: 's2', name: 'x', kind: 'terminal', workDir: '/tmp' }],
      activeWorkspaceId: 's2',
      layouts: { s1: { root, activePaneId: root.id } },
      savedAt: '',
    })
    expect(snapshot.workspaces[1]).toEqual({
      id: 's2',
      name: 'x',
      kind: 'terminal',
      workDir: '/tmp',
    })
    expect(snapshot.activeWorkspaceId).toBe('s2')
    expect(restoreSnapshot(snapshot).layouts).not.toHaveProperty('s2')
  })

  it('saves and restores a name the user gave a workspace', () => {
    const snapshot = buildSnapshot({
      workspaces: [{ ...WORKSPACE, customName: 'payments' }],
      activeWorkspaceId: 's1',
      layouts: {},
      savedAt: '',
    })
    expect(restoreSnapshot(snapshot).workspaces[0].customName).toBe('payments')
  })

  it('drops diff panes, which hold live in-memory content, and refocuses a survivor', () => {
    const term = createPane('terminal', 'zsh', '/home/u/proj')
    const diff: LayoutNode = { type: 'pane', id: 'pane-9', title: 'a.ts', kind: 'diff' }
    const snapshot = build(splitOf('horizontal', term, diff), 'pane-9')
    expect(snapshot?.workspaces[0].root).toMatchObject({ id: term.id, kind: 'terminal' })
    expect(snapshot?.workspaces[0].activePaneId).toBe(term.id)
  })

  it('replaces a lone diff pane with a terminal at the workspace workDir', () => {
    const diff: LayoutNode = { type: 'pane', id: 'pane-4', title: 'a.ts', kind: 'diff' }
    const snapshot = build(diff)
    expect(snapshot?.workspaces[0].root).toEqual({
      type: 'pane',
      id: 'pane-4',
      title: 'zsh',
      kind: 'terminal',
      cwd: '/home/u/proj',
    })
  })

  it('builds an empty workspace with no active workspace when there are no workspaces', () => {
    expect(
      buildSnapshot({ workspaces: [], activeWorkspaceId: null, layouts: {}, savedAt: 't' }),
    ).toEqual({ v: 1, savedAt: 't', activeWorkspaceId: null, workspaces: [] })
  })
})

describe('restoreSnapshot', () => {
  it('round-trips a workspace built from live state', () => {
    const a = createPane('terminal', 'zsh', '/home/u/proj')
    const b = createPane('editor', 'a.ts')
    const root = splitOf('horizontal', a, b)
    const snapshot = build(root, b.id)
    if (!snapshot) throw new Error('expected a snapshot')

    const restored = restoreSnapshot(snapshot)
    expect(restored.workspaces).toEqual([WORKSPACE])
    expect(restored.activeWorkspaceId).toBe('s1')
    expect(restored.layouts.s1.root).toEqual(root)
    expect(restored.layouts.s1.activePaneId).toBe(b.id)
  })

  it('comes back un-zoomed — a zoom is a transient view, not workspace shape', () => {
    const root = createPane()
    const snapshot = build(root)
    if (!snapshot) throw new Error('expected a snapshot')
    expect(restoreSnapshot(snapshot).layouts.s1.zoomedPaneId).toBeNull()
  })

  it('reserves the restored ids so a newly created pane cannot collide', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    const snapshot = build(root, root.children[0].id)
    if (!snapshot) throw new Error('expected a snapshot')

    resetIds()
    restoreSnapshot(snapshot)
    expect(createPane().id).toBe('pane-4')
  })

  it('deep-copies out of the snapshot so the store owns its own tree', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    const snapshot = build(root, root.children[0].id)
    if (!snapshot) throw new Error('expected a snapshot')
    expect(restoreSnapshot(snapshot).layouts.s1.root).not.toBe(snapshot.workspaces[0].root)
  })
})
