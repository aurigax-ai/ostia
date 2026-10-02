import type { AppSnapshot } from '@shared/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildSnapshot, restoreSnapshot } from './snapshot'
import { createPane, resetIds, setDefaultPaneTitle, setPaneView, splitOf } from './tree'
import type { LayoutNode } from './types'

beforeEach(() => resetIds())

const WORKSPACE = { id: 's1', name: 'proj', kind: 'terminal' as const, workDir: '/home/u/proj' }

function build(root: LayoutNode, activePaneId = root.id): AppSnapshot {
  return buildSnapshot({
    workspaces: [WORKSPACE],
    activeWorkspaceId: 's1',
    layouts: { s1: { root, activePaneId } },
    savedAt: '2026-08-06T00:00:00.000Z',
    groups: [],
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
      groups: [],
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

  it('saves and restores a workspace description and pin', () => {
    const snapshot = buildSnapshot({
      workspaces: [{ ...WORKSPACE, description: 'PR #7', pinned: true }],
      activeWorkspaceId: 's1',
      layouts: {},
      savedAt: '',
      groups: [],
    })
    expect(restoreSnapshot(snapshot).workspaces[0]).toMatchObject({
      description: 'PR #7',
      pinned: true,
    })
  })

  it('round-trips groups and memberships, and leaves out a group with no members', () => {
    const snapshot = buildSnapshot({
      workspaces: [
        { ...WORKSPACE, groupId: 'g1' },
        { id: 's2', name: 'x', kind: 'terminal', workDir: '/tmp' },
      ],
      groups: [
        { id: 'g1', name: 'api', color: 'green', collapsed: true },
        { id: 'g2', name: 'empty' },
      ],
      activeWorkspaceId: 's1',
      layouts: {},
      savedAt: '',
    })
    expect(snapshot.groups).toEqual([{ id: 'g1', name: 'api', color: 'green', collapsed: true }])
    const restored = restoreSnapshot(snapshot)
    expect(restored.groups).toEqual(snapshot.groups)
    expect(restored.workspaces.map((w) => w.groupId)).toEqual(['g1', undefined])
  })

  it('saves and restores a name the user gave a workspace', () => {
    const snapshot = buildSnapshot({
      workspaces: [{ ...WORKSPACE, customName: 'payments' }],
      activeWorkspaceId: 's1',
      layouts: {},
      savedAt: '',
      groups: [],
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

  it('SSH-C64 drops a remote file pane, which lives only while its folder is open', () => {
    const term = createPane('terminal', 'zsh', '/home/u/proj')
    const remote: LayoutNode = {
      type: 'pane',
      id: 'pane-9',
      title: 'app.conf',
      kind: 'editor',
      filePath: 'remote://abcdef012345/srv/app/app.conf',
    }
    const local: LayoutNode = {
      type: 'pane',
      id: 'pane-8',
      title: 'a.ts',
      kind: 'editor',
      filePath: '/home/u/proj/a.ts',
    }
    const snapshot = build(
      splitOf('horizontal', term, splitOf('vertical', remote, local)),
      'pane-9',
    )
    expect(JSON.stringify(snapshot)).not.toContain('remote://')
    expect(JSON.stringify(snapshot)).toContain('/home/u/proj/a.ts')
    expect(snapshot?.workspaces[0].activePaneId).toBe(term.id)
  })

  it('replaces a lone diff pane with a terminal at the workspace workDir', () => {
    const diff: LayoutNode = { type: 'pane', id: 'pane-4', title: 'a.ts', kind: 'diff' }
    const snapshot = build(diff)
    expect(snapshot?.workspaces[0].root).toEqual({
      type: 'pane',
      id: 'pane-4',
      title: 'Terminal',
      kind: 'terminal',
      cwd: '/home/u/proj',
      defaultTitle: true,
    })
  })

  it('builds an empty workspace with no active workspace when there are no workspaces', () => {
    expect(
      buildSnapshot({
        workspaces: [],
        groups: [],
        activeWorkspaceId: null,
        layouts: {},
        savedAt: 't',
      }),
    ).toEqual({ v: 1, savedAt: 't', activeWorkspaceId: null, workspaces: [], groups: [] })
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

  it('keeps the default-title mark of an untouched terminal and never gives one to a named tab', () => {
    const fresh = createPane()
    const untouched = setDefaultPaneTitle(fresh, fresh.id, 'bash')
    const named = createPane('terminal', 'pnpm dev')
    const snapshot = build(splitOf('horizontal', untouched, named))
    const restored = restoreSnapshot(snapshot).layouts.s1.root
    expect(restored.type === 'split' && restored.children).toMatchObject([
      { title: 'bash', defaultTitle: true },
      { title: 'pnpm dev' },
    ])
    expect(restored.type === 'split' && 'defaultTitle' in restored.children[1]).toBe(false)
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

  it('round-trips a view pane next to a pending agent resume', () => {
    const agent = {
      ...createPane('terminal', 'claude'),
      resume: { agent: 'claude' as const, id: 'abc-1' },
      resumePending: true as const,
    }
    const view = setPaneView(createPane(), 'pane-2', 'board', 'Board')
    const root = splitOf('horizontal', agent, view)
    const snapshot = build(root, agent.id)
    const saved = snapshot.workspaces[0].root as { children: object[] }
    expect(saved.children[1]).toEqual({
      type: 'pane',
      id: 'pane-2',
      kind: 'view',
      title: 'Board',
      viewName: 'board',
    })
    expect(saved.children[0]).toMatchObject({ agentRunning: true })
    expect(restoreSnapshot(snapshot).layouts.s1.root).toEqual(root)
  })

  it('deep-copies out of the snapshot so the store owns its own tree', () => {
    const root = splitOf('horizontal', createPane(), createPane())
    const snapshot = build(root, root.children[0].id)
    if (!snapshot) throw new Error('expected a snapshot')
    expect(restoreSnapshot(snapshot).layouts.s1.root).not.toBe(snapshot.workspaces[0].root)
  })
})

describe('agent running at save', () => {
  const resume = { agent: 'claude' as const, id: 'abc-1' }
  const workspace = {
    id: 'w1',
    name: 'w',
    kind: 'terminal' as const,
    workDir: '/w',
  }

  it('marks a pane whose agent is running and restores it as pending a resume', () => {
    const agent = { ...createPane('terminal'), resume }
    const idle = { ...createPane('terminal'), resume: { agent: 'claude' as const, id: 'old-2' } }
    const root = splitOf('horizontal', agent, idle)
    const snap = buildSnapshot({
      workspaces: [workspace],
      groups: [],
      activeWorkspaceId: 'w1',
      layouts: { w1: { root, activePaneId: agent.id } },
      savedAt: 'now',
      liveAgentPanes: new Set([agent.id]),
    })
    const restored = restoreSnapshot(snap).layouts.w1.root as LayoutNode & {
      children: { id: string; resumePending?: true }[]
    }
    expect(restored.children.find((p) => p.id === agent.id)?.resumePending).toBe(true)
    expect(restored.children.find((p) => p.id === idle.id)?.resumePending).toBeUndefined()
  })

  it('saves and restores a locked pane as locked', () => {
    const kept = { ...createPane('terminal'), locked: true as const }
    const snap = buildSnapshot({
      workspaces: [workspace],
      groups: [],
      activeWorkspaceId: 'w1',
      layouts: { w1: { root: kept, activePaneId: kept.id } },
      savedAt: 'now',
      liveAgentPanes: new Set(),
    })
    expect(snap.workspaces[0].root).toMatchObject({ locked: true })
    expect(restoreSnapshot(snap).layouts.w1.root).toMatchObject({ id: kept.id, locked: true })
  })

  it('saves a hibernated agent pane as hibernated, not as an agent to resume', () => {
    const asleep = { ...createPane('terminal'), resume, hibernated: true as const }
    const snap = buildSnapshot({
      workspaces: [workspace],
      groups: [],
      activeWorkspaceId: 'w1',
      layouts: { w1: { root: asleep, activePaneId: asleep.id } },
      savedAt: 'now',
      liveAgentPanes: new Set([asleep.id]),
    })
    expect(snap.workspaces[0].root).toMatchObject({ hibernated: true })
    expect(snap.workspaces[0].root).not.toHaveProperty('agentRunning')
    const restored = restoreSnapshot(snap).layouts.w1.root
    expect(restored).toMatchObject({ id: asleep.id, hibernated: true })
    expect(restored).not.toHaveProperty('resumePending')
  })

  it('drops the hibernated mark of a pane that has nothing to resume', () => {
    const plain = { ...createPane('terminal'), hibernated: true as const }
    const snap = buildSnapshot({
      workspaces: [workspace],
      groups: [],
      activeWorkspaceId: 'w1',
      layouts: { w1: { root: plain, activePaneId: plain.id } },
      savedAt: 'now',
    })
    expect(snap.workspaces[0].root).not.toHaveProperty('hibernated')
  })

  it('keeps a pending resume through another save until it happens', () => {
    const pending = { ...createPane('terminal'), resume, resumePending: true as const }
    const snap = buildSnapshot({
      workspaces: [workspace],
      groups: [],
      activeWorkspaceId: 'w1',
      layouts: { w1: { root: pending, activePaneId: pending.id } },
      savedAt: 'now',
    })
    expect(snap.workspaces[0].root).toMatchObject({ agentRunning: true })
    expect(snap.workspaces[0].root).not.toHaveProperty('resumePending')
  })
})
