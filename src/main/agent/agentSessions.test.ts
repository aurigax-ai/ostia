import {
  AGENT_PROMPT_MAX,
  type AgentEvent,
  type AgentToolReply,
} from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AgentRig, startAgentRig } from '../../../test/agentHarness'
import type { CoreCallRequest, CoreLifecycle } from './agentCoreCall'
import { openInputOf } from './agentRequests'
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
    core: [] as CoreCallRequest[],
    coreHook: undefined as ((request: CoreCallRequest) => void) | undefined,
    coreReply: { ok: true, output: 'core output' } as AgentToolReply,
    mail: null as string | null,
    acked: 0,
    mailLifecycles: [] as CoreLifecycle[],
    failPrompt: false,
    promptMailCalls: 0,
  }
  const rig = await startAgentRig(answer)
  rigs.push(rig)
  const sessions = new AgentSessions({
    request: (request) =>
      state.failPrompt && request.op === 'prompt'
        ? Promise.resolve({ ok: false, error: 'boom' })
        : rig.handle(request),
    settings: () => ({
      providers: [{ id: 'fake', name: 'Fake', baseUrl: rig.provider.url, models: ['fake-model'] }],
      alwaysAsk: [],
    }),
    sandboxed: () => state.sandboxed,
    redact,
    promptMail: async (_scope, lifecycle) => {
      state.promptMailCalls++
      state.mailLifecycles.push(lifecycle)
      if (state.mail === null) return null
      return {
        text: state.mail,
        ack: async () => {
          state.acked++
        },
      }
    },
    coreCall: async (request) => {
      state.core.push(request)
      state.coreHook?.(request)
      if (state.coreHook) {
        return new Promise<AgentToolReply>((resolve) =>
          request.lifecycle.token?.onCancellationRequested(() =>
            resolve({ ok: true, output: 'late' }),
          ),
        )
      }
      return state.coreReply
    },
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
    paneId: 'p1',
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
      settings: () => ({ providers: [], alwaysAsk: [] }),
      sandboxed: () => false,
      redact: async (t) => t,
      coreCall: async () => ({ ok: true, output: '' }),
      promptMail: async () => null,
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

  describe('the stream a phone reads', () => {
    it('keeps the prompt as typed, the reply and the end of the turn', async () => {
      const { rig, sessions, win, input } = await bridge(
        () => 'ok',
        async (text) => text.replace('sk-SECRET', '[redacted]'),
      )
      await sessions.open(win, input)
      const done = rig.settled()
      await sessions.prompt(win, 's1', 'use sk-SECRET now')
      await done
      const events = sessions.stream('s1')?.snapshot(5) ?? []
      expect(events.map((e) => e.type)).toEqual(['turn.started', 'prompt', 'text', 'turn.ended'])
      expect(events[1]).toMatchObject({ text: 'use sk-SECRET now' })
      expect(events[2]).toMatchObject({ text: 'ok' })
    })

    it('keeps a tool call with the answer the window gave, unredacted', async () => {
      const { sessions } = await toolRound(
        (ctx, call) =>
          ctx.sessions.answerTool(ctx.win, call.callId, { ok: true, output: 'token sk-SECRET' }),
        async (text) => text.replace('sk-SECRET', '[redacted]'),
      )
      const events = sessions.stream('s1')?.snapshot(5) ?? []
      expect(events.find((e) => e.type === 'tool')).toMatchObject({
        name: 'read_file',
        kind: 'read',
        target: 'a.txt',
      })
      expect(events.find((e) => e.type === 'tool.result')).toMatchObject({
        output: 'token sk-SECRET',
      })
    })

    it('drops the stream when the session closes or its window goes away', async () => {
      const { sessions, win, input } = await bridge(() => 'ok')
      await sessions.open(win, input)
      expect(sessions.stream('s1')).toBeDefined()
      await sessions.close(win, 's1')
      expect(sessions.stream('s1')).toBeUndefined()
      await sessions.open(win, input)
      win.destroy()
      expect(sessions.stream('s1')).toBeUndefined()
    })
  })

  describe('core calls from the owning window', () => {
    interface Pending {
      callId: string
    }

    async function pendingCall(ctx: Ctx, sessionId = 's1', name = 'ostia_panes', input = {}) {
      const reply = ctx.sessions.tool(
        true,
        { sessionId, toolCallId: `tc-${sessionId}`, name, input },
        () => undefined,
      )
      await expect
        .poll(() => ctx.win.sent.filter((s) => s.channel === 'agent:tool-call').length)
        .toBeGreaterThan(0)
      const sent = ctx.win.sent.filter((s) => s.channel === 'agent:tool-call')
      const { callId } = sent[sent.length - 1].payload as Pending
      return { callId, reply }
    }

    it('runs the tool the model asked for with the model’s own input, as the pane the session was opened for', async () => {
      const ctx = await bridge(() => 'ok')
      await ctx.sessions.open(ctx.win, ctx.input)
      const { callId } = await pendingCall(ctx, 's1', 'ostia_agent_run', { agent: 'claude' })
      expect(await ctx.sessions.coreCall(ctx.win, 's1', callId)).toEqual({
        ok: true,
        output: 'core output',
      })
      expect(ctx.state.core).toHaveLength(1)
      expect(ctx.state.core[0]).toMatchObject({
        name: 'ostia_agent_run',
        input: { agent: 'claude' },
        scope: { paneId: 'p1', windowId: '1', workspaceId: 'w1' },
      })
    })

    it('runs one core call for each tool call', async () => {
      const ctx = await bridge(() => 'ok')
      await ctx.sessions.open(ctx.win, ctx.input)
      const { callId } = await pendingCall(ctx)
      await ctx.sessions.coreCall(ctx.win, 's1', callId)
      expect(await ctx.sessions.coreCall(ctx.win, 's1', callId)).toEqual({
        ok: false,
        error: 'invalid',
      })
      expect(ctx.state.core).toHaveLength(1)
    })

    it('refuses a call that is unknown, from another window, or for another session', async () => {
      const ctx = await bridge(() => 'ok')
      await ctx.sessions.open(ctx.win, ctx.input)
      await ctx.sessions.open(ctx.win, { ...ctx.input, sessionId: 's2' })
      const { callId } = await pendingCall(ctx, 's1')
      const invalid = { ok: false, error: 'invalid' }
      expect(await ctx.sessions.coreCall(ctx.win, 's1', 't999')).toEqual(invalid)
      expect(await ctx.sessions.coreCall(ctx.win, 's2', callId)).toEqual(invalid)
      expect(await ctx.sessions.coreCall(renderer(2), 's1', callId)).toEqual(invalid)
      expect(await ctx.sessions.coreCall(ctx.win, 's1', 5)).toEqual(invalid)
      expect(ctx.state.core).toEqual([])
    })

    it('never runs a call that already settled, was aborted or lost its session', async () => {
      const ctx = await bridge(() => 'ok')
      await ctx.sessions.open(ctx.win, ctx.input)
      const answered = await pendingCall(ctx)
      ctx.sessions.answerTool(ctx.win, answered.callId, { ok: true, output: 'x' })
      await answered.reply
      const aborted = await pendingCall(ctx)
      await ctx.sessions.abort(ctx.win, 's1')
      const closed = await pendingCall(ctx)
      await ctx.sessions.close(ctx.win, 's1')
      for (const { callId } of [answered, aborted, closed]) {
        expect(await ctx.sessions.coreCall(ctx.win, 's1', callId)).toEqual({
          ok: false,
          error: 'invalid',
        })
      }
      expect(ctx.state.core).toEqual([])
    })

    it('ends the call’s connection and token when the call settles', async () => {
      const ctx = await bridge(() => 'ok')
      await ctx.sessions.open(ctx.win, ctx.input)
      const { callId } = await pendingCall(ctx)
      await ctx.sessions.coreCall(ctx.win, 's1', callId)
      const { lifecycle } = ctx.state.core[0]
      let closed = 0
      lifecycle.conn.onClose(() => {
        closed += 1
      })
      expect(lifecycle.token?.isCancellationRequested).toBe(false)
      ctx.sessions.answerTool(ctx.win, callId, { ok: true, output: 'x' })
      expect(lifecycle.token?.isCancellationRequested).toBe(true)
      expect(closed).toBe(1)
    })

    it('fires the connection’s close when an abort cancels a running core call', async () => {
      const ctx = await bridge(() => 'ok')
      await ctx.sessions.open(ctx.win, ctx.input)
      const { callId } = await pendingCall(ctx)
      let closed = 0
      ctx.state.coreHook = (request) => {
        request.lifecycle.conn.onClose(() => {
          closed += 1
        })
      }
      const running = ctx.sessions.coreCall(ctx.win, 's1', callId)
      await ctx.sessions.abort(ctx.win, 's1')
      expect(await running).toEqual({ ok: false, error: 'Cancelled.' })
      expect(closed).toBe(1)
    })

    it('cancels only the aborted session’s calls, not another session of the same window', async () => {
      const ctx = await bridge(() => 'ok')
      await ctx.sessions.open(ctx.win, ctx.input)
      await ctx.sessions.open(ctx.win, { ...ctx.input, sessionId: 's2', paneId: 'p2' })
      const first = await pendingCall(ctx, 's1')
      const second = await pendingCall(ctx, 's2')
      await ctx.sessions.abort(ctx.win, 's1')
      expect(await first.reply).toMatchObject({ ok: false, error: 'Cancelled.' })
      expect(await ctx.sessions.coreCall(ctx.win, 's2', second.callId)).toMatchObject({ ok: true })
      ctx.sessions.answerTool(ctx.win, second.callId, { ok: true, output: 'x' })
      expect(await second.reply).toEqual({ ok: true, output: 'x' })
    })

    it('cancels a session’s pending calls when it closes, before it forgets who owns it', async () => {
      const ctx = await bridge(() => 'ok')
      await ctx.sessions.open(ctx.win, ctx.input)
      const { reply } = await pendingCall(ctx)
      await ctx.sessions.close(ctx.win, 's1')
      expect(await reply).toMatchObject({ ok: false, error: 'Cancelled.' })
      expect(ctx.win.sent.some((s) => s.channel === 'agent:tool-cancel')).toBe(true)
    })

    it('opens only with the pane the window names', async () => {
      const ctx = await bridge(() => 'ok')
      const { paneId: _paneId, ...withoutPane } = ctx.input
      expect(openInputOf('s1', withoutPane)).toBeNull()
      expect(openInputOf('s1', { ...withoutPane, paneId: '' })).toBeNull()
      expect(openInputOf('s1', { ...withoutPane, paneId: 'p1' })).toMatchObject({ paneId: 'p1' })
    })
  })
})

