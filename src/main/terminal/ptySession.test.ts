import { describe, expect, it, vi } from 'vitest'
import { PtySession } from './ptySession'

const sub = (id: string, role: 'owner' | 'observer', sink: string[]) => ({
  id,
  role,
  send: (d: string) => sink.push(d),
})

describe('PtySession', () => {
  it('replays history to a new subscriber and fans out live output', () => {
    const s = new PtySession()
    s.push('boot\n')
    const a: string[] = []
    const res = s.addSubscriber(sub('a', 'owner', a))
    expect(res.dropped).toBe(false)
    expect(a).toEqual(['boot\n'])
    const b: string[] = []
    s.addSubscriber(sub('b', 'observer', b))
    s.push('live')
    expect(a).toEqual(['boot\n', 'live'])
    expect(b).toEqual(['boot\n', 'live'])
  })

  it('only owners may write; observers may not', () => {
    const s = new PtySession()
    s.addSubscriber(sub('o', 'owner', []))
    s.addSubscriber(sub('v', 'observer', []))
    expect(s.canWrite('o')).toBe(true)
    expect(s.canWrite('v')).toBe(false)
  })

  it('fires onNoOwners only when the LAST owner leaves (observers do not hold it open)', () => {
    const onNoOwners = vi.fn()
    const s = new PtySession({ onNoOwners })
    s.addSubscriber(sub('o1', 'owner', []))
    s.addSubscriber(sub('o2', 'owner', []))
    s.addSubscriber(sub('v', 'observer', []))
    s.removeSubscriber('o1')
    expect(onNoOwners).not.toHaveBeenCalled()
    s.removeSubscriber('v')
    expect(onNoOwners).not.toHaveBeenCalled()
    s.removeSubscriber('o2')
    expect(onNoOwners).toHaveBeenCalledTimes(1)
  })

  it('notifies onExit and forwards exit to no one after end', () => {
    const onExit = vi.fn()
    const s = new PtySession({ onExit })
    s.exit(0)
    expect(onExit).toHaveBeenCalledWith(0)
  })

  it('since(0) returns buffered data as a string without invoking any subscriber send', () => {
    const s = new PtySession()
    s.push('boot\n')
    const sink: string[] = []
    s.addSubscriber(sub('a', 'owner', sink))
    sink.length = 0
    const result = s.since(0)
    expect(result.data).toBe('boot\n')
    expect(result.dropped).toBe(false)
    expect(sink).toEqual([])
  })

  it('addLiveSubscriber receives future pushes but not past history', () => {
    const s = new PtySession()
    s.push('old')
    const sink: string[] = []
    s.addLiveSubscriber(sub('a', 'owner', sink))
    expect(sink).toEqual([])
    s.push('new')
    expect(sink).toEqual(['new'])
  })
})

describe('PtySession subscriber lifecycle', () => {
  it('closes a subscriber when it is removed or replaced by a re-attach with the same id', () => {
    const s = new PtySession()
    const closed: string[] = []
    const first = { ...sub('w', 'owner', []), close: () => closed.push('first') }
    const second = { ...sub('w', 'owner', []), close: () => closed.push('second') }
    s.addLiveSubscriber(first)
    s.addLiveSubscriber(second)
    expect(closed).toEqual(['first'])
    s.removeSubscriber('w')
    expect(closed).toEqual(['first', 'second'])
  })

  it('flushes every subscriber before reporting the exit', () => {
    const order: string[] = []
    const s = new PtySession({ onExit: () => order.push('exit') })
    s.addLiveSubscriber({ ...sub('w', 'owner', []), flush: () => order.push('flush') })
    s.exit(0)
    expect(order).toEqual(['flush', 'exit'])
  })
})
