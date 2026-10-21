import { describe, expect, it, vi } from 'vitest'
import {
  BUS_HOOK_USAGE,
  type BusHookIo,
  busSeconds,
  busSendArgs,
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
    take: vi.fn(async () => ({ text: 'taken', lease: 'l-1' })),
    modReady: vi.fn(async (state: string) => ({ ok: state })),
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

describe('runBusHook for the mod', () => {
  it('prints what bus.take answered as one JSON line', async () => {
    const hook = io(async () => ({ text: null }))
    expect(await runBusHook(['take'], hook)).toBe(0)
    expect(hook.lines.map((line) => JSON.parse(line))).toEqual([{ text: 'taken', lease: 'l-1' }])
    expect(hook.context).not.toHaveBeenCalled()
  })

  it('acknowledges the lease it is given', async () => {
    const hook = io(async () => ({ text: null }))
    await runBusHook(['ack', 'lease-9'], hook)
    expect(hook.acks).toEqual(['lease-9'])
  })

  it('reports the mailer’s state, idle unless told otherwise', async () => {
    const hook = io(async () => ({ text: null }))
    await runBusHook(['mod-ready', 'sess-1'], hook)
    await runBusHook(['mod-ready', 'sess-1', 'draft'], hook)
    expect(vi.mocked(hook.modReady).mock.calls.map(([state]) => state)).toEqual(['idle', 'draft'])
  })

  it.each([
    [['take', 'x']],
    [['ack']],
    [['ack', 'a', 'b']],
    [['mod-ready']],
    [['mod-ready', 'a', 'b', 'c']],
  ])('refuses %j with the usage line', async (args) => {
    const hook = io(async () => ({ text: null }))
    expect(await runBusHook(args, hook)).toBe(1)
    expect(hook.errors).toEqual([BUS_HOOK_USAGE])
  })

  it('never fails when the app cannot answer', async () => {
    const hook = io(async () => ({ text: null }))
    vi.mocked(hook.take).mockRejectedValueOnce(new Error('closed'))
    expect(await runBusHook(['take'], hook)).toBe(0)
    expect(hook.lines).toEqual([])
  })
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
  it('exits 0 with a reply, 1 for a failed message and 3 for no reply after --wait', () => {
    expect(sendExitCode({ state: 'delivered', reply: {} }, true)).toBe(0)
    expect(sendExitCode({ state: 'failed', reason: 'pane-closed' }, true)).toBe(1)
    expect(sendExitCode({ state: 'delivered' }, true)).toBe(3)
    expect(sendExitCode({ state: 'queued', pending: 'working' }, true)).toBe(3)
  })

  it('exits 0 for a queued message when the sender did not wait', () => {
    expect(sendExitCode({ state: 'queued' }, false)).toBe(0)
  })
})

describe('busSendArgs', () => {
  it('takes the pane and the message, with -- ending the flags and the words joined', () => {
    expect(busSendArgs(['p1', 'hello'])).toEqual({ to: 'p1', text: 'hello' })
    expect(busSendArgs(['p1', '--', '--help'])).toEqual({ to: 'p1', text: '--help' })
    expect(busSendArgs(['p1', '--', '--'])).toEqual({ to: 'p1', text: '--' })
    expect(busSendArgs(['p1', 'two', 'words'])).toEqual({ to: 'p1', text: 'two words' })
    expect(busSendArgs(['p1'])).toBeNull()
    expect(busSendArgs(['p1', '--'])).toBeNull()
    expect(busSendArgs([])).toBeNull()
  })

  it('takes --wait before the pane only, and needs its seconds', () => {
    expect(busSendArgs(['--wait', '30', 'p1', 'hi'])).toEqual({ to: 'p1', text: 'hi', wait: '30' })
    expect(busSendArgs(['p1', 'done', '--wait', '30'])).toEqual({
      to: 'p1',
      text: 'done --wait 30',
    })
    expect(busSendArgs(['--wait'])).toBeNull()
    expect(busSendArgs(['--wait', '30'])).toBeNull()
  })
})
