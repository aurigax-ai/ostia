import { describe, expect, it } from 'vitest'
import type { StreamEvent } from '../../shared/agents/agentStream'
import { FrameTooLarge, packFrames, splitEvent } from './streamFrames'

const MAX = 2000

type Payload = { paneId: string; seq: number; backfill?: true; events: StreamEvent[] }

function payloads(frames: string[]): Payload[] {
  return frames.map((frame) => JSON.parse(frame).params.payload)
}

function rejoin(events: StreamEvent[]): StreamEvent[] {
  const out: StreamEvent[] = []
  for (const event of events) {
    const prev = out.at(-1) as Record<string, unknown> | undefined
    const cur = event as unknown as Record<string, unknown>
    if ('append' in event && prev && prev.type === cur.type && prev.id === cur.id) {
      for (const key of ['text', 'input', 'output', 'diff', 'target']) {
        if (typeof cur[key] === 'string') prev[key] = `${prev[key] as string}${cur[key] as string}`
      }
      if (Array.isArray(cur.items)) prev.items = [...(prev.items as unknown[]), ...cur.items]
    } else out.push(structuredClone(event))
  }
  return out
}

describe('packFrames', () => {
  it('puts small events into one frame with the pane, seq and backfill flag', () => {
    const events: StreamEvent[] = [
      { type: 'turn.started', turn: 'u1' },
      { type: 'prompt', turn: 'u1', id: 'p', text: 'hi' },
    ]
    const frames = packFrames('pane-1', 7, true, events, MAX)
    expect(payloads(frames)).toEqual([{ paneId: 'pane-1', seq: 7, backfill: true, events }])
  })

  it('numbers frames in order and keeps each under the cap', () => {
    const events: StreamEvent[] = Array.from({ length: 60 }, (_, i) => ({
      type: 'text' as const,
      turn: 'u1',
      id: `t${i}`,
      text: 'x'.repeat(100),
    }))
    const frames = packFrames('pane-1', 1, false, events, MAX)
    expect(frames.length).toBeGreaterThan(1)
    for (const frame of frames) expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(MAX)
    expect(payloads(frames).map((p) => p.seq)).toEqual(frames.map((_, i) => i + 1))
    expect(payloads(frames).flatMap((p) => p.events)).toEqual(events)
  })

  it('splits one huge output across frames and loses none of it', () => {
    const output = `${'é€𝄞'.repeat(2000)}\n"quoted"\t${'\\'.repeat(500)}`
    const big: StreamEvent = {
      type: 'tool.result',
      turn: 'u1',
      id: 'tu1',
      output,
      exitCode: 3,
      isError: true,
    }
    const frames = packFrames('pane-1', 1, true, [big], MAX)
    expect(frames.length).toBeGreaterThan(3)
    for (const frame of frames) expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(MAX)
    const events = payloads(frames).flatMap((p) => p.events)
    expect(events[0]).toMatchObject({ exitCode: 3, isError: true })
    expect(
      events.slice(1).every((e) => 'append' in e && e.type === 'tool.result' && e.id === 'tu1'),
    ).toBe(true)
    expect(rejoin(events)).toEqual([big])
  })

  it('splits a diff and a prompt the same way', () => {
    const edit: StreamEvent = {
      type: 'edit',
      turn: 'u1',
      id: 'e1',
      path: 'a.ts',
      change: 'update',
      diff: '+line\n'.repeat(3000),
    }
    const prompt: StreamEvent = { type: 'prompt', turn: 'u1', id: 'p', text: 'word '.repeat(2000) }
    const events = payloads(packFrames('pane-1', 1, false, [edit, prompt], MAX)).flatMap(
      (p) => p.events,
    )
    expect(rejoin(events)).toEqual([edit, prompt])
  })

  it('splits a long plan between items', () => {
    const plan: StreamEvent = {
      type: 'plan',
      turn: 'u1',
      id: 'pl',
      items: Array.from({ length: 200 }, (_, i) => ({
        text: `step ${i} ${'y'.repeat(30)}`,
        status: 'pending' as const,
      })),
    }
    const frames = packFrames('pane-1', 1, false, [plan], MAX)
    for (const frame of frames) expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(MAX)
    expect(rejoin(payloads(frames).flatMap((p) => p.events))).toEqual([plan])
  })

  it('splitEvent leaves an event that fits whole', () => {
    const event: StreamEvent = { type: 'live' }
    expect(splitEvent(event, 100)).toEqual([event])
  })

  it('splits a tool call whose target is huge and has no other body', () => {
    const tool: StreamEvent = {
      type: 'tool',
      turn: 'u1',
      id: 'tu',
      kind: 'read',
      name: 'Read',
      target: 'p'.repeat(5000),
    }
    const frames = packFrames('pane-1', 1, false, [tool], MAX)
    for (const frame of frames) expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(MAX)
    expect(rejoin(payloads(frames).flatMap((p) => p.events))).toEqual([tool])
  })

  it('splits a tool call with both a huge target and a huge input', () => {
    const tool: StreamEvent = {
      type: 'tool',
      turn: 'u1',
      id: 'tu',
      kind: 'other',
      name: 'X',
      target: 'p'.repeat(5000),
      input: 'i'.repeat(7000),
    }
    const frames = packFrames('pane-1', 1, false, [tool], MAX)
    for (const frame of frames) expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(MAX)
    expect(rejoin(payloads(frames).flatMap((p) => p.events))).toEqual([tool])
  })

  it('refuses an event it cannot split, rather than send it over the cap', () => {
    const plan: StreamEvent = {
      type: 'plan',
      turn: 'u1',
      id: 'p',
      items: [{ text: 'x'.repeat(5000), status: 'pending' }],
    }
    expect(() => packFrames('pane-1', 1, false, [plan], MAX)).toThrow(FrameTooLarge)
  })

  it('splits a multi-megabyte output in linear time', () => {
    const output = 'a line of build output\n'.repeat(250_000)
    const started = performance.now()
    const frames = packFrames(
      'pane-1',
      1,
      true,
      [{ type: 'tool.result', turn: 'u1', id: 'tu', output }],
      1024 * 1024,
    )
    expect(performance.now() - started).toBeLessThan(3000)
    expect(frames.length).toBeGreaterThan(4)
    for (const frame of frames) expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(1024 * 1024)
  })
})
