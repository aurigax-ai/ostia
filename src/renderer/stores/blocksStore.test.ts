import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useBlocksStore } from './blocksStore'

/**
 * `blocksStore` is a per-pane OSC 133 command-block state machine (A→B→C→D). Each pane
 * moves a `draft` (A/B) into a committed `CommandBlock` on C, marks it running until D,
 * and recovers a lost D by closing a stale block when the next C arrives.
 *
 * The store is PURE (no window deps), so we snapshot pristine state in beforeAll and
 * `setState(init, true)` (replace, not merge) in afterEach so panes never bleed across
 * tests. Block ids/timestamps derive from Date.now()+Math.random(), so we assert the
 * STRUCTURAL fields (promptLine/inputLine/outputStartLine/endLine/exitCode/cwd) and the
 * running/draft/gen bookkeeping — never exact ids.
 */

const store = () => useBlocksStore.getState()

describe('blocksStore', () => {
  let init: ReturnType<typeof useBlocksStore.getState>

  beforeAll(() => {
    // Snapshot pristine state (data + stable action fns) before any test mutates.
    init = useBlocksStore.getState()
  })

  afterEach(() => {
    // Restore to pristine (replace, not merge) so panes/blocks/gen don't leak.
    useBlocksStore.setState(init, true)
  })

  it('runs the full A→B→C→D lifecycle into a single committed block', () => {
    const p = 'pane-1'
    store().promptStart(p, 10, '/home')
    store().promptEnd(p, 12)
    store().commandStart(p, 13)
    // On C the block is committed and running: startedAt is set, endedAt still null.
    const running = store().byPane[p]?.[0]
    expect(typeof running?.startedAt).toBe('number')
    expect(running?.endedAt).toBeNull()

    store().commandEnd(p, 20, 0)

    const list = store().byPane[p]
    expect(list).toHaveLength(1)
    const block = list?.[0]
    expect(block).toMatchObject({
      paneId: p,
      promptLine: 10,
      inputLine: 12,
      outputStartLine: 13,
      endLine: 20,
      exitCode: 0,
      cwd: '/home',
    })
    // D stamps endedAt; timestamps are set (not exact) and ordered start ≤ end.
    expect(typeof block?.startedAt).toBe('number')
    expect(typeof block?.endedAt).toBe('number')
    expect(block?.endedAt as number).toBeGreaterThanOrEqual(block?.startedAt as number)
    // D cleared the running pointer; C cleared the draft.
    expect(store().running[p]).toBeUndefined()
    expect(store().drafts[p]).toBeUndefined()
  })

  it('sets the draft on promptStart and fills inputLine on promptEnd', () => {
    const p = 'pane-draft'
    store().promptStart(p, 4, '/tmp')
    expect(store().drafts[p]).toEqual({ promptLine: 4, inputLine: null, cwd: '/tmp' })

    store().promptEnd(p, 7)
    expect(store().drafts[p]).toEqual({ promptLine: 4, inputLine: 7, cwd: '/tmp' })
    // No block committed until C.
    expect(store().byPane[p]).toBeUndefined()
  })

  it('replaces the draft when a second promptStart arrives before any commandStart', () => {
    const p = 'pane-overwrite'
    // A redrawn prompt (e.g. shell reprints after a resize) fires A again before C.
    store().promptStart(p, 10, '/a')
    store().promptStart(p, 20, '/b')
    // The newer A wholly replaces the draft — inputLine resets to null too.
    expect(store().drafts[p]).toEqual({ promptLine: 20, inputLine: null, cwd: '/b' })
    // Still nothing committed.
    expect(store().byPane[p]).toBeUndefined()
  })

  it('commandStart with no prior draft uses the fallback (promptLine=inputLine=line, cwd=null)', () => {
    const p = 'pane-fallback'
    store().commandStart(p, 5)

    const list = store().byPane[p]
    expect(list).toHaveLength(1)
    const block = list?.[0]
    expect(block).toMatchObject({
      promptLine: 5,
      inputLine: 5,
      outputStartLine: 5,
      endLine: null,
      exitCode: null,
      cwd: null,
    })
    // The block is running until its D arrives.
    expect(store().running[p]).toBe(block?.id)
    expect(store().drafts[p]).toBeUndefined()
  })

  it('recovers a lost OSC 133;D by closing the stale block when the next commandStart arrives', () => {
    const p = 'pane-stale'
    // Block 1: A + C, but its D never arrives.
    store().promptStart(p, 1, '/a')
    store().commandStart(p, 2)
    const block1 = store().byPane[p]?.[0]
    expect(block1?.endLine).toBeNull()
    expect(store().running[p]).toBe(block1?.id)

    // Block 2: A + C — the second C should close block 1 at its own start line (9).
    store().promptStart(p, 8, '/b')
    store().commandStart(p, 9)

    const list = store().byPane[p]
    expect(list).toHaveLength(2)
    const [closed, current] = list ?? []
    // Stale block 1 was closed at block 2's start line; the recovery also stamps
    // endedAt (not just endLine). exitCode stays null since no real D ever arrived.
    expect(closed.endLine).toBe(9)
    expect(typeof closed.endedAt).toBe('number')
    expect(closed.exitCode).toBeNull()
    // Block 2 is now the running one.
    expect(current.endLine).toBeNull()
    expect(store().running[p]).toBe(current.id)
    expect(current.id).not.toBe(closed.id)
  })

  // NOTE (defensive guard, intentionally untested): the `idx === -1` / `byPane ?? []`
  // branch in commandEnd (running set but the running block missing from byPane) is
  // UNREACHABLE through the public actions. `running[paneId]` is set only by commandStart,
  // atomically with byPane gaining that exact block as its last element (so slice(-200)
  // can't drop it), and is cleared only by commandEnd (which finds it) or resetPane (which
  // clears byPane + running together). So a truthy running id is always present in byPane.
  // The guard only fires under manual setState, which we don't exercise here.
  it('commandEnd is a no-op when nothing is running (fresh pane)', () => {
    const p = 'pane-noop-end'
    const before = store()
    store().commandEnd(p, 99, 0)
    const after = store()
    // Replace-semantics no-op: the returned state is the same reference.
    expect(after.byPane[p]).toBeUndefined()
    expect(after.running[p]).toBeUndefined()
    expect(after.byPane).toBe(before.byPane)
    expect(after.running).toBe(before.running)
  })

  it('promptEnd is a no-op when there is no draft', () => {
    const p = 'pane-noop-end-b'
    const before = store()
    store().promptEnd(p, 42)
    const after = store()
    expect(after.drafts[p]).toBeUndefined()
    expect(after.drafts).toBe(before.drafts)
  })

  it('caps a pane at MAX_BLOCKS_PER_PANE (200), dropping the oldest', () => {
    const p = 'pane-cap'
    // Drive 201 A/C cycles; each C commits one block. Distinct start lines so we can
    // prove the OLDEST (line 0) was dropped and the block window slid forward.
    for (let i = 0; i < 201; i++) {
      store().promptStart(p, i, `/d/${i}`)
      store().commandStart(p, i)
    }
    const list = store().byPane[p]
    expect(list).toHaveLength(200)
    // The first cycle (outputStartLine 0) was sliced off; the window now starts at 1.
    expect(list?.[0].outputStartLine).toBe(1)
    expect(list?.[list.length - 1].outputStartLine).toBe(200)
  })

  it('resetPane clears the pane and bumps its generation counter', () => {
    const p = 'pane-reset'
    const other = 'pane-other'
    // Seed both panes with a committed block so we can prove reset is scoped.
    store().promptStart(p, 1, '/a')
    store().commandStart(p, 2)
    store().promptStart(other, 3, '/b')
    store().commandStart(other, 4)
    expect(store().byPane[p]).toHaveLength(1)
    expect(store().gen[p]).toBeUndefined()

    store().resetPane(p)
    expect(store().byPane[p]).toEqual([])
    expect(store().drafts[p]).toBeUndefined()
    expect(store().running[p]).toBeUndefined()
    expect(store().gen[p]).toBe(1) // undefined → 1

    store().resetPane(p)
    expect(store().gen[p]).toBe(2) // 1 → 2

    // The other pane is untouched by either reset.
    expect(store().byPane[other]).toHaveLength(1)
    expect(store().running[other]).toBeDefined()
    expect(store().gen[other]).toBeUndefined()
  })

  it('keeps two panes isolated — a mutation to pane A leaves pane B intact', () => {
    const a = 'pane-a'
    const b = 'pane-b'
    // Pane B: a completed block.
    store().promptStart(b, 100, '/b')
    store().commandStart(b, 101)
    store().commandEnd(b, 110, 0)
    const bBlockId = store().byPane[b]?.[0]?.id
    const bListBefore = store().byPane[b]

    // Now churn pane A: a running block, then a reset.
    store().promptStart(a, 1, '/a')
    store().commandStart(a, 2)
    store().resetPane(a)

    // Pane B's list, block identity, running/draft/gen state are all unchanged.
    expect(store().byPane[b]).toBe(bListBefore)
    expect(store().byPane[b]).toHaveLength(1)
    expect(store().byPane[b]?.[0].id).toBe(bBlockId)
    expect(store().byPane[b]?.[0]).toMatchObject({ endLine: 110, exitCode: 0 })
    expect(store().running[b]).toBeUndefined()
    expect(store().gen[b]).toBeUndefined()
  })
})
