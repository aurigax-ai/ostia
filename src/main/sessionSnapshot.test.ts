import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotNode, WorkspaceSnapshot } from '../shared/types'
import {
  SCROLLBACK_CAP_BYTES,
  clearPersisted,
  loadRestoredScrollback,
  loadSnapshot,
  parseSnapshot,
  saveScrollback,
  saveSnapshot,
  scrollbackPath,
  snapshotPath,
  takeRestoredScrollback,
  trimScrollback,
} from './sessionSnapshot'

function snap(overrides?: Partial<WorkspaceSnapshot>): WorkspaceSnapshot {
  return {
    v: 1,
    savedAt: '2026-08-06T00:00:00.000Z',
    activeSessionId: 's1',
    sessions: [
      {
        id: 's1',
        name: 'terminal',
        kind: 'terminal',
        workDir: '/home/u/proj',
        activePaneId: 'pane-1',
        root: { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal', cwd: '/home/u/proj' },
      },
    ],
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
  dataDir = mkdtempSync(join(tmpdir(), 'pine-snapshot-test-'))
  vi.stubEnv('XDG_DATA_HOME', dataDir)
  loadRestoredScrollback()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('parseSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    expect(parseSnapshot(snap())).toEqual(snap())
  })

  it('rejects a snapshot written by a different schema version', () => {
    expect(parseSnapshot({ ...snap(), v: 2 })).toBeNull()
  })

  it('rejects a non-object', () => {
    expect(parseSnapshot(null)).toBeNull()
    expect(parseSnapshot('nope')).toBeNull()
  })

  it('keeps an empty workspace as a snapshot with no sessions and no active session', () => {
    expect(parseSnapshot({ ...snap(), sessions: [] })).toEqual({
      v: 1,
      savedAt: snap().savedAt,
      activeSessionId: null,
      sessions: [],
    })
  })

  it('keeps a pane’s agent resume token and drops a malformed one', () => {
    const pane = snap().sessions[0].root
    const withResume = (resume: unknown) =>
      parseSnapshot(
        snap({ sessions: [{ ...snap().sessions[0], root: { ...pane, resume } as never }] }),
      )
    expect(withResume({ agent: 'claude', id: 'abc-1' })?.sessions[0].root).toMatchObject({
      resume: { agent: 'claude', id: 'abc-1' },
    })
    expect(withResume({ agent: 'claude', id: 'x; rm -rf ~' })?.sessions[0].root).not.toHaveProperty(
      'resume',
    )
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
      snap({ sessions: [{ ...snap().sessions[0], root: tabs as never }] }),
    )
    expect(parsed?.sessions[0].root).toMatchObject({ type: 'tabs', activeId: 'pane-1' })
  })

  it('unwraps a one-tab stack and rejects a stack holding a split', () => {
    const one = {
      type: 'tabs',
      id: 'tabs-3',
      activeId: 'pane-1',
      children: [{ type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal' }],
    }
    expect(
      parseSnapshot(snap({ sessions: [{ ...snap().sessions[0], root: one as never }] }))
        ?.sessions[0].root,
    ).toMatchObject({ type: 'pane', id: 'pane-1' })
    const nested = { ...one, children: [split('pane-1', 'pane-2')] }
    expect(
      parseSnapshot(snap({ sessions: [{ ...snap().sessions[0], root: nested as never }] }))
        ?.sessions,
    ).toEqual([])
  })

  it('drops a session whose pane kind is unknown', () => {
    const bad = snap({
      sessions: [
        ...snap().sessions,
        {
          id: 's2',
          name: 'x',
          kind: 'terminal',
          workDir: '/tmp',
          activePaneId: 'pane-2',
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid on-disk data
          root: { type: 'pane', id: 'pane-2', title: 'x', kind: 'quantum' as any },
        },
      ],
    })
    const parsed = parseSnapshot(bad)
    expect(parsed?.sessions.map((s) => s.id)).toEqual(['s1'])
  })

  it('drops a session that reuses a pane id already claimed by another session', () => {
    const dup = snap({
      sessions: [
        ...snap().sessions,
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
    expect(parseSnapshot(dup)?.sessions.map((s) => s.id)).toEqual(['s1'])
  })

  it('drops a session whose split has no children', () => {
    const empty = snap({
      sessions: [
        {
          ...snap().sessions[0],
          root: { type: 'split', id: 'split-1', direction: 'horizontal', children: [], sizes: [] },
        },
      ],
    })
    expect(parseSnapshot(empty)?.sessions).toEqual([])
  })

  it('rebuilds sizes that do not match the child count', () => {
    const mismatched = snap({
      sessions: [
        { ...snap().sessions[0], activePaneId: 'pane-1', root: split('pane-1', 'pane-2') },
      ],
    })
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the union for the test fixture
    ;(mismatched.sessions[0].root as any).sizes = [1]
    const root = parseSnapshot(mismatched)?.sessions[0].root
    expect(root?.type === 'split' && root.sizes).toEqual([1, 1])
  })

  it('falls back to the first session when activeSessionId names a dropped session', () => {
    expect(parseSnapshot({ ...snap(), activeSessionId: 'ghost' })?.activeSessionId).toBe('s1')
  })

  it('falls back to the first pane when activePaneId is not in the tree', () => {
    const stale = snap({
      sessions: [
        { ...snap().sessions[0], activePaneId: 'pane-99', root: split('pane-1', 'pane-2') },
      ],
    })
    expect(parseSnapshot(stale)?.sessions[0].activePaneId).toBe('pane-1')
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
    expect(parseSnapshot(snap({ sessions: [{ ...snap().sessions[0], root }] }))?.sessions).toEqual(
      [],
    )
  })

  it('keeps editor and browser panes with their reopen targets', () => {
    const rich = snap({
      sessions: [
        {
          ...snap().sessions[0],
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
    const root = parseSnapshot(rich)?.sessions[0].root
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

  it('round-trips an empty workspace so a restart restores zero sessions', () => {
    saveSnapshot({ v: 1, savedAt: 'x', activeSessionId: null, sessions: [] })
    expect(loadSnapshot()).toEqual({ v: 1, savedAt: 'x', activeSessionId: null, sessions: [] })
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
  it('forgets both the snapshot and the saved scrollback', () => {
    saveSnapshot(snap())
    saveScrollback({ 'pane-1': 'hello' })
    clearPersisted()
    expect(loadSnapshot()).toBeNull()
    loadRestoredScrollback()
    expect(takeRestoredScrollback('pane-1')).toBeNull()
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
  it('replays a pane’s saved output exactly once', () => {
    saveScrollback({ 'pane-1': 'last output' })
    loadRestoredScrollback()
    expect(takeRestoredScrollback('pane-1')).toBe('last output')
    expect(takeRestoredScrollback('pane-1')).toBeNull()
  })

  it('returns null for a pane with no saved output', () => {
    saveScrollback({ 'pane-1': 'x' })
    loadRestoredScrollback()
    expect(takeRestoredScrollback('pane-2')).toBeNull()
  })

  it('trims each pane to the cap on write', () => {
    saveScrollback({ 'pane-1': 'x'.repeat(SCROLLBACK_CAP_BYTES * 3) })
    loadRestoredScrollback()
    expect((takeRestoredScrollback('pane-1') ?? '').length).toBeLessThanOrEqual(
      SCROLLBACK_CAP_BYTES,
    )
  })

  it('skips panes with nothing to replay', () => {
    saveScrollback({ 'pane-1': '', 'pane-2': 'kept' })
    loadRestoredScrollback()
    expect(takeRestoredScrollback('pane-1')).toBeNull()
    expect(takeRestoredScrollback('pane-2')).toBe('kept')
  })

  it('survives a corrupt scrollback file', () => {
    saveScrollback({ 'pane-1': 'x' })
    writeFileSync(scrollbackPath(), 'not json at all', 'utf8')
    expect(() => loadRestoredScrollback()).not.toThrow()
    expect(takeRestoredScrollback('pane-1')).toBeNull()
  })
})
