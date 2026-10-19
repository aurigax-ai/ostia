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
) {
  const rig = await startAgentRig(answer)
  rigs.push(rig)
  const sessions = new AgentSessions({
    request: (request) => rig.handle(request),
    settings: () => ({
      providers: [{ id: 'fake', name: 'Fake', baseUrl: rig.provider.url, models: ['fake-model'] }],
      skillFolders: [],
    }),
    redact,
  })
  const win = renderer()
  rig.listen((sessionId, event: AgentEvent) => sessions.event('agent', { sessionId, event }))
  rig.setToolCaller((call, signal) =>
    sessions.tool('agent', call, (listener) => {
      signal.addEventListener('abort', listener, { once: true })
      return { dispose: () => signal.removeEventListener('abort', listener) }
    }),
  )
  const input = {
    sessionId: 's1',
    workspaceId: 'w1',
    cwd: rig.cwd,
    tools: [
      {
        name: 'read_file',
        description: 'Read a file.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
  }
  return { rig, sessions, win, input }
}

describe('AgentSessions', () => {
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
      'agent',
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
    expect(sessions.event('other', { sessionId: 's1', event: { type: 'turn-end' } })).toEqual({
      ok: false,
    })
    const reply = await sessions.tool(
      'other',
      { sessionId: 's1', toolCallId: 'c', name: 'read_file', input: {} },
      () => undefined,
    )
    expect(reply).toEqual({ ok: false, error: 'invalid' })
    expect(win.sent).toEqual([])
  })
})
