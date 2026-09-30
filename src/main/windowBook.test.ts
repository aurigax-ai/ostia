import { describe, expect, it } from 'vitest'
import type { AppSnapshot, SnapshotWorkspace } from '../shared/types'
import { MAIN_SLOT, WindowBook, clampBounds, mergeSnapshots, splitSnapshot } from './windowBook'
import { handoffPaneIds, parseHandoff, parseSnapshot } from './workspaceSnapshot'

function workspace(
  id: string,
  paneId: string,
  extra?: Partial<SnapshotWorkspace>,
): SnapshotWorkspace {
  return {
    id,
    name: id,
    kind: 'terminal',
    workDir: `/home/u/${id}`,
    activePaneId: paneId,
    root: { type: 'pane', id: paneId, title: 'zsh', kind: 'terminal' },
    ...extra,
  }
}

function snapshot(workspaces: SnapshotWorkspace[], extra?: Partial<AppSnapshot>): AppSnapshot {
  return {
    v: 1,
    savedAt: 't0',
    activeWorkspaceId: workspaces[0]?.id ?? null,
    workspaces,
    groups: [],
    ...extra,
  }
}

const BOUNDS = { x: 100, y: 50, width: 900, height: 600 }

describe('mergeSnapshots', () => {
  it('keeps the main window at the top level and each detached window in windows', () => {
    const merged = mergeSnapshots(
      snapshot([workspace('w1', 'pane-1')]),
      [{ id: 'd1', bounds: BOUNDS, snapshot: snapshot([workspace('w2', 'pane-2')]) }],
      't1',
    )
    expect(merged.workspaces.map((w) => w.id)).toEqual(['w1'])
    expect(merged.windows).toEqual([
      {
        id: 'd1',
        bounds: BOUNDS,
        activeWorkspaceId: 'w2',
        workspaces: [workspace('w2', 'pane-2')],
      },
    ])
    expect(merged.savedAt).toBe('t1')
  })

  it('drops a detached window that holds no workspace', () => {
    const merged = mergeSnapshots(null, [{ id: 'd1', bounds: BOUNDS, snapshot: snapshot([]) }], 't')
    expect(merged.windows).toBeUndefined()
    expect(merged.workspaces).toEqual([])
  })

  it('round-trips through splitSnapshot', () => {
    const merged = mergeSnapshots(
      snapshot([workspace('w1', 'pane-1')]),
      [{ id: 'd1', bounds: BOUNDS, snapshot: snapshot([workspace('w2', 'pane-2')]) }],
      't1',
    )
    const split = splitSnapshot(merged)
    expect(split.main?.workspaces.map((w) => w.id)).toEqual(['w1'])
    expect(split.main && 'windows' in split.main).toBe(false)
    expect(split.detached).toHaveLength(1)
    expect(split.detached[0].snapshot.workspaces.map((w) => w.id)).toEqual(['w2'])
  })
})

describe('WindowBook', () => {
  it('does not let one window save over another window’s workspaces', () => {
    const book = new WindowBook(null)
    book.open('d1', BOUNDS)
    book.save('d1', snapshot([workspace('w2', 'pane-2')]))
    book.save(MAIN_SLOT, snapshot([workspace('w1', 'pane-1')]))
    const merged = book.merged('t')
    expect(merged.workspaces.map((w) => w.id)).toEqual(['w1'])
    expect(merged.windows?.[0].workspaces.map((w) => w.id)).toEqual(['w2'])
  })

  it('moves a workspace between windows without duplicating it', () => {
    const book = new WindowBook(snapshot([workspace('w1', 'pane-1'), workspace('w2', 'pane-2')]))
    book.open('d1', BOUNDS)
    book.move(workspace('w2', 'pane-2', { groupId: 'g1' }), MAIN_SLOT, 'd1')
    const merged = book.merged('t')
    expect(merged.workspaces.map((w) => w.id)).toEqual(['w1'])
    expect(merged.windows?.[0].workspaces).toEqual([workspace('w2', 'pane-2')])
    expect(merged.windows?.[0].activeWorkspaceId).toBe('w2')

    book.move(workspace('w2', 'pane-2'), 'd1', MAIN_SLOT)
    book.drop('d1')
    const back = book.merged('t')
    expect(back.workspaces.map((w) => w.id)).toEqual(['w1', 'w2'])
    expect(back.activeWorkspaceId).toBe('w2')
    expect(back.windows).toBeUndefined()
  })

  it('never persists a hibernated mark carried by a handoff', () => {
    const book = new WindowBook(null)
    book.open('d1', BOUNDS)
    const moving = workspace('w2', 'pane-2')
    if (moving.root?.type === 'pane') moving.root.hibernated = true
    book.move(moving, MAIN_SLOT, 'd1')
    expect(JSON.stringify(book.merged('t'))).not.toContain('hibernated')
  })

  it('restores detached windows with their bounds from the merged file', () => {
    const book = new WindowBook(
      snapshot([workspace('w1', 'pane-1')], {
        windows: [
          {
            id: 'd1',
            bounds: BOUNDS,
            activeWorkspaceId: 'w2',
            workspaces: [workspace('w2', 'p2')],
          },
        ],
      }),
    )
    expect(book.slots().map((s) => [s.id, s.bounds])).toEqual([['d1', BOUNDS]])
    expect(book.load('d1')?.workspaces.map((w) => w.id)).toEqual(['w2'])
    expect(book.load(MAIN_SLOT)?.workspaces.map((w) => w.id)).toEqual(['w1'])
  })

  it('ignores saves from a slot that was never opened', () => {
    const book = new WindowBook(null)
    book.save('ghost', snapshot([workspace('w9', 'pane-9')]))
    expect(book.merged('t').windows).toBeUndefined()
  })
})

