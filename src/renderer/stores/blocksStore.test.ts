import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type LineAnchor, useBlocksStore } from './blocksStore'

const store = () => useBlocksStore.getState()
const at = (line: number): LineAnchor => ({ line })

describe('blocksStore', () => {
  let init: ReturnType<typeof useBlocksStore.getState>

  beforeAll(() => {
    init = useBlocksStore.getState()
  })

  afterEach(() => {
    useBlocksStore.setState(init, true)
  })

  it('runs the full A→B→C→D lifecycle into a single committed block', () => {
    const p = 'pane-1'
    store().promptStart(p, at(10), '/home')
    store().promptEnd(p, at(12))
    store().commandStart(p, at(13))
    const running = store().byPane[p]?.[0]
    expect(typeof running?.startedAt).toBe('number')
    expect(running?.endedAt).toBeNull()

    store().commandEnd(p, at(20), 0)

    const list = store().byPane[p]
    expect(list).toHaveLength(1)
    const block = list?.[0]
    expect(block).toMatchObject({
      paneId: p,
      promptLine: at(10),
      inputLine: at(12),
      outputStartLine: at(13),
      endLine: at(20),
      exitCode: 0,
      cwd: '/home',
    })
    expect(typeof block?.startedAt).toBe('number')
    expect(typeof block?.endedAt).toBe('number')
    expect(block?.endedAt as number).toBeGreaterThanOrEqual(block?.startedAt as number)
    expect(store().running[p]).toBeUndefined()
    expect(store().drafts[p]).toBeUndefined()
  })

  it('sets the draft on promptStart and fills inputLine on promptEnd', () => {
    const p = 'pane-draft'
    store().promptStart(p, at(4), '/tmp')
    expect(store().drafts[p]).toEqual({
      promptLine: at(4),
      inputLine: null,
      cwd: '/tmp',
      remote: false,
    })

    store().promptEnd(p, at(7))
    expect(store().drafts[p]).toEqual({
      promptLine: at(4),
      inputLine: at(7),
      cwd: '/tmp',
      remote: false,
    })
    expect(store().byPane[p]).toBeUndefined()
  })

  it('replaces the draft when a second promptStart arrives before any commandStart', () => {
    const p = 'pane-overwrite'
    store().promptStart(p, at(10), '/a')
    store().promptStart(p, at(20), '/b')
    expect(store().drafts[p]).toEqual({
      promptLine: at(20),
      inputLine: null,
      cwd: '/b',
      remote: false,
    })
    expect(store().byPane[p]).toBeUndefined()
  })

  it('commandStart with no prior draft uses the fallback (promptLine=inputLine=line, cwd=null)', () => {
    const p = 'pane-fallback'
    store().commandStart(p, at(5))

    const list = store().byPane[p]
    expect(list).toHaveLength(1)
    const block = list?.[0]
    expect(block).toMatchObject({
      promptLine: at(5),
      inputLine: at(5),
      outputStartLine: at(5),
      endLine: null,
      exitCode: null,
      cwd: null,
    })
    expect(store().running[p]).toBe(block?.id)
    expect(store().drafts[p]).toBeUndefined()
  })

  it('recovers a lost OSC 133;D by closing the stale block when the next commandStart arrives', () => {
    const p = 'pane-stale'
    store().promptStart(p, at(1), '/a')
    store().commandStart(p, at(2))
    const block1 = store().byPane[p]?.[0]
    expect(block1?.endLine).toBeNull()
    expect(store().running[p]).toBe(block1?.id)

    store().promptStart(p, at(8), '/b')
    store().commandStart(p, at(9))

    const list = store().byPane[p]
    expect(list).toHaveLength(2)
    const [closed, current] = list ?? []
    expect(closed.endLine).toEqual(at(9))
    expect(typeof closed.endedAt).toBe('number')
    expect(closed.exitCode).toBeNull()
    expect(current.endLine).toBeNull()
    expect(store().running[p]).toBe(current.id)
    expect(current.id).not.toBe(closed.id)
  })

  it('replaces the block command when the shell reports the whole command at its end', () => {
    const p = 'pane-whole'
    store().promptStart(p, at(1), '/home')
    store().commandStart(p, at(2), 'echo pine_ml_1')

    store().commandEnd(p, at(5), 0, 0, 'echo pine_ml_1\necho pine_ml_2')

    expect(store().byPane[p]?.[0]).toMatchObject({
      command: 'echo pine_ml_1\necho pine_ml_2',
      endLine: at(5),
      exitCode: 0,
    })
  })

  it('ignores a whole command that does not continue the one read at its start', () => {
    const p = 'pane-forged'
    store().promptStart(p, at(1), '/home')
    store().commandStart(p, at(2), 'cat notes.txt')

    store().commandEnd(p, at(5), 0, 0, 'rm -rf ~\necho gone')

    expect(store().byPane[p]?.[0]?.command).toBe('cat notes.txt')
  })

  it('keeps the command read at its start when the end reports none', () => {
    const p = 'pane-kept'
    store().promptStart(p, at(1), '/home')
    store().commandStart(p, at(2), 'ls -la')

    store().commandEnd(p, at(5), 0)

    expect(store().byPane[p]?.[0]?.command).toBe('ls -la')
  })

  it('commandEnd is a no-op when nothing is running (fresh pane)', () => {
    const p = 'pane-noop-end'
    const before = store()
    store().commandEnd(p, at(99), 0)
    const after = store()
    expect(after.byPane[p]).toBeUndefined()
    expect(after.running[p]).toBeUndefined()
    expect(after.byPane).toBe(before.byPane)
    expect(after.running).toBe(before.running)
  })

  it('promptEnd is a no-op when there is no draft', () => {
    const p = 'pane-noop-end-b'
    const before = store()
    store().promptEnd(p, at(42))
    const after = store()
    expect(after.drafts[p]).toBeUndefined()
    expect(after.drafts).toBe(before.drafts)
  })

  it('caps a pane at MAX_BLOCKS_PER_PANE (200), dropping the oldest', () => {
    const p = 'pane-cap'
    for (let i = 0; i < 201; i++) {
      store().promptStart(p, at(i), `/d/${i}`)
      store().commandStart(p, at(i))
    }
    const list = store().byPane[p]
    expect(list).toHaveLength(200)
    expect(list?.[0].outputStartLine).toEqual(at(1))
    expect(list?.[list.length - 1].outputStartLine).toEqual(at(200))
  })

  it('resetPane clears the pane and bumps its generation counter', () => {
    const p = 'pane-reset'
    const other = 'pane-other'
    store().promptStart(p, at(1), '/a')
    store().commandStart(p, at(2))
    store().promptStart(other, at(3), '/b')
    store().commandStart(other, at(4))
    expect(store().byPane[p]).toHaveLength(1)
    expect(store().gen[p]).toBeUndefined()

    store().resetPane(p)
    expect(store().byPane[p]).toEqual([])
    expect(store().drafts[p]).toBeUndefined()
    expect(store().running[p]).toBeUndefined()
    expect(store().gen[p]).toBe(1)

    store().resetPane(p)
    expect(store().gen[p]).toBe(2)

    expect(store().byPane[other]).toHaveLength(1)
    expect(store().running[other]).toBeDefined()
    expect(store().gen[other]).toBeUndefined()
  })

  it('keeps two panes isolated — a mutation to pane A leaves pane B intact', () => {
    const a = 'pane-a'
    const b = 'pane-b'
    store().promptStart(b, at(100), '/b')
    store().commandStart(b, at(101))
    store().commandEnd(b, at(110), 0)
    const bBlockId = store().byPane[b]?.[0]?.id
    const bListBefore = store().byPane[b]

    store().promptStart(a, at(1), '/a')
    store().commandStart(a, at(2))
    store().resetPane(a)

    expect(store().byPane[b]).toBe(bListBefore)
    expect(store().byPane[b]).toHaveLength(1)
    expect(store().byPane[b]?.[0].id).toBe(bBlockId)
    expect(store().byPane[b]?.[0]).toMatchObject({ endLine: at(110), exitCode: 0 })
    expect(store().running[b]).toBeUndefined()
    expect(store().gen[b]).toBeUndefined()
  })

  it('dropPane removes every record for a closed pane and leaves others intact', () => {
    store().promptStart('gone', at(1), '/a')
    store().commandStart('gone', at(2))
    store().resetPane('gone')
    store().promptStart('gone', at(3), '/a')
    store().commandStart('gone', at(4))
    store().promptStart('kept', at(5), '/b')
    store().commandStart('kept', at(6))

    store().dropPane('gone')

    const s = store()
    expect('gone' in s.byPane).toBe(false)
    expect('gone' in s.drafts).toBe(false)
    expect('gone' in s.running).toBe(false)
    expect('gone' in s.gen).toBe(false)
    expect(s.byPane.kept).toHaveLength(1)
    expect(s.running.kept).toBeDefined()
  })

  it('dropPane is a no-op for a pane the store never saw', () => {
    const before = store()
    store().dropPane('never')
    expect(store()).toBe(before)
  })

  it('reads block positions live from the anchors so they follow reflow and trimming', () => {
    const start = { line: 40 }
    const end = { line: 45 }
    store().promptStart('live', at(39), null)
    store().commandStart('live', start)
    store().commandEnd('live', end, 0)
    start.line = 12
    end.line = -1
    const block = store().byPane.live?.[0]
    expect(block?.outputStartLine.line).toBe(12)
    expect(block?.endLine?.line).toBe(-1)
  })

  it('keeps the command text and the column where output ended', () => {
    store().promptStart('cmd', at(0), '/w')
    store().commandStart('cmd', at(1), 'printf abc')
    store().commandEnd('cmd', at(1), 0, 3)
    const block = store().byPane.cmd?.[0]
    expect(block?.command).toBe('printf abc')
    expect(block?.endCol).toBe(3)
  })

  it('selects a known block, clears with null, and ignores unknown ids', () => {
    store().commandStart('sel', at(1), 'ls')
    const id = store().byPane.sel?.[0]?.id ?? ''
    store().select('sel', id)
    expect(store().selected.sel).toBe(id)

    const before = store()
    store().select('sel', 'bogus')
    expect(store()).toBe(before)

    store().select('sel', null)
    expect(store().selected.sel).toBeUndefined()
  })

  it('drops the selection on reset, on drop, and when the block ages out', () => {
    store().commandStart('r', at(1), 'ls')
    store().select('r', store().byPane.r?.[0]?.id ?? null)
    store().resetPane('r')
    expect(store().selected.r).toBeUndefined()

    store().commandStart('d', at(1), 'ls')
    store().select('d', store().byPane.d?.[0]?.id ?? null)
    store().dropPane('d')
    expect('d' in store().selected).toBe(false)

    store().commandStart('t', at(0), 'first')
    store().select('t', store().byPane.t?.[0]?.id ?? null)
    for (let i = 1; i <= 200; i++) store().commandStart('t', at(i), `cmd ${i}`)
    expect(store().selected.t).toBeUndefined()
  })
})
