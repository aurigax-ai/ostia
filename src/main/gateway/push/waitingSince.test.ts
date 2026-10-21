import { describe, expect, it } from 'vitest'
import { PaneWatch } from '../../panes/paneWait'
import { WaitingSince } from './waitingSince'

function rig() {
  let clock = 1000
  const workspaces = new Map<string, string>([
    ['p1', 'ws-a'],
    ['p2', 'ws-a'],
    ['p3', 'ws-b'],
  ])
  const waiting = new WaitingSince({ now: () => clock, workspaceOf: (id) => workspaces.get(id) })
  const watch = new PaneWatch()
  watch.tap((paneId, change) => waiting.observe(paneId, change))
  return {
    waiting,
    watch,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

describe('waitingSince', () => {
  it('PSH-C45 stays constant while a pane keeps waiting and changes on the next wait', () => {
    const { waiting, watch, tick } = rig()
    watch.attention('p1', 'waiting', 'first message')
    expect(waiting.ofPane('p1')).toBe(1000)
    tick(5000)
    watch.attention('p1', 'waiting', 'a new message while still waiting')
    expect(waiting.ofPane('p1')).toBe(1000)
    watch.attention('p1', 'working', undefined)
    expect(waiting.ofPane('p1')).toBeUndefined()
    tick(5000)
    watch.attention('p1', 'waiting', undefined)
    expect(waiting.ofPane('p1')).toBe(11_000)
  })

  it('PSH-C46 clears when the agent stops waiting or the pane closes', () => {
    const { waiting, watch } = rig()
    for (const state of ['none', 'done', 'error']) {
      watch.attention('p1', 'waiting', undefined)
      watch.attention('p1', state, undefined)
      expect(waiting.ofPane('p1'), state).toBeUndefined()
    }
    watch.attention('p1', 'waiting', undefined)
    watch.emit('p1', { kind: 'closed' })
    expect(waiting.ofPane('p1')).toBeUndefined()
  })

  it('PSH-C47 gives a workspace the newest wait among its panes', () => {
    const { waiting, watch, tick } = rig()
    watch.attention('p1', 'waiting', undefined)
    tick(2000)
    watch.attention('p2', 'waiting', undefined)
    tick(2000)
    watch.attention('p3', 'waiting', undefined)
    expect(waiting.ofWorkspace('ws-a')).toBe(3000)
    watch.attention('p2', 'done', undefined)
    expect(waiting.ofWorkspace('ws-a')).toBe(1000)
    expect(waiting.ofWorkspace('ws-none')).toBeUndefined()
  })

  it('PSH-C62 keeps the wait when the pane is only viewed or its terminal state changes', () => {
    const { waiting, watch, tick } = rig()
    watch.attention('p1', 'waiting', undefined)
    tick(9000)
    watch.emit('p1', { kind: 'state' })
    expect(waiting.ofPane('p1')).toBe(1000)
    expect(waiting.any()).toBe(true)
  })
})
