import { describe, expect, it, vi } from 'vitest'
import { BUS_HOOK_USAGE, type BusHookIo, runBusHook, sentLines } from './bus'

function io(context: BusHookIo['context']): BusHookIo & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    context: vi.fn(context),
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  }
}

describe('runBusHook', () => {
  it.each(['SessionStart', 'UserPromptSubmit'])(
    'prints the inbox context as %s hook output both agents accept',
    async (event) => {
      const hook = io(async () => ({ text: 'ostia bus: 1 unread message' }))
      expect(await runBusHook([event], hook)).toBe(0)
      expect(hook.lines.map((line) => JSON.parse(line))).toEqual([
        {
          hookSpecificOutput: {
            hookEventName: event,
            additionalContext: 'ostia bus: 1 unread message',
          },
        },
      ])
    },
  )

  it('prints nothing for an empty inbox', async () => {
    const hook = io(async () => ({ text: null }))
    expect(await runBusHook(['UserPromptSubmit'], hook)).toBe(0)
    expect(hook.lines).toEqual([])
    expect(hook.errors).toEqual([])
  })

  it('never fails the hook when the app cannot answer', async () => {
    const hook = io(async () => {
      throw new Error('connection closed')
    })
    expect(await runBusHook(['SessionStart'], hook)).toBe(0)
    expect(hook.lines).toEqual([])
  })

  it.each([[['Stop']], [['PreToolUse']], [[]], [['UserPromptSubmit', 'extra']]])(
    'refuses %j without marking anything seen',
    async (args) => {
      const hook = io(async () => ({ text: 'x' }))
      expect(await runBusHook(args, hook)).toBe(1)
      expect(hook.context).not.toHaveBeenCalled()
      expect(hook.errors).toEqual([BUS_HOOK_USAGE])
    },
  )
})

describe('sentLines', () => {
  it('lists each message with its receiver and whether it was seen', () => {
    expect(
      sentLines([
        { id: 'a', to: 'pane-b', preview: 'first', ts: 't1', seenAt: 't2' },
        { id: 'b', to: 'pane-c', preview: 'second', ts: 't3' },
      ]),
    ).toEqual(['t1\tpane-b\tseen t2\tfirst', 't3\tpane-c\tunseen\tsecond'])
  })

  it('says so when nothing was sent', () => {
    expect(sentLines([])).toEqual(['(no messages sent)'])
  })
})
