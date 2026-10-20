import { describe, expect, it } from 'vitest'
import { codexNotification, codexTurn } from './codexStream'

const item = (over: Record<string, unknown>) => ({ id: 'i1', ...over })
const completed = (it: Record<string, unknown>) =>
  codexNotification('item/completed', { threadId: 't', turnId: 'u1', item: it })

describe('codexNotification', () => {
  it('maps turn start and end', () => {
    expect(codexNotification('turn/started', { threadId: 't', turn: { id: 'u1' } })).toEqual([
      { type: 'turn.started', turn: 'u1' },
    ])
    expect(
      codexNotification('turn/completed', {
        threadId: 't',
        turn: { id: 'u1', status: 'interrupted' },
      }),
    ).toEqual([{ type: 'turn.ended', turn: 'u1', status: 'interrupted' }])
  })

  it('maps a user message to the prompt and an agent message to text', () => {
    expect(
      completed(
        item({
          type: 'userMessage',
          content: [{ type: 'text', text: 'fix it', text_elements: [] }],
        }),
      ),
    ).toEqual([{ type: 'prompt', turn: 'u1', id: 'i1', text: 'fix it' }])
    expect(completed(item({ type: 'agentMessage', text: 'Done.' }))).toEqual([
      { type: 'text', turn: 'u1', id: 'i1', text: 'Done.' },
    ])
  })

  it('maps a message delta to appended text', () => {
    expect(
      codexNotification('item/agentMessage/delta', {
        threadId: 't',
        turnId: 'u1',
        itemId: 'i1',
        delta: 'Hel',
      }),
    ).toEqual([{ type: 'text', turn: 'u1', id: 'i1', text: 'Hel', append: true }])
  })

  it('maps a command to a tool call, streamed output and a result with its exit code', () => {
    const cmd = item({ type: 'commandExecution', command: 'pnpm test', status: 'inProgress' })
    expect(codexNotification('item/started', { threadId: 't', turnId: 'u1', item: cmd })).toEqual([
      { type: 'tool', turn: 'u1', id: 'i1', kind: 'command', name: 'shell', input: 'pnpm test' },
    ])
    expect(
      codexNotification('item/commandExecution/outputDelta', {
        threadId: 't',
        turnId: 'u1',
        itemId: 'i1',
        delta: '61 passed',
      }),
    ).toEqual([{ type: 'tool.result', turn: 'u1', id: 'i1', output: '61 passed', append: true }])
    expect(
      completed({ ...cmd, status: 'completed', aggregatedOutput: '61 passed', exitCode: 0 }).at(-1),
    ).toEqual({ type: 'tool.result', turn: 'u1', id: 'i1', output: '61 passed', exitCode: 0 })
    expect(
      completed({ ...cmd, status: 'failed', aggregatedOutput: 'x', exitCode: 2 }).at(-1),
    ).toMatchObject({ exitCode: 2, isError: true })
  })

  it('maps a file change to one edit per file with its unified diff', () => {
    const events = completed(
      item({
        type: 'fileChange',
        status: 'completed',
        changes: [
          { path: 'a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b' },
          { path: 'b.ts', kind: { type: 'add' }, diff: '+x' },
        ],
      }),
    )
    expect(events.filter((e) => e.type === 'edit')).toEqual([
      {
        type: 'edit',
        turn: 'u1',
        id: 'i1:0',
        path: 'a.ts',
        change: 'update',
        diff: '@@ -1 +1 @@\n-a\n+b',
      },
      { type: 'edit', turn: 'u1', id: 'i1:1', path: 'b.ts', change: 'add', diff: '+x' },
    ])
  })

  it('sends no edit for a declined patch', () => {
    const events = completed(
      item({
        type: 'fileChange',
        status: 'declined',
        changes: [{ path: 'a.ts', kind: { type: 'add' }, diff: '+x' }],
      }),
    )
    expect(events.some((e) => e.type === 'edit')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'tool.result', isError: true })
  })

  it('maps plan updates with their statuses', () => {
    expect(
      codexNotification('turn/plan/updated', {
        threadId: 't',
        turnId: 'u1',
        explanation: null,
        plan: [
          { step: 'Guard', status: 'completed' },
          { step: 'Push', status: 'inProgress' },
          { step: 'Note', status: 'pending' },
        ],
      }),
    ).toEqual([
      {
        type: 'plan',
        turn: 'u1',
        id: 'plan:u1',
        items: [
          { text: 'Guard', status: 'done' },
          { text: 'Push', status: 'active' },
          { text: 'Note', status: 'pending' },
        ],
      },
    ])
  })

  it('maps an mcp tool call and its error result', () => {
    const call = item({
      type: 'mcpToolCall',
      server: 'jira',
      tool: 'search',
      arguments: { q: 'x' },
      status: 'failed',
      result: null,
      error: { message: 'denied' },
    })
    expect(completed(call)).toEqual([
      {
        type: 'tool',
        turn: 'u1',
        id: 'i1',
        kind: 'other',
        name: 'jira/search',
        input: '{"q":"x"}',
      },
      { type: 'tool.result', turn: 'u1', id: 'i1', output: 'denied', isError: true },
    ])
  })

  it('ignores reasoning items and unrelated notifications', () => {
    expect(completed(item({ type: 'reasoning', summary: [], content: [] }))).toEqual([])
    expect(codexNotification('account/updated', {})).toEqual([])
  })
})

describe('codexTurn', () => {
  it('turns a stored turn into start, items and end', () => {
    expect(
      codexTurn({
        id: 'u1',
        status: 'completed',
        items: [
          item({ type: 'userMessage', content: [{ type: 'text', text: 'hi', text_elements: [] }] }),
          item({ id: 'i2', type: 'agentMessage', text: 'hello' }),
        ],
      }),
    ).toEqual([
      { type: 'turn.started', turn: 'u1' },
      { type: 'prompt', turn: 'u1', id: 'i1', text: 'hi' },
      { type: 'text', turn: 'u1', id: 'i2', text: 'hello' },
      { type: 'turn.ended', turn: 'u1', status: 'done' },
    ])
  })

  it('leaves an in-progress turn open', () => {
    expect(codexTurn({ id: 'u1', status: 'inProgress', items: [] })).toEqual([
      { type: 'turn.started', turn: 'u1' },
    ])
  })
})
