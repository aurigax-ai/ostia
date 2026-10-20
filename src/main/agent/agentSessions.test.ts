import type { AgentEvent } from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { afterEach, describe, expect, it } from 'vitest'
import { type AgentRig, startAgentRig } from '../../../test/agentHarness'
import { type AgentRenderer, AgentSessions } from './agentSessions'

interface FakeRenderer extends AgentRenderer {
  sent: { channel: string; payload: unknown }[]
  destroy: () => void
}

function renderer(id = 1): FakeRenderer {
  let destroyed = false
  const listeners: (() => void)[] = []
  return {
    id,
    sent: [],
    send(channel, payload) {
      this.sent.push({ channel, payload })
    },
    isDestroyed: () => destroyed,
    once: (_event, listener) => {
      listeners.push(listener)
    },
    destroy: () => {
      destroyed = true
      for (const listener of listeners) listener()
    },
  }
}

const rigs: AgentRig[] = []

afterEach(() => {
  for (const rig of rigs.splice(0)) rig.close()
})

async function bridge(
  answer: Parameters<typeof startAgentRig>[0],
  redact = async (t: string) => t as string | null,
  sandboxed = false,
) {
  const state = {
    sandboxed,
    rules: { text: '', count: 0 } as { text: string; count: number },
    asked: [] as string[][],
    throws: false,
  }
  const rig = await startAgentRig(answer)
  rigs.push(rig)
  const sessions = new AgentSessions({
    request: (request) => rig.handle(request),
    settings: () => ({
      providers: [{ id: 'fake', name: 'Fake', baseUrl: rig.provider.url, models: ['fake-model'] }],
    }),
    sandboxed: () => state.sandboxed,
    redact,
    rulesContext: async (...asked) => {
      state.asked.push(asked)
      if (state.throws) throw new Error('hook failed')
      return state.rules
    },
  })
  const win = renderer()
  rig.listen((sessionId, event: AgentEvent) => sessions.event(true, { sessionId, event }))
  rig.setToolCaller((call, signal) =>
    sessions.tool(true, call, (listener) => {
      signal.addEventListener('abort', listener, { once: true })
      return { dispose: () => signal.removeEventListener('abort', listener) }
    }),
  )
  const input = {
    sessionId: 's1',
    workspaceId: 'w1',
    cwd: rig.cwd,
    rules: true,
    tools: [
      {
        name: 'read_file',
        description: 'Read a file.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
  }
  return { rig, sessions, win, input, state }
}

describe('AgentSessions', () => {
  it('refuses a model that is not one of the configured providers', async () => {
    const { sessions, win, input } = await bridge(() => 'ok')
    const reply = await sessions.open(win, {
      ...input,
      model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    })
    expect(reply).toEqual({ ok: false, error: 'unknown-model' })
  })

  it('refuses to open in a sandboxed workspace', async () => {
    const { rig, sessions, win, input } = await bridge(
      () => 'ok',
      async (t) => t,
      true,
    )
    expect(await sessions.open(win, input)).toEqual({ ok: false, error: 'sandboxed' })
    expect(rig.provider.requests).toEqual([])
  })

  it('refuses a prompt once the workspace has become sandboxed', async () => {
    const { rig, sessions, win, input, state } = await bridge(() => 'ok')
    expect((await sessions.open(win, input)).ok).toBe(true)
    state.sandboxed = true
    expect(await sessions.prompt(win, 's1', 'hi')).toEqual({ ok: false, error: 'sandboxed' })
    expect(rig.provider.requests).toEqual([])
  })

  it('does not run a tool once the workspace has become sandboxed', async () => {
    const ctx = await bridge((req) =>
      req.toolResult === undefined
        ? { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }
        : `model saw: ${req.toolResult}`,
    )
    await ctx.sessions.open(ctx.win, ctx.input)
    const done = ctx.rig.settled()
    await ctx.sessions.prompt(ctx.win, 's1', 'read it')
    await expect
      .poll(() => ctx.win.sent.filter((s) => s.channel === 'agent:tool-call').length)
      .toBe(1)
    const call = ctx.win.sent.find((s) => s.channel === 'agent:tool-call')?.payload as {
      callId: string
    }
    ctx.state.sandboxed = true
    const reply = await ctx.sessions.tool(
      true,
      { sessionId: 's1', toolCallId: 'c2', name: 'read_file', input: {} },
      () => undefined,
    )
    expect(reply).toMatchObject({ ok: false })
    expect(ctx.win.sent.filter((s) => s.channel === 'agent:tool-call')).toHaveLength(1)
    ctx.sessions.answerTool(ctx.win, call.callId, { ok: true, output: 'x' })
    await done
  })

  describe('rules at session start', () => {
    const RULES = 'Rules the human approved.\n- Write no comments. [r1]'

    it('puts the approved rules in the session’s system prompt and says how many', async () => {
      const { rig, sessions, win, input, state } = await bridge(() => 'ok')
      state.rules = { text: RULES, count: 1 }
      expect(await sessions.open(win, input)).toMatchObject({ ok: true, rules: 1 })
      expect(state.asked).toEqual([['w1', rig.cwd, 's1']])
      const done = rig.settled()
      await sessions.prompt(win, 's1', 'hi')
      await done
      expect(rig.provider.requests[0].system).toContain('- Write no comments. [r1]')
    })

    it('leaves them out, and does not even ask for them, when the human turned the chip off', async () => {
      const { rig, sessions, win, input, state } = await bridge(() => 'ok')
      state.rules = { text: RULES, count: 1 }
      expect(await sessions.open(win, { ...input, rules: false })).toMatchObject({
        ok: true,
        rules: 0,
      })
      expect(state.asked).toEqual([])
      const done = rig.settled()
      await sessions.prompt(win, 's1', 'hi')
      await done
      expect(rig.provider.requests[0].system).not.toContain('Write no comments')
    })

    it('redacts them, and opens without them when the hook fails, the scan fails or nothing applies', async () => {
      const redacting = await bridge(
        () => 'ok',
        async (t) => t.replace('Write no comments', '[redacted]'),
      )
      redacting.state.rules = { text: RULES, count: 1 }
      await redacting.sessions.open(redacting.win, redacting.input)
      const done = redacting.rig.settled()
      await redacting.sessions.prompt(redacting.win, 's1', 'hi')
      await done
      expect(redacting.rig.provider.requests[0].system).toContain('- [redacted]. [r1]')

      const failing = await bridge(() => 'ok')
      failing.state.throws = true
      expect(await failing.sessions.open(failing.win, failing.input)).toMatchObject({
        ok: true,
        rules: 0,
      })

      const scanFails = await bridge(
        () => 'ok',
        async (t) => (t === RULES ? null : t),
      )
      scanFails.state.rules = { text: RULES, count: 1 }
      expect(await scanFails.sessions.open(scanFails.win, scanFails.input)).toMatchObject({
        ok: true,
        rules: 0,
      })

      const none = await bridge(() => 'ok')
      none.state.rules = { text: RULES, count: 0 }
      expect(await none.sessions.open(none.win, none.input)).toMatchObject({ ok: true, rules: 0 })
    })
  })

  it('sends a one-shot completion redacted, never the original', async () => {
    const { rig, sessions } = await bridge(
      () => 'done',
      async (text) => text.replaceAll('sk-SECRET', '[redacted]'),
    )
    const reply = await sessions.complete({ system: 'never use sk-SECRET', input: 'use sk-SECRET' })
    expect(reply).toMatchObject({ ok: true, text: 'done' })
    expect(rig.provider.requests.map((r) => [r.system, r.last])).toEqual([
      ['never use [redacted]', 'use [redacted]'],
    ])
  })

  it('sends nothing for a one-shot completion when the redaction fails, the input is not text or too long, or no model is set up', async () => {
    const failing = await bridge(
      () => 'done',
      async () => null,
    )
    expect(await failing.sessions.complete({ system: 's', input: 'i' })).toEqual({
      ok: false,
      error: 'redaction-failed',
    })
    expect(failing.rig.provider.requests).toEqual([])
    const { rig, sessions } = await bridge(() => 'done')
    for (const params of [
      null,
      { system: 's' },
      { system: '', input: 'i' },
      { system: 's', input: 5 },
      { system: 's', input: 'x'.repeat(60_001) },
      { system: 's'.repeat(8001), input: 'i' },
    ]) {
      expect(await sessions.complete(params)).toEqual({ ok: false, error: 'invalid' })
    }
    expect(rig.provider.requests).toEqual([])
    const none = new AgentSessions({
      request: (request) => rig.handle(request),
      settings: () => ({ providers: [] }),
      sandboxed: () => false,
      redact: async (t) => t,
      rulesContext: async () => ({ text: '', count: 0 }),
    })
    expect(await none.complete({ system: 's', input: 'i' })).toEqual({
      ok: false,
      error: 'no-model',
    })
  })

  it('sends the redacted prompt to the model, never the original', async () => {
    const { rig, sessions, win, input } = await bridge(
      () => 'ok',
      async (text) => text.replace('sk-SECRET', '[redacted]'),
    )
    expect((await sessions.open(win, input)).ok).toBe(true)
    const done = rig.settled()
    expect((await sessions.prompt(win, 's1', 'use sk-SECRET now')).ok).toBe(true)
    await done
    expect(rig.provider.requests.map((r) => r.last)).toEqual(['use [redacted] now'])
  })

  it('sends nothing when the redaction scan fails', async () => {
    const { rig, sessions, win, input } = await bridge(
      () => 'ok',
      async () => null,
    )
    await sessions.open(win, input)
    expect(await sessions.prompt(win, 's1', 'use sk-SECRET now')).toEqual({
      ok: false,
      error: 'redaction-failed',
    })
    expect(rig.provider.requests).toEqual([])
  })

  it('refuses a prompt from a window that does not own the session', async () => {
    const { rig, sessions, win, input } = await bridge(() => 'ok')
    await sessions.open(win, input)
    expect(await sessions.prompt(renderer(2), 's1', 'hi')).toEqual({ ok: false, error: 'invalid' })
    expect(rig.provider.requests).toEqual([])
  })

  type Ctx = Awaited<ReturnType<typeof bridge>>

  interface ToolCallSent {
    callId: string
    name: string
    input: unknown
  }

  async function toolRound(
    answerTool: (ctx: Ctx, call: ToolCallSent) => void,
    redact = async (t: string) => t as string | null,
  ) {
    const ctx = await bridge(
      (req) =>
        req.toolResult === undefined
          ? { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }
          : `model saw: ${req.toolResult}`,
      redact,
    )
    await ctx.sessions.open(ctx.win, ctx.input)
    const done = ctx.rig.settled()
    await ctx.sessions.prompt(ctx.win, 's1', 'read it')
    await expect
      .poll(() => ctx.win.sent.filter((s) => s.channel === 'agent:tool-call').length)
      .toBe(1)
    const call = ctx.win.sent.find((s) => s.channel === 'agent:tool-call')?.payload as ToolCallSent
    answerTool(ctx, call)
    await done
    return { ...ctx, call }
  }

  it('runs a tool in the owning window and returns its answer to the model', async () => {
    const { rig, win, call } = await toolRound((ctx, c) =>
      ctx.sessions.answerTool(ctx.win, c.callId, { ok: true, output: 'file body' }),
    )
    expect(call).toMatchObject({ name: 'read_file', input: { path: 'a.txt' } })
    expect(rig.provider.requests[1]?.toolResult).toBe('file body')
    expect(win.sent.some((s) => s.channel === 'agent:event')).toBe(true)
  })

  it('returns a denied tool to the model as an error result', async () => {
    const { rig } = await toolRound((ctx, c) =>
      ctx.sessions.answerTool(ctx.win, c.callId, { ok: false, error: 'Denied.', denied: true }),
    )
    expect(rig.provider.requests[1]?.toolResult).toBe('Denied.')
  })

  it('redacts a tool result before the model sees it', async () => {
    const { rig } = await toolRound(
      (ctx, c) =>
        ctx.sessions.answerTool(ctx.win, c.callId, { ok: true, output: 'key sk-SECRET here' }),
      async (text) => text.replace('sk-SECRET', '[redacted]'),
    )
    expect(rig.provider.requests[1]?.toolResult).toBe('key [redacted] here')
  })

  it('returns an error instead of the result when the scan of a tool result fails', async () => {
    const { rig } = await toolRound(
      (ctx, c) =>
        ctx.sessions.answerTool(ctx.win, c.callId, { ok: true, output: 'key sk-SECRET here' }),
      async (text) => (text.includes('SECRET') ? null : text),
    )
    const seen = rig.provider.requests[1]?.toolResult ?? ''
    expect(seen).not.toContain('SECRET')
    expect(seen).toMatch(/not sent/)
  })

  it('ignores a tool answer from another window', async () => {
    const { rig } = await toolRound((ctx, c) => {
      ctx.sessions.answerTool(renderer(2), c.callId, { ok: true, output: 'forged' })
      ctx.sessions.answerTool(ctx.win, c.callId, { ok: true, output: 'real' })
    })
    expect(rig.provider.requests[1]?.toolResult).toBe('real')
  })

  it('answers a pending tool with an error when its window closes', async () => {
    const { sessions, win, input } = await bridge(() => 'ok')
    await sessions.open(win, input)
    const pending = sessions.tool(
      true,
      { sessionId: 's1', toolCallId: 'c1', name: 'read_file', input: {} },
      () => undefined,
    )
    win.destroy()
    expect(await pending).toMatchObject({ ok: false, error: expect.stringMatching(/closed/) })
  })

  it('cancels a pending tool when the turn is aborted', async () => {
    const ctx = await bridge(() => ({ toolCalls: [{ name: 'read_file', args: { path: 'a' } }] }))
    await ctx.sessions.open(ctx.win, ctx.input)
    await ctx.sessions.prompt(ctx.win, 's1', 'read it')
    await expect
      .poll(() => ctx.win.sent.filter((s) => s.channel === 'agent:tool-call').length)
      .toBe(1)
    await ctx.sessions.abort(ctx.win, 's1')
    expect(ctx.win.sent.some((s) => s.channel === 'agent:tool-cancel')).toBe(true)
  })

  it('refuses events and tool calls that do not come from the agent extension', async () => {
    const { sessions, win, input } = await bridge(() => 'ok')
    await sessions.open(win, input)
    expect(sessions.event(false, { sessionId: 's1', event: { type: 'turn-end' } })).toEqual({
      ok: false,
    })
    const reply = await sessions.tool(
      false,
      { sessionId: 's1', toolCallId: 'c', name: 'read_file', input: {} },
      () => undefined,
    )
    expect(reply).toEqual({ ok: false, error: 'invalid' })
    expect(win.sent).toEqual([])
  })
})
