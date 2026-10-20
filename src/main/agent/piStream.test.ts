import { describe, expect, it } from 'vitest'
import { PiStream } from './piStream'

describe('PiStream', () => {
  it('records a prompt, streamed text, a tool call with its result and the turn end', () => {
    const stream = new PiStream()
    const live: unknown[] = []
    stream.subscribe((events) => live.push(...events))
    stream.prompt('open the file')
    stream.event({ type: 'text-delta', text: 'Opening ' })
    stream.event({ type: 'text-delta', text: 'it.' })
    stream.event({
      type: 'tool-call',
      toolCallId: 'c1',
      name: 'open_file',
      input: { path: 'src/a.ts' },
    })
    stream.toolResult('c1', 'opened', false)
    stream.event({ type: 'tool-done', toolCallId: 'c1', isError: false })
    stream.event({ type: 'turn-end' })
    expect(live).toEqual([
      { type: 'turn.started', turn: 't1' },
      { type: 'prompt', turn: 't1', id: 'x1', text: 'open the file' },
      { type: 'text', turn: 't1', id: 'x2', text: 'Opening ' },
      { type: 'text', turn: 't1', id: 'x2', text: 'it.', append: true },
      { type: 'tool', turn: 't1', id: 'c1', kind: 'read', name: 'open_file', target: 'src/a.ts' },
      { type: 'tool.result', turn: 't1', id: 'c1', output: 'opened' },
      { type: 'turn.ended', turn: 't1', status: 'done' },
    ])
  })

  it('gives a tool that finished without a result an empty one with its error flag', () => {
    const stream = new PiStream()
    stream.prompt('x')
    stream.event({ type: 'tool-call', toolCallId: 'c1', name: 'weird', input: { a: 1 } })
    stream.event({ type: 'tool-done', toolCallId: 'c1', isError: true })
    expect(stream.snapshot(5).slice(-2)).toEqual([
      { type: 'tool', turn: 't1', id: 'c1', kind: 'other', name: 'weird', input: '{"a":1}' },
      { type: 'tool.result', turn: 't1', id: 'c1', output: '', isError: true },
    ])
  })

  it('seeds earlier history as finished turns and hands the last n turns to a late reader', () => {
    const stream = new PiStream()
    stream.seed([
      { role: 'user', text: 'one' },
      { role: 'assistant', text: 'first' },
      { role: 'user', text: 'two' },
      { role: 'assistant', text: 'second' },
    ])
    stream.prompt('three')
    const last = stream.snapshot(2)
    expect(
      last.filter((e) => e.type === 'prompt').map((e) => (e as { text: string }).text),
    ).toEqual(['two', 'three'])
    expect(last.some((e) => e.type === 'turn.ended' && e.turn === 't2')).toBe(true)
  })

  it('stops delivering after unsubscribe and ends a failed turn on error', () => {
    const stream = new PiStream()
    const live: unknown[] = []
    const off = stream.subscribe((events) => live.push(...events))
    stream.prompt('x')
    stream.event({ type: 'error', message: 'rate limited' })
    expect(live.at(-1)).toEqual({ type: 'turn.ended', turn: 't1', status: 'failed' })
    off()
    stream.prompt('y')
    expect(live).toHaveLength(3)
  })
})
