import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BrowserWindow, ipcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, SnapshotNode } from '../../shared/workspaces/workspaceApi'
import { AgentRunningPanes } from '../agents/agentRunning'
import { MAIN_SLOT } from '../windows/windowBook'
import { WindowBroker } from '../windows/windowBroker'
import {
  clearPersisted,
  loadRestoredScrollback,
  pendingRestoredScrollback,
  SCROLLBACK_CAP_BYTES,
  saveScrollback,
  scrollbackPath,
  stashedScreen,
  stashScrollback,
  takeRestoredScrollback,
  trimScrollback,
} from './savedScrollback'
import {
  loadSnapshot,
  parseHandoff,
  parseSnapshot,
  saveSnapshot,
  snapshotPath,
} from './workspaceSnapshot'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, screen: {} }))

function snap(overrides?: Partial<AppSnapshot>): AppSnapshot {
  return {
    v: 1,
    savedAt: '2026-08-06T00:00:00.000Z',
    activeWorkspaceId: 's1',
    workspaces: [
      {
        id: 's1',
        name: 'terminal',
        kind: 'terminal',
        workDir: '/home/u/proj',
        activePaneId: 'pane-1',
        root: { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal', cwd: '/home/u/proj' },
      },
    ],
    groups: [],
    ...overrides,
  }
}

function split(aId: string, bId: string): SnapshotNode {
  return {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    children: [
      { type: 'pane', id: aId, title: 'zsh', kind: 'terminal' },
      { type: 'pane', id: bId, title: 'zsh', kind: 'terminal' },
    ],
    sizes: [1, 1],
  }
}

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ostia-snapshot-test-'))
  vi.stubEnv('XDG_DATA_HOME', dataDir)
  loadRestoredScrollback()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('right side panel', () => {
  it('keeps a well-formed extension id and drops anything else', () => {
    expect(parseSnapshot(snap({ rightPanel: 'graphs' }))?.rightPanel).toBe('graphs')
    for (const bad of ['', 'Graphs', 'a b', 'x'.repeat(41), 7, null]) {
      expect(parseSnapshot({ ...snap(), rightPanel: bad })).not.toHaveProperty('rightPanel')
    }
  })

  it('keeps it per detached window', () => {
    const base = snap().workspaces[0]
    const window = (rightPanel: unknown) => ({
      id: 'd1',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      activeWorkspaceId: 'w2',
      rightPanel,
      workspaces: [
        {
          ...base,
          id: 'w2',
          activePaneId: 'pane-2',
          root: { type: 'pane', id: 'pane-2', title: 'zsh', kind: 'terminal' },
        },
      ],
    })
    expect(parseSnapshot({ ...snap(), windows: [window('keeper')] })?.windows?.[0].rightPanel).toBe(
      'keeper',
    )
    expect(parseSnapshot({ ...snap(), windows: [window('No!')] })?.windows?.[0]).not.toHaveProperty(
      'rightPanel',
    )
  })
})

describe('left side panel', () => {
  it('keeps a known left panel and drops anything else', () => {
    expect(parseSnapshot(snap({ leftPanel: 'files' }))?.leftPanel).toBe('files')
    expect(parseSnapshot({ ...snap(), leftPanel: 'git' })).not.toHaveProperty('leftPanel')
    expect(parseSnapshot({ ...snap(), leftPanel: true })).not.toHaveProperty('leftPanel')
  })

  it('keeps it per detached window', () => {
    const window = (leftPanel: unknown) => ({
      id: 'd1',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      activeWorkspaceId: 'w2',
      leftPanel,
      workspaces: [
        {
          ...snap().workspaces[0],
          id: 'w2',
          root: { ...snap().workspaces[0].root, id: 'pane-2' },
          activePaneId: 'pane-2',
        },
      ],
    })
    expect(parseSnapshot({ ...snap(), windows: [window('files')] })?.windows?.[0].leftPanel).toBe(
      'files',
    )
    expect(parseSnapshot({ ...snap(), windows: [window('x')] })?.windows?.[0]).not.toHaveProperty(
      'leftPanel',
    )
  })
})

describe('parseSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    expect(parseSnapshot(snap())).toEqual(snap())
  })

  it('keeps a chat pane with its session id', () => {
    const [base] = snap().workspaces
    const chat = {
      type: 'pane',
      id: 'pane-2',
      title: 'Deploy notes',
      kind: 'chat',
      chatSessionId: 'c1',
    }
    const parsed = parseSnapshot({
      ...snap(),
      workspaces: [
        { ...base, root: { ...split('pane-1', 'pane-3'), children: [base.root, chat] } },
      ],
    })
    const root = parsed?.workspaces[0].root as { children: unknown[] }
    expect(root.children[1]).toEqual({
      type: 'pane',
      id: 'pane-2',
      title: 'Deploy notes',
      kind: 'chat',
      chatSessionId: 'c1',
    })
  })

  it('SSH-C64 never restores a remote file path', () => {
    const [base] = snap().workspaces
    const remote = {
      type: 'pane',
      id: 'pane-2',
      title: 'app.conf',
      kind: 'editor',
      filePath: 'remote://abcdef012345/srv/app/app.conf',
    }
    const parsed = parseSnapshot({
      ...snap(),
      workspaces: [
        { ...base, root: { ...split('pane-1', 'pane-3'), children: [base.root, remote] } },
      ],
    })
    const root = parsed?.workspaces[0].root as { children: unknown[] }
    expect(root.children[1]).toEqual({
      type: 'pane',
      id: 'pane-2',
      title: 'app.conf',
      kind: 'editor',
    })
  })

  it('rejects a snapshot written by a different schema version', () => {
    expect(parseSnapshot({ ...snap(), v: 2 })).toBeNull()
  })

  it('rejects a non-object', () => {
    expect(parseSnapshot(null)).toBeNull()
    expect(parseSnapshot('nope')).toBeNull()
  })

  it('keeps an empty workspace as a snapshot with no workspaces and no active workspace', () => {
    expect(parseSnapshot({ ...snap(), workspaces: [] })).toEqual({
      v: 1,
      savedAt: snap().savedAt,
      activeWorkspaceId: null,
      workspaces: [],
      groups: [],
    })
  })

  it('keeps valid groups with members and drops bad, empty or dangling ones', () => {
    const [base] = snap().workspaces
    const { root: _root, activePaneId: _active, ...empty } = base
    const parsed = parseSnapshot({
      ...snap(),
      workspaces: [
        { ...base, groupId: 'g1' },
        { ...empty, id: 's2', groupId: 'g-missing' },
        { ...empty, id: 's3', groupId: 'g1', pinned: true },
      ],
      groups: [
        { id: 'g1', name: '  api  ', color: 'mauve', collapsed: true },
        { id: 'g1', name: 'duplicate' },
        { id: 'g2', name: 'no members' },
        { id: 'g3', name: '   ' },
        'junk',
      ],
    })
    expect(parsed?.groups).toEqual([{ id: 'g1', name: 'api', collapsed: true }])
    expect(parsed?.workspaces.map((w) => w.groupId)).toEqual(['g1', undefined, undefined])
  })

  it('keeps a pane’s agent resume token and drops a malformed one', () => {
    const pane = snap().workspaces[0].root
    const withResume = (resume: unknown) =>
      parseSnapshot(
        snap({ workspaces: [{ ...snap().workspaces[0], root: { ...pane, resume } as never }] }),
      )
    expect(withResume({ agent: 'claude', id: 'abc-1' })?.workspaces[0].root).toMatchObject({
      resume: { agent: 'claude', id: 'abc-1' },
    })
    expect(
      withResume({ agent: 'claude', id: 'abc-1', cwd: '/w/tree' })?.workspaces[0].root,
    ).toMatchObject({ resume: { agent: 'claude', id: 'abc-1', cwd: '/w/tree' } })
    expect(
      withResume({ agent: 'claude', id: 'x; rm -rf ~' })?.workspaces[0].root,
    ).not.toHaveProperty('resume')
    const saved = JSON.parse(
      JSON.stringify({
        agent: 'codex',
        id: 'abc-1',
        args: ['-m', 'gpt-5', '-c', 'x.api_key="k"'],
        env: { GL_ISSUE: '685', OPENAI_API_KEY: 'k' },
      }),
    )
    expect(withResume(saved)?.workspaces[0].root).toMatchObject({
      resume: { agent: 'codex', id: 'abc-1', args: ['-m', 'gpt-5'] },
    })
    expect(withResume(saved)?.workspaces[0].root).not.toHaveProperty('resume.env')
  })

  it('keeps a view pane by name and drops one without a valid view name', () => {
    const withView = (viewName: unknown) =>
      parseSnapshot(
        snap({
          workspaces: [
            {
              ...snap().workspaces[0],
              root: { type: 'pane', id: 'pane-1', title: 'Board', kind: 'view', viewName } as never,
            },
          ],
        }),
      )?.workspaces[0]?.root
    expect(withView('board')).toEqual({
      type: 'pane',
      id: 'pane-1',
      title: 'Board',
      kind: 'view',
      viewName: 'board',
    })
    expect(withView('../../etc/passwd')).toBeUndefined()
    expect(withView(undefined)).toBeUndefined()
  })

  it('keeps the agent-running mark only on a pane with a valid resume token', () => {
    const pane = snap().workspaces[0].root
    const rootOf = (extra: object) =>
      parseSnapshot(
        snap({ workspaces: [{ ...snap().workspaces[0], root: { ...pane, ...extra } as never }] }),
      )?.workspaces[0].root
    expect(rootOf({ resume: { agent: 'claude', id: 'abc-1' }, agentRunning: true })).toMatchObject({
      agentRunning: true,
    })
    expect(rootOf({ agentRunning: true })).not.toHaveProperty('agentRunning')
    expect(
      rootOf({ resume: { agent: 'claude', id: 'abc-1' }, agentRunning: true, hibernated: true }),
    ).not.toHaveProperty('agentRunning')
    expect(
      rootOf({ resume: { agent: 'claude', id: 'abc-1' }, agentRunning: 'yes' }),
    ).not.toHaveProperty('agentRunning')
  })

  it('keeps a kept-awake mark only on a pane that has a resume token', () => {
    const pane = snap().workspaces[0].root
    const rootOf = (extra: object) =>
      parseSnapshot(
        snap({ workspaces: [{ ...snap().workspaces[0], root: { ...pane, ...extra } as never }] }),
      )?.workspaces[0].root
    expect(rootOf({ resume: { agent: 'claude', id: 'abc-1' }, keepAwake: true })).toMatchObject({
      keepAwake: true,
    })
    expect(rootOf({ keepAwake: true })).not.toHaveProperty('keepAwake')
    expect(
      rootOf({ resume: { agent: 'claude', id: 'abc-1' }, keepAwake: 'yes' }),
    ).not.toHaveProperty('keepAwake')
  })

  it('RSM-C17 keeps a failed resume token as data, never running and only without a live token', () => {
    const pane = snap().workspaces[0].root
    const rootOf = (extra: object) =>
      parseSnapshot(
        snap({ workspaces: [{ ...snap().workspaces[0], root: { ...pane, ...extra } as never }] }),
      )?.workspaces[0].root
    const failed = { resume: { agent: 'claude', id: 'dead-1' }, exitCode: 1 }
    expect(rootOf({ resumeFailed: failed, agentRunning: true })).toMatchObject({
      resumeFailed: failed,
    })
    expect(rootOf({ resumeFailed: failed, agentRunning: true })).not.toHaveProperty('agentRunning')
    expect(
      rootOf({ resume: { agent: 'claude', id: 'abc-1' }, resumeFailed: failed }),
    ).not.toHaveProperty('resumeFailed')
    expect(
      rootOf({ resumeFailed: { resume: { agent: 'claude', id: '$(id)' }, exitCode: 1 } }),
    ).not.toHaveProperty('resumeFailed')
    expect(
      rootOf({ resumeFailed: { resume: failed.resume, exitCode: 'rm -rf' } }),
    ).not.toHaveProperty('resumeFailed')
  })

  it('keeps a renamed pane pinned only when the mark is true', () => {
    const pane = snap().workspaces[0].root
    const rootOf = (extra: object) =>
      parseSnapshot(
        snap({ workspaces: [{ ...snap().workspaces[0], root: { ...pane, ...extra } as never }] }),
      )?.workspaces[0].root
    expect(rootOf({ title: 'worker', titlePinned: true })).toMatchObject({
      title: 'worker',
      titlePinned: true,
    })
    expect(rootOf({ titlePinned: 'yes' })).not.toHaveProperty('titlePinned')
  })

  it('keeps the default-title mark only on a terminal pane and only when it is true', () => {
    const pane = snap().workspaces[0].root
    const rootOf = (extra: object) =>
      parseSnapshot(
        snap({ workspaces: [{ ...snap().workspaces[0], root: { ...pane, ...extra } as never }] }),
      )?.workspaces[0].root
    expect(rootOf({ defaultTitle: true })).toMatchObject({ title: 'zsh', defaultTitle: true })
    expect(rootOf({})).not.toHaveProperty('defaultTitle')
    expect(rootOf({ defaultTitle: 'yes' })).not.toHaveProperty('defaultTitle')
    expect(
      rootOf({ kind: 'editor', filePath: '/home/u/proj/a.ts', defaultTitle: true }),
    ).not.toHaveProperty('defaultTitle')
  })

  it('keeps a tab stack and repairs an unknown shown tab', () => {
    const tabs = {
      type: 'tabs',
      id: 'tabs-3',
      activeId: 'pane-9',
      children: [
        { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal' },
        { type: 'pane', id: 'pane-2', title: 'zsh', kind: 'terminal' },
      ],
    }
    const parsed = parseSnapshot(
      snap({ workspaces: [{ ...snap().workspaces[0], root: tabs as never }] }),
    )
    expect(parsed?.workspaces[0].root).toMatchObject({ type: 'tabs', activeId: 'pane-1' })
  })

  it('unwraps a one-tab stack, also when its only tab is a split tab', () => {
    const one = {
      type: 'tabs',
      id: 'tabs-3',
      activeId: 'pane-1',
      children: [{ type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal' }],
    }
    expect(
      parseSnapshot(snap({ workspaces: [{ ...snap().workspaces[0], root: one as never }] }))
        ?.workspaces[0].root,
    ).toMatchObject({ type: 'pane', id: 'pane-1' })
    const lone = { ...one, children: [split('pane-1', 'pane-2')] }
    expect(
      parseSnapshot(snap({ workspaces: [{ ...snap().workspaces[0], root: lone as never }] }))
        ?.workspaces[0].root,
    ).toMatchObject({ type: 'split', id: 'split-1' })
  })

  it('keeps a split tab with its name and a shown pane inside it', () => {
    const tabs = {
      type: 'tabs',
      id: 'tabs-3',
      activeId: 'pane-3',
      children: [
        { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal' },
        { ...split('pane-2', 'pane-3'), name: '  api  ' },
      ],
    }
    const root = parseSnapshot(
      snap({ workspaces: [{ ...snap().workspaces[0], root: tabs as never }] }),
    )?.workspaces[0].root
    expect(root).toMatchObject({ type: 'tabs', activeId: 'pane-3' })
    expect(root?.type === 'tabs' && root.children[1]).toMatchObject({
      type: 'split',
      name: 'api',
      sizes: [1, 1],
    })
  })

  it('keeps a collapsed mark only on a pane inside a tab and only when it is true', () => {
    const pane = (id: string, collapsed: unknown) => ({
      type: 'pane',
      id,
      title: 'zsh',
      kind: 'terminal',
      collapsed,
    })
    const tabs = {
      type: 'tabs',
      id: 'tabs-3',
      activeId: 'pane-1',
      children: [
        pane('pane-1', true),
        { ...split('pane-2', 'pane-3'), children: [pane('pane-2', true), pane('pane-3', 'yes')] },
      ],
    }
    const root = parseSnapshot(
      snap({ workspaces: [{ ...snap().workspaces[0], root: tabs as never }] }),
    )?.workspaces[0].root
    const inTab = root?.type === 'tabs' ? root.children[1] : null
    expect(inTab?.type === 'split' && inTab.children[0]).toMatchObject({ collapsed: true })
    expect(inTab?.type === 'split' && inTab.children[1]).not.toHaveProperty('collapsed')
    const outside = {
      ...split('pane-1', 'pane-2'),
      children: [pane('pane-1', true), pane('pane-2', true)],
    }
    const top = parseSnapshot(
      snap({ workspaces: [{ ...snap().workspaces[0], root: outside as never }] }),
    )?.workspaces[0].root
    expect(top?.type === 'split' && top.children[0]).not.toHaveProperty('collapsed')
  })

  it('keeps a folded mark only on a split tab and only when it is true', () => {
    const tabs = {
      type: 'tabs',
      id: 'tabs-3',
      activeId: 'pane-1',
      children: [
        { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal', folded: true },
        { ...split('pane-2', 'pane-3'), folded: true },
      ],
    }
    const root = parseSnapshot(
      snap({ workspaces: [{ ...snap().workspaces[0], root: tabs as never }] }),
    )?.workspaces[0].root
    expect(root?.type === 'tabs' && root.children[0]).not.toHaveProperty('folded')
    expect(root?.type === 'tabs' && root.children[1]).toMatchObject({ folded: true })
    const loose = parseSnapshot(
      snap({
        workspaces: [
          {
            ...snap().workspaces[0],
            root: { ...split('pane-1', 'pane-2'), folded: 'yes' } as never,
          },
        ],
      }),
    )?.workspaces[0].root
    expect(loose).not.toHaveProperty('folded')
  })

  it('drops a bad split tab name and repairs the shown pane to the first pane', () => {
    const tabs = {
      type: 'tabs',
      id: 'tabs-3',
      activeId: 'pane-9',
      children: [
        { ...split('pane-2', 'pane-3'), name: 'a\u0007b' },
        { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal' },
      ],
    }
    const root = parseSnapshot(
      snap({ workspaces: [{ ...snap().workspaces[0], root: tabs as never }] }),
    )?.workspaces[0].root
    expect(root).toMatchObject({ type: 'tabs', activeId: 'pane-2' })
    expect(root?.type === 'tabs' && root.children[0]).not.toHaveProperty('name')
  })

  it('rejects a tab stack inside a split tab and keeps a name only on a split tab', () => {
    const inner = {
      type: 'tabs',
      id: 'tabs-4',
      activeId: 'pane-2',
      children: [
        { type: 'pane', id: 'pane-2', title: 'zsh', kind: 'terminal' },
        { type: 'pane', id: 'pane-3', title: 'zsh', kind: 'terminal' },
      ],
    }
    const bad = {
      type: 'tabs',
      id: 'tabs-3',
      activeId: 'pane-1',
      children: [
        { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal' },
        {
          ...split('pane-4', 'pane-5'),
          children: [{ type: 'pane', id: 'pane-4', title: 'zsh', kind: 'terminal' }, inner],
        },
      ],
    }
    expect(
      parseSnapshot(snap({ workspaces: [{ ...snap().workspaces[0], root: bad as never }] }))
        ?.workspaces,
    ).toEqual([])
    const plain = { ...split('pane-1', 'pane-2'), name: 'api' }
    expect(
      parseSnapshot(snap({ workspaces: [{ ...snap().workspaces[0], root: plain as never }] }))
        ?.workspaces[0].root,
    ).not.toHaveProperty('name')
  })

  it('accepts a split tab in a handoff', () => {
    const tabs = {
      type: 'tabs',
      id: 'tabs-3',
      activeId: 'pane-2',
      children: [
        { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal' },
        { ...split('pane-2', 'pane-3'), name: 'api' },
      ],
    }
    const workspace = parseHandoff({ ...snap().workspaces[0], activePaneId: 'pane-2', root: tabs })
    expect(workspace?.root).toMatchObject({ type: 'tabs', activeId: 'pane-2' })
    expect(workspace?.root?.type === 'tabs' && workspace.root.children[1]).toMatchObject({
      name: 'api',
    })
  })

  it('keeps a description and pin, and drops a description that is not text', () => {
    const base = snap().workspaces[0]
    const parsed = parseSnapshot(
      snap({ workspaces: [{ ...base, description: '  PR #7  ', pinned: true }] }),
    )
    expect(parsed?.workspaces[0]).toMatchObject({ description: 'PR #7', pinned: true })
    const bad = parseSnapshot(
      snap({ workspaces: [{ ...base, description: 42 as never, pinned: 'yes' as never }] }),
    )
    expect(bad?.workspaces[0]).not.toHaveProperty('description')
    expect(bad?.workspaces[0]).not.toHaveProperty('pinned')
  })

  it('keeps an empty workspace (no layout) and a user-given name', () => {
    const { root: _root, activePaneId: _active, ...empty } = snap().workspaces[0]
    const parsed = parseSnapshot(snap({ workspaces: [{ ...empty, customName: ' payments ' }] }))
    expect(parsed?.workspaces).toEqual([{ ...empty, customName: 'payments' }])
    expect(parsed?.activeWorkspaceId).toBe(empty.id)
  })

  it('never restores a scratch workspace from disk, but lets one move between windows', () => {
    const scratch = {
      id: 's2',
      name: 'Scratch',
      kind: 'scratch' as const,
      workDir: '/tmp/ostia-scratch-1000/1-aaaaaaaaaaaa',
      activePaneId: 'pane-2',
      root: { type: 'pane' as const, id: 'pane-2', title: 'zsh', kind: 'terminal' as const },
    }
    const parsed = parseSnapshot(snap({ workspaces: [...snap().workspaces, scratch] }))
    expect(parsed?.workspaces.map((s) => s.id)).toEqual(['s1'])
    expect(parseHandoff(scratch)?.kind).toBe('scratch')
  })

  describe('a pane whose kind is not a current kind', () => {
    const term = (id: string) => ({ type: 'pane', id, title: id, kind: 'terminal' })
    const retired = (id: string) => ({ type: 'pane', id, title: id, kind: 'retired-kind' })
    const withRoot = (root: unknown, activePaneId = 'a') =>
      parseSnapshot({
        ...snap(),
        workspaces: [
          { id: 's1', name: 'x', kind: 'terminal', workDir: '/tmp', activePaneId, root },
        ],
      })?.workspaces[0]

    it('leaves a workspace whose only pane it was without a layout', () => {
      const workspace = withRoot(retired('a'))
      expect(workspace?.id).toBe('s1')
      expect(workspace?.root).toBeUndefined()
      expect(workspace?.activePaneId).toBeUndefined()
    })

    it('is dropped from a split, which collapses around the pane left and keeps the other panes', () => {
      const split = (children: unknown[], sizes: number[]) => ({
        type: 'split',
        id: 'sp',
        direction: 'horizontal',
        children,
        sizes,
      })
      expect(withRoot(split([term('a'), retired('b')], [1, 1]))?.root).toMatchObject({
        type: 'pane',
        id: 'a',
      })
      const three = withRoot(split([term('a'), retired('b'), term('c')], [1, 5, 3]))?.root
      expect(three).toMatchObject({ type: 'split', sizes: [1, 3] })
      expect(three?.type === 'split' && three.children.map((c) => c.id)).toEqual(['a', 'c'])
    })

    it('is dropped from a tab stack, which keeps the tabs that remain', () => {
      const tabs = (children: unknown[]) => ({ type: 'tabs', id: 't', children, activeId: 'b' })
      expect(withRoot(tabs([term('a'), retired('b'), term('c')]))?.root).toMatchObject({
        type: 'tabs',
        activeId: 'a',
      })
      expect(withRoot(tabs([retired('a'), term('b')]), 'b')?.root).toMatchObject({
        type: 'pane',
        id: 'b',
      })
    })

    it('does not rescue a layout that is malformed in another way', () => {
      expect(
        withRoot({ type: 'split', id: 'sp', direction: 'horizontal', children: [term('a'), 5] }),
      ).toBeUndefined()
    })
  })

  it('drops a workspace that reuses a pane id already claimed by another workspace', () => {
    const dup = snap({
      workspaces: [
        ...snap().workspaces,
        {
          id: 's2',
          name: 'x',
          kind: 'terminal',
          workDir: '/tmp',
          activePaneId: 'pane-1',
          root: { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal' },
        },
      ],
    })
    expect(parseSnapshot(dup)?.workspaces.map((s) => s.id)).toEqual(['s1'])
  })

  it('drops a workspace whose split has no children', () => {
    const empty = snap({
      workspaces: [
        {
          ...snap().workspaces[0],
          root: { type: 'split', id: 'split-1', direction: 'horizontal', children: [], sizes: [] },
        },
      ],
    })
    expect(parseSnapshot(empty)?.workspaces).toEqual([])
  })

  it('rebuilds sizes that do not match the child count', () => {
    const mismatched = snap({
      workspaces: [
        { ...snap().workspaces[0], activePaneId: 'pane-1', root: split('pane-1', 'pane-2') },
      ],
    })
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the union for the test fixture
    ;(mismatched.workspaces[0].root as any).sizes = [1]
    const root = parseSnapshot(mismatched)?.workspaces[0].root
    expect(root?.type === 'split' && root.sizes).toEqual([1, 1])
  })

  it('falls back to the first workspace when activeWorkspaceId names a dropped workspace', () => {
    expect(parseSnapshot({ ...snap(), activeWorkspaceId: 'ghost' })?.activeWorkspaceId).toBe('s1')
  })

  it('falls back to the first pane when activePaneId is not in the tree', () => {
    const stale = snap({
      workspaces: [
        { ...snap().workspaces[0], activePaneId: 'pane-99', root: split('pane-1', 'pane-2') },
      ],
    })
    expect(parseSnapshot(stale)?.workspaces[0].activePaneId).toBe('pane-1')
  })

  it('rejects a tree nested past the depth cap', () => {
    let root: SnapshotNode = { type: 'pane', id: 'pane-0', title: 'zsh', kind: 'terminal' }
    for (let i = 1; i <= 40; i++) {
      root = {
        type: 'split',
        id: `split-${i}`,
        direction: 'horizontal',
        children: [root, { type: 'pane', id: `pane-${i}`, title: 'zsh', kind: 'terminal' }],
        sizes: [1, 1],
      }
    }
    expect(
      parseSnapshot(snap({ workspaces: [{ ...snap().workspaces[0], root }] }))?.workspaces,
    ).toEqual([])
  })

  it('keeps editor and browser panes with their reopen targets', () => {
    const rich = snap({
      workspaces: [
        {
          ...snap().workspaces[0],
          activePaneId: 'pane-1',
          root: {
            type: 'split',
            id: 'split-1',
            direction: 'vertical',
            children: [
              { type: 'pane', id: 'pane-1', title: 'a.ts', kind: 'editor', filePath: '/p/a.ts' },
              { type: 'pane', id: 'pane-2', title: 'localhost', kind: 'browser', url: 'http://x/' },
            ],
            sizes: [2, 1],
          },
        },
      ],
    })
    const root = parseSnapshot(rich)?.workspaces[0].root
    expect(root?.type === 'split' && root.children[0]).toMatchObject({
      kind: 'editor',
      filePath: '/p/a.ts',
    })
    expect(root?.type === 'split' && root.children[1]).toMatchObject({
      kind: 'browser',
      url: 'http://x/',
    })
  })
})

describe('saveSnapshot / loadSnapshot', () => {
  it('round-trips a snapshot through disk', () => {
    saveSnapshot(snap())
    expect(loadSnapshot()).toEqual(snap())
  })

  it('returns null when nothing was ever saved', () => {
    expect(loadSnapshot()).toBeNull()
  })

  it('round-trips an empty workspace so a restart restores zero workspaces', () => {
    saveSnapshot({ v: 1, savedAt: 'x', activeWorkspaceId: null, workspaces: [], groups: [] })
    expect(loadSnapshot()).toEqual({
      v: 1,
      savedAt: 'x',
      activeWorkspaceId: null,
      workspaces: [],
      groups: [],
    })
  })

  it('returns null (rather than throwing) when the file on disk is corrupt', () => {
    saveSnapshot(snap())
    writeFileSync(snapshotPath(), '{ not json', 'utf8')
    expect(loadSnapshot()).toBeNull()
  })

  it('validates on load, so a hand-edited file cannot inject a bogus tree', () => {
    saveSnapshot(snap())
    writeFileSync(snapshotPath(), JSON.stringify({ ...snap(), v: 99 }), 'utf8')
    expect(loadSnapshot()).toBeNull()
  })
})

describe('clearPersisted', () => {
  it('forgets both the snapshot and the saved scrollback', async () => {
    saveSnapshot(snap())
    await saveScrollback({ 'pane-1': 'hello' })
    clearPersisted()
    expect(loadSnapshot()).toBeNull()
    loadRestoredScrollback()
    expect(takeRestoredScrollback('pane-1')).toBeNull()
  })

  it('drops a scrollback save still queued when cleared', async () => {
    const saving = saveScrollback({ 'pane-1': 'queued' })
    await clearPersisted()
    await saving
    expect(existsSync(scrollbackPath())).toBe(false)
  })

  it('leaves no saved scrollback when cleared while a save is writing', async () => {
    const saving = saveScrollback({ 'pane-1': 'in flight' })
    await new Promise((resolve) => setImmediate(resolve))
    await clearPersisted()
    await saving
    expect(existsSync(scrollbackPath())).toBe(false)
  })

  it('saves scrollback again after a clear', async () => {
    clearPersisted()
    await saveScrollback({ 'pane-1': 'after' })
    loadRestoredScrollback()
    expect(takeRestoredScrollback('pane-1')).toBe('after')
  })

  it('erases stored history when workspace restore is switched off', () => {
    const broker = new WindowBroker({
      createWindow: vi.fn(),
      holdPtys: vi.fn(),
      execCommand: vi.fn(),
      agents: new AgentRunningPanes(() => {}),
      isSandboxed: () => false,
      isScratch: () => false,
      reveal: vi.fn(),
      onList: vi.fn(),
    })
    broker.register()
    broker.track({ webContents: { id: 7 }, on: vi.fn() } as unknown as BrowserWindow, MAIN_SLOT)
    const save = vi.mocked(ipcMain.on).mock.calls.find(([ch]) => ch === 'workspace:save')?.[1]
    if (!save) throw new Error('workspace:save is not handled')
    const sender = { sender: { id: 7 } } as Electron.IpcMainEvent

    save(sender, snap())
    expect(existsSync(snapshotPath())).toBe(true)
    save(sender, null)
    expect(existsSync(snapshotPath())).toBe(false)
  })
})

describe('trimScrollback', () => {
  it('leaves data under the cap untouched', () => {
    expect(trimScrollback('hello', 100)).toBe('hello')
  })

  it('keeps the tail and never severs an escape sequence', () => {
    const data = `${'A'.repeat(50)}\x1b[31m${'B'.repeat(50)}`
    const trimmed = trimScrollback(data, 60)
    expect(trimmed.length).toBeLessThanOrEqual(60)
    expect(trimmed.startsWith('\x1b[31m')).toBe(true)
  })

  it('prefers a newline boundary when one comes before the next escape', () => {
    const data = `${'A'.repeat(50)}\nline\x1b[31m`
    expect(trimScrollback(data, 12)).toBe('line\x1b[31m')
  })

  it('defaults to the per-pane cap', () => {
    expect(trimScrollback('x'.repeat(SCROLLBACK_CAP_BYTES * 2)).length).toBeLessThanOrEqual(
      SCROLLBACK_CAP_BYTES,
    )
  })
})

describe('saveScrollback / takeRestoredScrollback', () => {
  it('replays a pane’s saved output exactly once', async () => {
    await saveScrollback({ 'pane-1': 'last output' })
    loadRestoredScrollback()
    expect(takeRestoredScrollback('pane-1')).toBe('last output')
    expect(takeRestoredScrollback('pane-1')).toBeNull()
  })

  it('shows a stashed screen to its own window without consuming its one-shot replay', () => {
    stashScrollback('pane-peek', 'asleep output')
    expect(stashedScreen('pane-peek', 'w1', 'w1')).toBe('asleep output')
    expect(stashedScreen('pane-peek', 'w1', 'w1')).toBe('asleep output')
    expect(takeRestoredScrollback('pane-peek')).toBe('asleep output')
    expect(stashedScreen('pane-peek', 'w1', 'w1')).toBeNull()
  })

  it('a hibernated pane shows its saved screen after a restart', async () => {
    stashScrollback('pane-asleep', 'frozen-screen-381 up')
    await saveScrollback(pendingRestoredScrollback())
    loadRestoredScrollback()
    expect(stashedScreen('pane-asleep', 'w1', 'w1')).toBe('frozen-screen-381 up')
  })

  it('refuses a stashed screen to a window that does not own the pane', () => {
    stashScrollback('pane-other', 'secret output')
    expect(stashedScreen('pane-other', 'w2', 'w1')).toBeNull()
    expect(stashedScreen('pane-other', 'w2', undefined)).toBeNull()
    expect(takeRestoredScrollback('pane-other')).toBe('secret output')
  })

  it('returns null for a pane with no saved output', async () => {
    await saveScrollback({ 'pane-1': 'x' })
    loadRestoredScrollback()
    expect(takeRestoredScrollback('pane-2')).toBeNull()
  })

  it('trims each pane to the cap on write', async () => {
    await saveScrollback({ 'pane-1': 'x'.repeat(SCROLLBACK_CAP_BYTES * 3) })
    loadRestoredScrollback()
    expect((takeRestoredScrollback('pane-1') ?? '').length).toBeLessThanOrEqual(
      SCROLLBACK_CAP_BYTES,
    )
  })

  it('never writes a scratch pane’s output', async () => {
    await saveScrollback({ 'pane-1': 'kept', 'pane-2': 'scratch output' }, (id) => id === 'pane-2')
    loadRestoredScrollback()
    expect(takeRestoredScrollback('pane-1')).toBe('kept')
    expect(takeRestoredScrollback('pane-2')).toBeNull()
  })

  it('skips panes with nothing to replay', async () => {
    await saveScrollback({ 'pane-1': '', 'pane-2': 'kept' })
    loadRestoredScrollback()
    expect(takeRestoredScrollback('pane-1')).toBeNull()
    expect(takeRestoredScrollback('pane-2')).toBe('kept')
  })

  it('writes the file off the calling tick, compact and without a temp file left', async () => {
    const saving = saveScrollback({ 'pane-1': 'later' })
    expect(existsSync(scrollbackPath())).toBe(false)
    await saving
    expect(readFileSync(scrollbackPath(), 'utf8')).toBe('{"pane-1":"later"}')
    expect(existsSync(`${scrollbackPath()}.tmp`)).toBe(false)
  })

  it('survives a corrupt scrollback file', async () => {
    await saveScrollback({ 'pane-1': 'x' })
    writeFileSync(scrollbackPath(), 'not json at all', 'utf8')
    expect(() => loadRestoredScrollback()).not.toThrow()
    expect(takeRestoredScrollback('pane-1')).toBeNull()
  })
})

describe('browser profile on a pane', () => {
  function withRoot(root: unknown): unknown {
    const base = snap()
    return { ...base, workspaces: [{ ...base.workspaces[0], activePaneId: 'b1', root }] }
  }

  function browserPane(extra: Record<string, unknown>): Record<string, unknown> {
    return { type: 'pane', id: 'b1', title: 'site', kind: 'browser', url: 'http://x/', ...extra }
  }

  it('keeps the shared profile of a browser pane through a save and restore', () => {
    const root = parseSnapshot(withRoot(browserPane({ browserProfile: 'shared' })))?.workspaces[0]
      .root
    expect(root).toMatchObject({ kind: 'browser', browserProfile: 'shared' })
  })

  it('treats a missing or unknown profile as isolated by leaving it out', () => {
    for (const browserProfile of [undefined, 'isolated', 'persist', 7, { shared: true }]) {
      const root = parseSnapshot(withRoot(browserPane({ browserProfile })))?.workspaces[0].root
      expect(root?.type === 'pane' && root.browserProfile).toBeFalsy()
    }
  })

  it('never carries a profile on a pane that is not a browser', () => {
    const root = parseSnapshot(
      withRoot({
        type: 'pane',
        id: 'b1',
        title: 'zsh',
        kind: 'terminal',
        browserProfile: 'shared',
      }),
    )?.workspaces[0].root
    expect(root).not.toHaveProperty('browserProfile')
  })

  it('keeps a moving pane on the profile it had (handoff to another window)', () => {
    const base = snap().workspaces[0]
    const shared = parseHandoff({
      ...base,
      activePaneId: 'b1',
      root: browserPane({ browserProfile: 'shared' }),
    })
    const isolated = parseHandoff({ ...base, activePaneId: 'b1', root: browserPane({}) })
    expect(shared?.root).toMatchObject({ browserProfile: 'shared' })
    expect(isolated?.root).not.toHaveProperty('browserProfile')
  })
})

describe('device mode on a browser pane', () => {
  function restored(pane: Record<string, unknown>): unknown {
    const base = snap()
    return parseSnapshot({
      ...base,
      workspaces: [{ ...base.workspaces[0], activePaneId: 'b1', root: { id: 'b1', ...pane } }],
    })?.workspaces[0].root
  }

  const browser = { type: 'pane', title: 'site', kind: 'browser', url: 'http://x/' }

  it('keeps the device a browser pane was in through a save and restore', () => {
    const browserDevice = { preset: 'responsive', width: 600, height: 900, dpr: 2, zoom: 'actual' }
    expect(restored({ ...browser, browserDevice })).toMatchObject({ browserDevice })
  })

  it('restores a preset from the data, keeping only its orientation and zoom', () => {
    const browserDevice = { preset: 'iphone-se', width: 900, height: 100, dpr: 7, zoom: 'fit' }
    expect(restored({ ...browser, browserDevice })).toMatchObject({
      browserDevice: { preset: 'iphone-se', width: 667, height: 375, dpr: 2, zoom: 'fit' },
    })
  })

  it('drops a device that is not one, or on a pane that is not a browser', () => {
    for (const browserDevice of [true, 'iphone-se', { preset: 'responsive' }, { width: 'x' }]) {
      expect(restored({ ...browser, browserDevice })).not.toHaveProperty('browserDevice')
    }
    const terminal = { type: 'pane', title: 'zsh', kind: 'terminal' }
    const browserDevice = { preset: 'responsive', width: 600, height: 900, dpr: 1, zoom: 'fit' }
    expect(restored({ ...terminal, browserDevice })).not.toHaveProperty('browserDevice')
  })
})
