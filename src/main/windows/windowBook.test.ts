import { describe, expect, it } from 'vitest'
import type { AppSnapshot, SnapshotWorkspace } from '../../shared/types'
import {
  handoffPaneIds,
  parseHandoff,
  parsePaneDrop,
  parseSnapshot,
} from '../workspaces/workspaceSnapshot'
import {
  LANDING_CLAIM_MS,
  LANDING_GIVE_MS,
  Landings,
  MAIN_SLOT,
  WindowBook,
  boundsAt,
  clampBounds,
  crossesSandbox,
  mergeSnapshots,
  parsePoint,
  planReturn,
  splitSnapshot,
} from './windowBook'

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

  it('keeps the hibernated mark of a pane carried by a handoff', () => {
    const book = new WindowBook(null)
    book.open('d1', BOUNDS)
    const moving = workspace('w2', 'pane-2')
    if (moving.root?.type === 'pane') {
      moving.root.resume = { agent: 'claude', id: 'abc' }
      moving.root.hibernated = true
    }
    book.move(moving, MAIN_SLOT, 'd1')
    const saved = book.merged('t').windows?.[0]?.workspaces[0]
    expect(saved?.root).toMatchObject({ id: 'pane-2', hibernated: true })
  })

  it('keeps the lock of a pane carried by a handoff', () => {
    const book = new WindowBook(null)
    book.open('d1', BOUNDS)
    const moving = workspace('w2', 'pane-2')
    if (moving.root?.type === 'pane') moving.root.locked = true
    book.move(moving, MAIN_SLOT, 'd1')
    const saved = book.merged('t').windows?.[0]?.workspaces[0]
    expect(saved?.root).toMatchObject({ id: 'pane-2', locked: true })
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

  it('keeps the main window bounds out of the renderer snapshot and in the merged file', () => {
    const book = new WindowBook(snapshot([workspace('w1', 'pane-1')], { bounds: BOUNDS }))
    expect(book.boundsOf(MAIN_SLOT)).toEqual(BOUNDS)
    expect(book.load(MAIN_SLOT)?.bounds).toBeUndefined()

    const moved = { x: 76, y: 80, width: 1361, height: 854 }
    book.setBounds(MAIN_SLOT, moved)
    book.save(MAIN_SLOT, snapshot([workspace('w1', 'pane-1')], { bounds: BOUNDS }))
    expect(book.merged('t').bounds).toEqual(moved)
    expect(new WindowBook(parseSnapshot(book.merged('t'))).boundsOf(MAIN_SLOT)).toEqual(moved)
  })

  it('remembers where a workspace last was in its own window', () => {
    const book = new WindowBook(snapshot([workspace('w1', 'pane-1'), workspace('w2', 'pane-2')]))
    book.open('d1', BOUNDS)
    book.move(workspace('w2', 'pane-2'), MAIN_SLOT, 'd1')
    expect(book.lastDetachedBounds('w2')).toBeNull()

    const moved = { x: 20, y: 40, width: 800, height: 500 }
    book.setBounds('d1', moved)
    book.move(workspace('w2', 'pane-2'), 'd1', MAIN_SLOT)
    book.drop('d1')
    expect(book.lastDetachedBounds('w2')).toEqual(moved)
    expect(book.merged('t').detachedBounds).toEqual({ w2: moved })
    expect(new WindowBook(parseSnapshot(book.merged('t'))).lastDetachedBounds('w2')).toEqual(moved)
    expect(book.load(MAIN_SLOT)?.detachedBounds).toBeUndefined()

    book.save(MAIN_SLOT, snapshot([workspace('w1', 'pane-1')]))
    expect(book.merged('t').detachedBounds).toBeUndefined()
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

  it('keeps last detached bounds only for workspaces in the file', () => {
    const parsed = parseSnapshot(
      snapshot([workspace('w1', 'pane-1')], {
        detachedBounds: { w1: BOUNDS, gone: BOUNDS, w9: { ...BOUNDS, height: 1 } },
      }),
    )
    expect(parsed?.detachedBounds).toEqual({ w1: BOUNDS })
  })

  it('keeps valid main window bounds and drops invalid ones', () => {
    expect(parseSnapshot(snapshot([], { bounds: BOUNDS }))?.bounds).toEqual(BOUNDS)
    const tiny = { ...BOUNDS, width: 10 }
    expect(parseSnapshot(snapshot([], { bounds: tiny }))).not.toHaveProperty('bounds')
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

  it('keeps a hibernated mark from the file only for a pane that can be resumed', () => {
    const resumable = workspace('w1', 'pane-1')
    if (resumable.root?.type === 'pane') {
      resumable.root.resume = { agent: 'claude', id: 'abc' }
      resumable.root.hibernated = true
    }
    const plain = workspace('w2', 'pane-2')
    if (plain.root?.type === 'pane') plain.root.hibernated = true
    const parsed = parseSnapshot(snapshot([resumable, plain]))
    expect(parsed?.workspaces[0]?.root).toMatchObject({ id: 'pane-1', hibernated: true })
    expect(JSON.stringify(parsed?.workspaces[1])).not.toContain('hibernated')
  })
})

describe('parseHandoff', () => {
  it('keeps the hibernated mark of a pane with a resume token', () => {
    const w = workspace('w1', 'pane-1')
    if (w.root?.type === 'pane') {
      w.root.resume = { agent: 'claude', id: 'abc', cwd: '/w/tree' }
      w.root.hibernated = true
    }
    const parsed = parseHandoff(w)
    expect(parsed?.root).toMatchObject({
      id: 'pane-1',
      hibernated: true,
      resume: { agent: 'claude', id: 'abc', cwd: '/w/tree' },
    })
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

describe('workspace origin', () => {
  const origin = {
    workspaceId: 'w1',
    index: 2,
    groupId: 'g1',
    beside: { paneId: 'pane-1', zone: 'center' as const },
  }

  it('travels with a handoff and survives a restart of the detached window', () => {
    const moving = parseHandoff(workspace('w9', 'pane-9', { origin }))
    expect(moving?.origin).toEqual(origin)
    const book = new WindowBook(null)
    book.open('d1', BOUNDS)
    if (moving) book.move(moving, MAIN_SLOT, 'd1')
    const reloaded = new WindowBook(parseSnapshot(book.merged('t')))
    expect(reloaded.load('d1')?.workspaces[0].origin).toEqual(origin)
  })

  it('drops a malformed origin and clamps its index', () => {
    expect(parseHandoff(workspace('w9', 'p', { origin: { index: 1 } as never }))?.origin).toBe(
      undefined,
    )
    const parsed = parseHandoff(
      workspace('w9', 'p', {
        origin: { workspaceId: 'w1', index: -4, beside: { paneId: 'p1', zone: 'up' } } as never,
      }),
    )
    expect(parsed?.origin).toEqual({ workspaceId: 'w1', index: 0 })
  })
})

describe('planReturn', () => {
  const none = () => false
  const moved = workspace('w9', 'pane-9', {
    origin: { workspaceId: 'w1', index: 1, beside: { paneId: 'pane-1', zone: 'right' } },
  })

  it('sends a moved pane back to the window that still holds its workspace', () => {
    const plan = planReturn(moved, 'd', 'm', (id) => (id === 'w1' ? 'm' : undefined), none)
    expect(plan).toEqual({ windowId: 'm', workspace: moved })
  })

  it('rejoins a workspace that now lives in another detached window', () => {
    const plan = planReturn(moved, 'd', 'm', (id) => (id === 'w1' ? 'e' : undefined), none)
    expect(plan.windowId).toBe('e')
  })

  it('keeps the place of a pane whose workspace is gone but never rejoins it', () => {
    const plan = planReturn(moved, 'd', 'm', () => undefined, none)
    expect(plan.windowId).toBe('m')
    expect(plan.workspace.origin).toEqual({ workspaceId: 'w9', index: 1 })
  })

  it('never merges a pane into or out of a sandboxed workspace', () => {
    const plan = planReturn(
      moved,
      'd',
      'm',
      () => 'm',
      (id) => id === 'w1',
    )
    expect(plan.workspace.origin?.workspaceId).toBe('w9')
  })

  it('returns a whole workspace to its old place in the main window', () => {
    const whole = workspace('w1', 'pane-1', { origin: { workspaceId: 'w1', index: 3 } })
    expect(planReturn(whole, 'd', 'm', () => undefined, none)).toEqual({
      windowId: 'm',
      workspace: whole,
    })
  })
})

describe('crossesSandbox', () => {
  it('refuses moving a pane out of a sandboxed workspace', () => {
    expect(crossesSandbox(['w1'], 'w9', (id) => id === 'w1')).toBe(true)
  })

  it('refuses moving a pane into a sandboxed workspace', () => {
    expect(crossesSandbox(['w1'], 'w9', (id) => id === 'w9')).toBe(true)
  })

  it('lets a sandboxed workspace move whole', () => {
    expect(crossesSandbox(['w1', 'w1', undefined], 'w1', () => true)).toBe(false)
  })
})

describe('boundsAt', () => {
  const areas = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 1280, height: 1024 },
  ]

  it('opens the window under the drop point on the display it is on', () => {
    expect(boundsAt({ x: 2100, y: 100 }, { width: 1100, height: 760 }, areas)).toEqual({
      x: 1980,
      y: 84,
      width: 1100,
      height: 760,
    })
  })

  it('keeps a drop at a screen edge on screen', () => {
    const bounds = boundsAt({ x: 1900, y: 1070 }, { width: 1100, height: 760 }, areas)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1920)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1080)
  })

  it('accepts only finite points', () => {
    expect(parsePoint({ x: 10.4, y: 20 })).toEqual({ x: 10, y: 20 })
    expect(parsePoint({ x: Number.NaN, y: 1 })).toBeNull()
    expect(parsePoint({ x: 1 })).toBeNull()
    expect(parsePoint(null)).toBeNull()
  })
})

describe('parsePaneDrop', () => {
  it('accepts a drop on a pane with a known zone only', () => {
    const drop = { paneId: 'p1', workspaceId: 'w1', placement: { paneId: 'p2', zone: 'right' } }
    expect(parsePaneDrop(drop)).toEqual(drop)
    expect(parsePaneDrop({ ...drop, placement: { paneId: 'p2', zone: 'diagonal' } })).toBeNull()
    expect(parsePaneDrop({ ...drop, paneId: '' })).toBeNull()
    expect(parsePaneDrop('p1')).toBeNull()
  })
})

describe('Landings', () => {
  const landing = {
    windowId: '2',
    workspaceId: 'w1',
    placement: { paneId: 'p2', zone: 'center' as const },
  }

  it('hands a drop to the source once: claim, then take', () => {
    const landings = new Landings()
    landings.record('p1', landing, 0)
    expect(landings.pending('p1', 10)).toBe(true)
    expect(landings.claim('p1', 10)).toBe(true)
    expect(landings.claim('p1', 20)).toBe(false)
    expect(landings.take('p1', 30)).toEqual(landing)
    expect(landings.take('p1', 40)).toBeNull()
  })

  it('never gives a pane that was not claimed first', () => {
    const landings = new Landings()
    landings.record('p1', landing, 0)
    expect(landings.take('p1', 10)).toBeNull()
  })

  it('forgets a drop nobody claimed soon after, so a later cancelled drag never moves the pane', () => {
    const landings = new Landings()
    landings.record('p1', landing, 0)
    expect(landings.claim('p1', LANDING_CLAIM_MS + 1)).toBe(false)
  })

  it('lets the human answer the unsaved-files dialog before the claim runs out', () => {
    const landings = new Landings()
    landings.record('p1', landing, 0)
    landings.claim('p1', 100)
    expect(landings.take('p1', 100 + LANDING_GIVE_MS + 1)).toBeNull()
  })
})
