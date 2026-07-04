import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DropZone } from '../layout/tree'
import { usePaneDnd } from './paneDndStore'

/**
 * paneDndStore holds the transient pane drag-and-drop state: `overId` (the pane the
 * drag is hovering) and `zone` (which edge/center the dragged pane would land on).
 * It has exactly two actions — `setOver(overId, zone)` sets both, `reset()` clears both
 * back to idle. No window.pine, no cross-store deps, so nothing to mock here.
 */

const get = () => usePaneDnd.getState()

describe('paneDndStore', () => {
  let init: ReturnType<typeof usePaneDnd.getState>

  beforeAll(() => {
    // Snapshot pristine state (data + stable action fns) before any test mutates.
    init = usePaneDnd.getState()
  })

  afterEach(() => {
    // Restore to pristine (replace, not merge) so drag state never bleeds across tests.
    usePaneDnd.setState(init, true)
  })

  it('starts idle with no hovered pane and no zone', () => {
    expect(get().overId).toBeNull()
    expect(get().zone).toBeNull()
  })

  it('setOver records the hovered pane id and drop zone together', () => {
    get().setOver('pane-1', 'left')
    expect(get().overId).toBe('pane-1')
    expect(get().zone).toBe('left')
  })

  it('setOver overwrites a previously hovered pane and zone', () => {
    get().setOver('pane-1', 'left')
    get().setOver('pane-2', 'bottom')
    expect(get().overId).toBe('pane-2')
    expect(get().zone).toBe('bottom')
  })

  it('setOver keeps the pane id but updates the zone when only the zone changes', () => {
    get().setOver('pane-1', 'top')
    get().setOver('pane-1', 'right')
    expect(get().overId).toBe('pane-1')
    expect(get().zone).toBe('right')
  })

  it.each<DropZone>(['left', 'right', 'top', 'bottom', 'center'])(
    'setOver accepts the %s drop zone',
    (zone) => {
      get().setOver('pane-x', zone)
      expect(get().zone).toBe(zone)
    },
  )

  it('reset clears an active drag back to idle', () => {
    get().setOver('pane-1', 'center')
    get().reset()
    expect(get().overId).toBeNull()
    expect(get().zone).toBeNull()
  })

  it('reset from an already-idle state stays idle', () => {
    get().reset()
    expect(get().overId).toBeNull()
    expect(get().zone).toBeNull()
  })
})
