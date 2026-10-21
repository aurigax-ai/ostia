import { describe, expect, it } from 'vitest'
import { WaitingSince } from './waitingSince'

function rig() {
  let clock = 1000
  const workspaces = new Map<string, string>([
    ['p1', 'ws-a'],
    ['p2', 'ws-a'],
    ['p3', 'ws-b'],
  ])
  const waiting = new WaitingSince({ now: () => clock, workspaceOf: (id) => workspaces.get(id) })
  return {
    waiting,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

describe('waitingSince', () => {
  it('PSH-C45 stays constant while a pane keeps waiting and changes on the next wait', () => {
    const { waiting, tick } = rig()
    waiting.change('p1', 'waiting')
    expect(waiting.ofPane('p1')).toBe(1000)
    tick(5000)
    waiting.change('p1', 'waiting')
    expect(waiting.ofPane('p1')).toBe(1000)
    waiting.change('p1', 'working')
    expect(waiting.ofPane('p1')).toBeUndefined()
    tick(5000)
    waiting.change('p1', 'waiting')
    expect(waiting.ofPane('p1')).toBe(11_000)
  })

  it('PSH-C46 clears when the attention is cleared or the pane closes', () => {
    const { waiting } = rig()
    waiting.change('p1', 'waiting')
    waiting.change('p1', undefined)
    expect(waiting.ofPane('p1')).toBeUndefined()
    waiting.change('p1', 'waiting')
    waiting.forget('p1')
    expect(waiting.ofPane('p1')).toBeUndefined()
  })

  it('PSH-C47 gives a workspace the newest wait among its panes', () => {
    const { waiting, tick } = rig()
    waiting.change('p1', 'waiting')
    tick(2000)
    waiting.change('p2', 'waiting')
    tick(2000)
    waiting.change('p3', 'waiting')
    expect(waiting.ofWorkspace('ws-a')).toBe(3000)
    waiting.change('p2', 'done')
    expect(waiting.ofWorkspace('ws-a')).toBe(1000)
    expect(waiting.ofWorkspace('ws-none')).toBeUndefined()
  })
})
