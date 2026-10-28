import { describe, expect, it, vi } from 'vitest'
import type { AgentSessions } from '../agent/agentSessions'
import { PiStream } from '../agent/piStream'
import { createSessionAttacher } from './managerSession'

function rig() {
  const stream = new PiStream()
  const waiting = new Set<(on: boolean) => void>()
  const ends = new Set<(paneId: string) => void>()
  const prompted: string[] = []
  const sessions = {
    sessionOfPane: (paneId: string) => (paneId === 'pane-1' ? 's1' : undefined),
    stream: () => stream,
    watchWaiting: (_id: string, listener: (on: boolean) => void) => {
      waiting.add(listener)
      return () => waiting.delete(listener)
    },
    promptFromPortal: async (_id: string, text: string) => {
      prompted.push(text)
      return { ok: true as const }
    },
  } as unknown as AgentSessions
  const manager = {
    onEnd: (listener: (paneId: string) => void) => {
      ends.add(listener)
      return () => ends.delete(listener)
    },
  }
  const attach = createSessionAttacher({ sessions: () => sessions, manager: () => manager })
  return { attach, stream, waiting, ends, prompted }
}

describe('createSessionAttacher', () => {
  it('forwards stream events, waiting changes and the end of the manager pane', () => {
    const { attach, stream, waiting, ends } = rig()
    const sink = { events: vi.fn(), waiting: vi.fn(), ended: vi.fn() }
    expect(attach('pane-1', sink)).not.toBeNull()
    stream.prompt('hi')
    expect(sink.events).toHaveBeenCalled()
    for (const listener of waiting) listener(true)
    expect(sink.waiting).toHaveBeenCalledWith(true)
    for (const listener of ends) listener('other-pane')
    expect(sink.ended).not.toHaveBeenCalled()
    for (const listener of ends) listener('pane-1')
    expect(sink.ended).toHaveBeenCalledTimes(1)
  })

  it('detach only stops listening: the stream and the session stay', async () => {
    const { attach, stream, waiting, ends, prompted } = rig()
    const sink = { events: vi.fn(), waiting: vi.fn(), ended: vi.fn() }
    const handle = attach('pane-1', sink)
    handle?.detach()
    expect(waiting.size).toBe(0)
    expect(ends.size).toBe(0)
    stream.prompt('after detach')
    expect(sink.events).not.toHaveBeenCalled()
    expect(stream.busy).toBe(true)
    expect(prompted).toEqual([])
  })

  it('prompts the session and answers null for a pane with no session', async () => {
    const { attach, prompted } = rig()
    const sink = { events: vi.fn(), waiting: vi.fn(), ended: vi.fn() }
    expect(attach('pane-9', sink)).toBeNull()
    const handle = attach('pane-1', sink)
    expect(await handle?.prompt('go')).toEqual({ ok: true })
    expect(prompted).toEqual(['go'])
  })
})
