import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentReply } from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { AgentSession, type ResourceLoader } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AgentRig, startAgentRig } from '../../../test/agentHarness'

const rigs: AgentRig[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const rig of rigs.splice(0)) rig.close()
})

async function start(...args: Parameters<typeof startAgentRig>): Promise<AgentRig> {
  const rig = await startAgentRig(...args)
  rigs.push(rig)
  return rig
}

async function ask(rig: AgentRig, text: string, session = 's1'): Promise<AgentReply> {
  expect((await rig.open(session)).ok).toBe(true)
  const done = rig.settled()
  const reply = await rig.prompt(session, text)
  if (reply.ok) await done
  return reply
}

function entries(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((name) => join(dir, name))
}

function assistantText(rig: AgentRig): string {
  return rig.events.flatMap((e) => (e.type === 'text-delta' ? [e.text] : [])).join('')
}

describe('the agent host', () => {
  it('sends a /skill: line unchanged even when pi knows the skill', async () => {
    const rig = await start(() => 'ok')
    const body = 'SKILL-BODY-MARKER'
    const baseDir = join(rig.cwd, 'skills', 'x')
    const filePath = join(baseDir, 'SKILL.md')
    mkdirSync(baseDir, { recursive: true })
    writeFileSync(filePath, `---\nname: x\ndescription: x\n---\n${body}\n`)
    const loader = Object.getOwnPropertyDescriptor(AgentSession.prototype, 'resourceLoader')?.get
    vi.spyOn(AgentSession.prototype, 'resourceLoader', 'get').mockImplementation(function (
      this: AgentSession,
    ) {
      const real = loader?.call(this) as ResourceLoader
      return {
        ...real,
        getSkills: () => ({
          skills: [{ name: 'x', description: 'x', filePath, baseDir, sourceInfo: {} }],
          diagnostics: [],
        }),
      } as ResourceLoader
    })
    await ask(rig, '/skill:x')
    expect(rig.provider.requests.map((r) => r.last)).toEqual(['/skill:x'])
    expect(JSON.stringify(rig.provider.requests)).not.toContain(body)
  })

  it("does not offer a model from pi's built-in catalog", async () => {
    const rig = await start(() => 'ok')
    const reply = await rig.handle({
      op: 'open',
      sessionId: 's1',
      cwd: rig.cwd,
      tools: [],
      providers: [{ id: 'fake', name: 'Fake', baseUrl: rig.provider.url, models: ['fake-model'] }],
      model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    })
    expect(reply).toMatchObject({ ok: true, model: { provider: 'fake', model: 'fake-model' } })
  })

  it('answers a prompt from a key-less OpenAI-compatible server', async () => {
    const rig = await start(() => 'hello from the model')
    await ask(rig, 'hi')
    expect(assistantText(rig)).toBe('hello from the model')
    expect(rig.provider.requests.map((r) => r.last)).toEqual(['hi'])
  })

  it('writes session files readable by the owner only', async () => {
    const rig = await start(() => 'ok')
    await ask(rig, 'hi')
    const sessions = join(rig.dataDir, 'sessions')
    const files = entries(sessions)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const mode = statSync(file).mode & 0o777
      expect(mode & 0o077, file).toBe(0)
    }
  })

  it('sends no cache-warming or other request besides the prompt', async () => {
    const rig = await start(() => 'ok')
    await ask(rig, 'hi')
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(rig.provider.requests).toHaveLength(1)
  })

  it('turns pi telemetry, update checks and network mode off in its process', async () => {
    await start(() => 'ok')
    expect(process.env.PI_TELEMETRY).toBe('0')
    expect(process.env.PI_SKIP_VERSION_CHECK).toBe('1')
    expect(process.env.PI_OFFLINE).toBe('1')
  })

  it('offers the model only the Ostia tools and answers a call to bash with not found', async () => {
    const rig = await start((req) =>
      req.toolResult === undefined
        ? { toolCalls: [{ name: 'bash', args: { command: 'ls' } }] }
        : 'done',
    )
    await ask(rig, 'list files')
    expect(rig.provider.requests[0]?.tools).toEqual(['read_file'])
    expect(rig.provider.requests[1]?.toolResult).toMatch(/not found/i)
    expect(rig.toolCalls).toEqual([])
  })

  it('hands a tool call to the bridge and returns its answer to the model', async () => {
    const rig = await start((req) =>
      req.toolResult === undefined
        ? { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }
        : `read: ${req.toolResult}`,
    )
    await ask(rig, 'read a.txt')
    expect(rig.toolCalls.map((c) => [c.name, c.input])).toEqual([['read_file', { path: 'a.txt' }]])
    expect(assistantText(rig)).toBe('read: file body')
    expect(rig.events.some((e) => e.type === 'tool-call' && e.name === 'read_file')).toBe(true)
  })

  it('returns a denied tool to the model as an error result', async () => {
    const rig = await start((req) =>
      req.toolResult === undefined
        ? { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }
        : `model saw: ${req.toolResult}`,
    )
    rig.setToolReply(() => ({ ok: false, error: 'The human denied this call.', denied: true }))
    await ask(rig, 'read a.txt')
    expect(rig.provider.requests[1]?.toolResult).toBe('The human denied this call.')
    expect(rig.events.some((e) => e.type === 'tool-done' && e.isError)).toBe(true)
  })

  it('reopens a saved session with its history after a restart', async () => {
    const first = await start(() => 'first answer')
    await ask(first, 'first question', 'keep')
    first.close()
    const second = await start(() => 'unused', first)
    const reopened = await second.open('keep')
    expect(reopened).toMatchObject({
      ok: true,
      history: [
        { role: 'user', text: 'first question' },
        { role: 'assistant', text: 'first answer' },
      ],
    })
  })

  it('refuses a session id that is not a plain token', async () => {
    const rig = await start(() => 'ok')
    expect(await rig.open('../escape')).toMatchObject({ ok: false, error: 'invalid' })
  })
})