describe('clampBounds', () => {
  const left = { x: 0, y: 0, width: 1920, height: 1080 }
  const right = { x: 1920, y: 0, width: 1280, height: 1024 }

  it('keeps a window on the display it mostly overlaps', () => {
    const bounds = { x: 2000, y: 100, width: 800, height: 600 }
    expect(clampBounds(bounds, [left, right])).toEqual(bounds)
  })

  it('pulls a window from a disconnected display onto the primary one', () => {
    const bounds = { x: 4000, y: 100, width: 800, height: 600 }
    expect(clampBounds(bounds, [left])).toEqual({ x: 1120, y: 100, width: 800, height: 600 })
  })

  it('shrinks a window larger than its display', () => {
    const bounds = { x: 1900, y: -50, width: 3000, height: 2000 }
    expect(clampBounds(bounds, [left, right])).toEqual({ x: 1920, y: 0, width: 1280, height: 1024 })
  })
})

describe('parseSnapshot windows', () => {
  it('parses detached windows and refuses a pane claimed twice across windows', () => {
    const parsed = parseSnapshot(
      snapshot([workspace('w1', 'pane-1')], {
        windows: [
          {
            id: 'd1',
            bounds: BOUNDS,
            activeWorkspaceId: 'w2',
            workspaces: [workspace('w2', 'p2')],
          },
          {
            id: 'd2',
            bounds: BOUNDS,
            activeWorkspaceId: 'w3',
            workspaces: [workspace('w3', 'pane-1')],
          },
        ],
      }),
    )
    expect(parsed?.windows?.map((w) => w.id)).toEqual(['d1'])
  })

  it('drops a window with invalid bounds or id', () => {
    const parsed = parseSnapshot(
      snapshot([], {
        windows: [
          {
            id: '../x',
            bounds: BOUNDS,
            activeWorkspaceId: null,
            workspaces: [workspace('w2', 'p2')],
          },
          {
            id: 'd2',
            bounds: { x: 0, y: 0, width: 10, height: 600 },
            activeWorkspaceId: null,
            workspaces: [workspace('w3', 'p3')],
          },
        ],
      }),
    )
    expect(parsed?.windows).toBeUndefined()
  })

  it('never keeps a hibernated mark from the file', () => {
    const w = workspace('w1', 'pane-1')
    if (w.root?.type === 'pane') {
      w.root.resume = { agent: 'claude', id: 'abc' }
      w.root.hibernated = true
    }
    const parsed = parseSnapshot(snapshot([w]))
    expect(JSON.stringify(parsed)).not.toContain('hibernated')
  })
})

describe('parseHandoff', () => {
  it('keeps the hibernated mark of a pane with a resume token', () => {
    const w = workspace('w1', 'pane-1')
    if (w.root?.type === 'pane') {
      w.root.resume = { agent: 'claude', id: 'abc' }
      w.root.hibernated = true
    }
    const parsed = parseHandoff(w)
    expect(parsed?.root).toMatchObject({ id: 'pane-1', hibernated: true })
  })

  it('carries the project folder through a move and into the merged file', () => {
    const moving = parseHandoff(workspace('w2', 'pane-2', { projectDir: '~/code/web' }))
    expect(moving?.projectDir).toBe('~/code/web')
    const book = new WindowBook(null)
    book.open('d1', BOUNDS)
    if (moving) book.move(moving, MAIN_SLOT, 'd1')
    expect(parseSnapshot(book.merged('t'))?.windows?.[0].workspaces[0].projectDir).toBe(
      '~/code/web',
    )
  })

  it('refuses a malformed workspace', () => {
    expect(parseHandoff({ id: 'w1', root: { type: 'bogus' } })).toBeNull()
    expect(parseHandoff('w1')).toBeNull()
  })

  it('lists every pane id in the workspace', () => {
    const w = workspace('w1', 'a', {
      root: {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [1, 1],
        children: [
          { type: 'pane', id: 'a', title: 'zsh', kind: 'terminal' },
          {
            type: 'tabs',
            id: 'tabs-1',
            activeId: 'b',
            children: [
              { type: 'pane', id: 'b', title: 'zsh', kind: 'terminal' },
              { type: 'pane', id: 'c', title: 'zsh', kind: 'terminal' },
            ],
          },
        ],
      },
    })
    const parsed = parseHandoff(w)
    expect(parsed && handoffPaneIds(parsed)).toEqual(['a', 'b', 'c'])
  })
})
