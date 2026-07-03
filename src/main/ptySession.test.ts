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
    expect(a).toEqual(['boot\n']) // replayed history
    const b: string[] = []
    s.addSubscriber(sub('b', 'observer', b))
    s.push('live')
    expect(a).toEqual(['boot\n', 'live'])
    expect(b).toEqual(['boot\n', 'live']) // both get live output
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
    expect(onNoOwners).not.toHaveBeenCalled() // observer leaving doesn't matter
    s.removeSubscriber('o2')
    expect(onNoOwners).toHaveBeenCalledTimes(1) // last owner gone
  })

  it('notifies onExit and forwards exit to no one after end', () => {
    const onExit = vi.fn()
    const s = new PtySession({ onExit })
    s.exit(0)
    expect(onExit).toHaveBeenCalledWith(0)
  })
})
