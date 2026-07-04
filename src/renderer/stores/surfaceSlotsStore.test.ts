import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useSurfaceSlots } from './surfaceSlotsStore'

/**
 * surfaceSlotsStore backs the <SurfacePool>: it maps a pane id to the live DOM element
 * ("slot") that the pane's pooled surface (xterm/Monaco) portals its content into. The
 * whole point is stability — re-registering the *same* element for a pane is a no-op that
 * preserves referential identity, so subscribers don't re-render and the surface DOM is
 * never re-parented/remounted (the cmux mount-once rule that stops the split "staircase").
 *
 * The contract is tiny: `slots: Record<string, HTMLElement | null>` plus one action
 * `setSlot(paneId, el)`. There is NO slot allocator / ordering / capacity here — the caller
 * supplies the element; the store only records it. No window.pine or cross-store deps.
 */

const get = () => useSurfaceSlots.getState()
const div = () => document.createElement('div')

describe('surfaceSlotsStore', () => {
  let init: ReturnType<typeof useSurfaceSlots.getState>

  beforeAll(() => {
    // Snapshot pristine state (empty slots + stable action fn) before any test mutates.
    init = useSurfaceSlots.getState()
  })

  afterEach(() => {
    // Restore to pristine (replace, not merge) so registered slots never bleed across tests.
    useSurfaceSlots.setState(init, true)
  })

  it('starts with no slots registered', () => {
    expect(get().slots).toEqual({})
  })

  it('setSlot registers a pane surface element under its pane id', () => {
    const el = div()
    get().setSlot('pane-1', el)
    expect(get().slots['pane-1']).toBe(el)
  })

  it('returns the same element on repeat reads for a pane (stable slot)', () => {
    const el = div()
    get().setSlot('pane-1', el)
    const first = get().slots['pane-1']
    const second = get().slots['pane-1']
    expect(first).toBe(el)
    expect(second).toBe(el)
  })

  it('keeps distinct elements for different panes', () => {
    const a = div()
    const b = div()
    get().setSlot('pane-a', a)
    get().setSlot('pane-b', b)
    expect(get().slots['pane-a']).toBe(a)
    expect(get().slots['pane-b']).toBe(b)
    expect(get().slots['pane-a']).not.toBe(get().slots['pane-b'])
  })

  it('re-registering the identical element for a pane is a no-op (preserves state + slots identity)', () => {
    const el = div()
    get().setSlot('pane-1', el)
    const stateBefore = get()
    const slotsBefore = get().slots
    // Same element again → guarded no-op: the updater returns the current state unchanged.
    get().setSlot('pane-1', el)
    expect(get()).toBe(stateBefore)
    expect(get().slots).toBe(slotsBefore)
    expect(get().slots['pane-1']).toBe(el)
  })

  it('registering a different element for a pane replaces it and creates a new slots object', () => {
    const first = div()
    const second = div()
    get().setSlot('pane-1', first)
    const slotsBefore = get().slots
    get().setSlot('pane-1', second)
    expect(get().slots).not.toBe(slotsBefore)
    expect(get().slots['pane-1']).toBe(second)
  })

  it('registering a slot for one pane does not disturb another pane slot', () => {
    const a = div()
    const b = div()
    const b2 = div()
    get().setSlot('pane-a', a)
    get().setSlot('pane-b', b)
    get().setSlot('pane-b', b2)
    expect(get().slots['pane-a']).toBe(a)
    expect(get().slots['pane-b']).toBe(b2)
  })

  it('setSlot(paneId, null) releases the slot by nulling it while keeping the key', () => {
    const el = div()
    get().setSlot('pane-1', el)
    get().setSlot('pane-1', null)
    // Release nulls the value — it does NOT delete the key from the record.
    expect(get().slots['pane-1']).toBeNull()
    expect('pane-1' in get().slots).toBe(true)
  })

  it('nulling an already-null slot is a no-op (preserves slots identity)', () => {
    get().setSlot('pane-1', null)
    const slotsBefore = get().slots
    get().setSlot('pane-1', null)
    expect(get().slots).toBe(slotsBefore)
    expect(get().slots['pane-1']).toBeNull()
  })

  it('nulling an unknown pane adds a null entry (undefined is not identical to null)', () => {
    const slotsBefore = get().slots
    get().setSlot('never-registered', null)
    // `s.slots[paneId]` is undefined, `el` is null → not identical → a new entry is written.
    expect(get().slots).not.toBe(slotsBefore)
    expect(get().slots['never-registered']).toBeNull()
    expect('never-registered' in get().slots).toBe(true)
  })
})
