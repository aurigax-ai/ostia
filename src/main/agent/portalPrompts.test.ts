import { describe, expect, it } from 'vitest'
import type { AgentRenderer } from './agentSessions'
import { PiStream } from './piStream'
import { PortalPrompts } from './portalPrompts'

function rig(acceptMs = 1000) {
  const stream = new PiStream()
  const sent: { channel: string; payload: unknown }[] = []
  let alive = true
  const renderer: AgentRenderer = {
    id: 1,
    send: (channel, payload) => {
      sent.push({ channel, payload })
    },
    isDestroyed: () => !alive,
    once: () => {},
  }
  const prompts = new PortalPrompts(
    { renderer: () => (alive ? renderer : null), stream: () => stream },
    acceptMs,
  )
  const accept = (text: string): void => stream.prompt(text)
  return { stream, sent, prompts, accept, kill: () => (alive = false) }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

describe('PortalPrompts', () => {
  it('asks the owner window to send the prompt and answers when the window took it', async () => {
    const { prompts, sent, accept } = rig()
    const result = prompts.prompt('s1', 'list the workspaces')
    await settle()
    expect(sent).toEqual([
      { channel: 'agent:prompted', payload: { sessionId: 's1', text: 'list the workspaces' } },
    ])
    accept('list the workspaces')
    expect(await result).toEqual({ ok: true })
  })

  it('sends one prompt at a time: the second waits for the first turn to end, in order', async () => {
    const { prompts, sent, accept, stream } = rig()
    const first = prompts.prompt('s1', 'one')
    const second = prompts.prompt('s1', 'two')
    await settle()
    expect(sent.map((s) => (s.payload as { text: string }).text)).toEqual(['one'])
    accept('one')
    await first
    await settle()
    expect(sent).toHaveLength(1)
    stream.event({ type: 'turn-end' })
    await settle()
    expect(sent.map((s) => (s.payload as { text: string }).text)).toEqual(['one', 'two'])
    accept('two')
    expect(await second).toEqual({ ok: true })
  })

  it('answers no-window at once when no window owns the session', async () => {
    const { prompts, kill, sent } = rig()
    kill()
    expect(await prompts.prompt('s1', 'hi')).toEqual({ ok: false, error: 'no-window' })
    expect(sent).toEqual([])
  })

  it('answers not-accepted when the window never starts a turn, and frees the queue', async () => {
    const { prompts, accept } = rig(20)
    expect(await prompts.prompt('s1', 'lost')).toEqual({ ok: false, error: 'not-accepted' })
    const next = prompts.prompt('s1', 'again')
    await settle()
    accept('again')
    expect(await next).toEqual({ ok: true })
  })

  it('forget ends a prompt that waits behind a running turn', async () => {
    const { prompts, accept, stream, sent } = rig()
    accept('human typed this')
    const waiting = prompts.prompt('s1', 'queued')
    await settle()
    prompts.forget('s1')
    expect(await waiting).toMatchObject({ ok: false })
    expect(sent).toEqual([])
    expect(stream.busy).toBe(true)
  })
})