describe('AgentSessions prompt mail', () => {
  const MAIL =
    '<ostia-bus-messages>\n<message id="m1" from="ab12">build is green</message>\n</ostia-bus-messages>'
  const ended = (lifecycle: CoreLifecycle | undefined) =>
    lifecycle?.token?.isCancellationRequested === true

  it('starts no turn and takes no mail until the human sends a prompt', async () => {
    const { rig, sessions, win, input, state } = await bridge(() => 'ok')
    state.mail = MAIL
    await sessions.open(win, input)
    expect(state.promptMailCalls).toBe(0)
    expect(rig.provider.requests).toEqual([])
  })

  it('adds the wrapped mail ahead of the human’s prompt and acknowledges it once after pi accepted it', async () => {
    const { rig, sessions, win, input, state } = await bridge(() => 'ok')
    state.mail = MAIL
    await sessions.open(win, input)
    const done = rig.settled()
    expect((await sessions.prompt(win, 's1', 'what now?')).ok).toBe(true)
    await done
    expect(rig.provider.requests.map((r) => r.last)).toEqual([`${MAIL}\n\nwhat now?`])
    expect(state.acked).toBe(1)
    expect(state.mailLifecycles.every(ended)).toBe(true)
  })

  it('sends the prompt alone and acknowledges nothing when no mail waits', async () => {
    const { rig, sessions, win, input, state } = await bridge(() => 'ok')
    await sessions.open(win, input)
    const done = rig.settled()
    await sessions.prompt(win, 's1', 'plain')
    await done
    expect(rig.provider.requests.map((r) => r.last)).toEqual(['plain'])
    expect(state.acked).toBe(0)
  })

  it('leaves the mail queued when pi refuses the prompt', async () => {
    const { rig, sessions, win, input, state } = await bridge(() => 'ok')
    state.mail = MAIL
    state.failPrompt = true
    await sessions.open(win, input)
    expect(await sessions.prompt(win, 's1', 'hi')).toEqual({ ok: false, error: 'boom' })
    expect(state.acked).toBe(0)
    expect(state.mailLifecycles.every(ended)).toBe(true)
    expect(rig.provider.requests).toEqual([])
  })

  it('leaves the mail queued and sends nothing when the mail cannot be checked for secrets', async () => {
    const { rig, sessions, win, input, state } = await bridge(
      () => 'ok',
      async (text) => (text === MAIL ? null : text),
    )
    state.mail = MAIL
    await sessions.open(win, input)
    expect(await sessions.prompt(win, 's1', 'hi')).toEqual({
      ok: false,
      error: 'redaction-failed',
    })
    expect(state.acked).toBe(0)
    expect(state.mailLifecycles.every(ended)).toBe(true)
    expect(rig.provider.requests).toEqual([])
  })

  it('redacts the mail like the prompt before pi sees it', async () => {
    const { rig, sessions, win, input, state } = await bridge(
      () => 'ok',
      async (text) => text.replaceAll('sk-SECRET', '[redacted]'),
    )
    state.mail = 'key sk-SECRET'
    await sessions.open(win, input)
    const done = rig.settled()
    await sessions.prompt(win, 's1', 'go')
    await done
    expect(rig.provider.requests.map((r) => r.last)).toEqual(['key [redacted]\n\ngo'])
  })

  it.each(['abort', 'close'] as const)(
    'releases the lease at once when %s arrives before pi took the prompt',
    async (way) => {
      let open!: () => void
      const gate = new Promise<void>((resolve) => {
        open = resolve
      })
      const { rig, sessions, win, input, state } = await bridge(
        () => 'ok',
        async (text) => {
          if (text === MAIL) await gate
          return text
        },
      )
      state.mail = MAIL
      await sessions.open(win, input)
      const prompted = sessions.prompt(win, 's1', 'hi')
      await vi.waitFor(() => expect(state.promptMailCalls).toBe(1))
      await sessions[way](win, 's1')
      expect(state.mailLifecycles.every(ended)).toBe(true)
      open()
      expect(await prompted).toEqual({ ok: false, error: 'cancelled' })
      expect(state.acked).toBe(0)
      expect(rig.provider.requests).toEqual([])
    },
  )

  it('keeps the mail queued for a prompt too long to carry it', async () => {
    const { sessions, win, input, state } = await bridge(() => 'ok')
    state.mail = MAIL
    await sessions.open(win, input)
    await sessions.prompt(win, 's1', 'x'.repeat(AGENT_PROMPT_MAX - 100))
    expect(state.promptMailCalls).toBe(0)
  })

  describe('a capability card raised for the session pane', () => {
    it('reports waiting true then false, only as booleans', async () => {
      const { sessions, win, input } = await bridge(() => 'ok')
      await sessions.open(win, input)
      const seen: unknown[] = []
      sessions.watchWaiting('s1', (waiting) => seen.push(waiting))
      sessions.approvalOpened('p1', 'approval-1')
      expect(seen).toEqual([true])
      sessions.approvalSettled('approval-1')
      expect(seen).toEqual([true, false])
    })

    it('stays waiting until every card of the session is answered', async () => {
      const { sessions, win, input } = await bridge(() => 'ok')
      await sessions.open(win, input)
      const seen: boolean[] = []
      sessions.watchWaiting('s1', (waiting) => seen.push(waiting))
      sessions.approvalOpened('p1', 'approval-1')
      sessions.approvalOpened('p1', 'approval-2')
      sessions.approvalSettled('approval-1')
      sessions.approvalSettled('approval-2')
      expect(seen).toEqual([true, false])
    })

    it('does not touch a session for a card of another pane or an unknown card', async () => {
      const { sessions, win, input } = await bridge(() => 'ok')
      await sessions.open(win, input)
      const seen: boolean[] = []
      sessions.watchWaiting('s1', (waiting) => seen.push(waiting))
      sessions.approvalOpened('other-pane', 'approval-1')
      sessions.approvalSettled('approval-1')
      sessions.approvalSettled('approval-9')
      expect(seen).toEqual([])
    })
  })
})
