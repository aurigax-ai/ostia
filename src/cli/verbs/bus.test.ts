import { describe, expect, it, vi } from 'vitest'
import {
  BUS_HOOK_USAGE,
  type BusHookIo,
  busSeconds,
  runBusHook,
  sendExitCode,
  sentLines,
} from './bus'

function io(
  context: BusHookIo['context'],
): BusHookIo & { lines: string[]; errors: string[]; acks: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  const acks: string[] = []
  return {
    lines,
    errors,
    acks,
    context: vi.fn(context),
    ack: async (lease) => {
      acks.push(lease)
    },
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  }
}

describe('runBusHook', () => {
  it.each(['SessionStart', 'UserPromptSubmit'])(
    'prints the inbox context as %s hook output both agents accept, then acknowledges the lease',
    async (event) => {
      const hook = io(async () => ({ text: 'ostia bus: 1 unread message', lease: 'lease-1' }))
      expect(await runBusHook([event], hook)).toBe(0)
      expect(hook.context).toHaveBeenCalledWith(event)
      expect(hook.lines.map((line) => JSON.parse(line))).toEqual([
        {
          hookSpecificOutput: {
            hookEventName: event,
            additionalContext: 'ostia bus: 1 unread message',
          },
        },
      ])
      expect(hook.acks).toEqual(['lease-1'])
    },
  )

  it('prints and acknowledges nothing for an empty inbox', async () => {
    const hook = io(async () => ({ text: null }))
    expect(await runBusHook(['UserPromptSubmit'], hook)).toBe(0)
    expect(hook.lines).toEqual([])
    expect(hook.acks).toEqual([])
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
    'refuses %j without taking any mail',
    async (args) => {
      const hook = io(async () => ({ text: 'x', lease: 'l' }))
      expect(await runBusHook(args, hook)).toBe(1)
      expect(hook.context).not.toHaveBeenCalled()
      expect(hook.errors).toEqual([BUS_HOOK_USAGE])
    },
  )
})

describe('sentLines', () => {
  it('lists each message with its receiver and where it stands', () => {
    expect(
      sentLines([
        { id: 'a', to: 'pane-b', preview: 'first', ts: 't1', state: 'delivered', via: 'prompt' },
        {
          id: 'b',
          to: 'pane-c',
          preview: 'second',
          ts: 't3',
          state: 'queued',
          pending: 'hibernated',
        },
        {
          id: 'c',
          to: 'pane-d',
          preview: 'third',
          ts: 't4',
          state: 'failed',
          reason: 'pane-closed',
        },
      ]),
    ).toEqual([
      't1\tpane-b\tdelivered:prompt\tfirst',
      't3\tpane-c\tqueued:hibernated\tsecond',
      't4\tpane-d\tfailed:pane-closed\tthird',
    ])
  })

  it('says so when nothing was sent', () => {
    expect(sentLines([])).toEqual(['(no messages sent)'])
  })
})

describe('busSeconds', () => {
  it('reads a flag in seconds, like pane wait and ask', () => {
    expect(busSeconds(undefined, '--wait')).toBeUndefined()
    expect(busSeconds('30', '--wait')).toBe(30_000)
    expect(busSeconds('1.5', '--timeout')).toBe(1500)
  })

  it.each(['0', '-5', 'soon', ''])('refuses %j and names the flag', (raw) => {
    expect(() => busSeconds(raw, '--wait')).toThrow(`--wait expects seconds, got '${raw}'`)
  })
})

describe('sendExitCode', () => {
  it('exits 0 delivered, 1 failed and 2 for a message still queued after --wait', () => {
    expect(sendExitCode({ state: 'delivered' }, true)).toBe(0)
    expect(sendExitCode({ state: 'failed', reason: 'pane-closed' }, true)).toBe(1)
    expect(sendExitCode({ state: 'queued', pending: 'working' }, true)).toBe(2)
  })

  it('exits 0 for a queued message when the sender did not wait', () => {
    expect(sendExitCode({ state: 'queued' }, false)).toBe(0)
  })
})
