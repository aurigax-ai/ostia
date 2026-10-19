import type {
  ConfirmRequest,
  ExtensionCaller,
  ExtensionResult,
  SandboxDomainsResult,
} from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateGate } from './createGate'
import { ScreensService } from './screensService'
import { type FakeScreens, fakeScreens, translate } from './testFake'
import { verbHandlers } from './verbs'

const agentIn = (workspaceId: string, sandboxed = false): ExtensionCaller => ({
  kind: 'pane',
  paneId: `pane-${workspaceId}`,
  workspaceId,
  capabilities: [],
  ...(sandboxed ? { sandboxed: true } : {}),
})

const argv = (...words: string[]) => ({ argv: words })

describe('ostia screen verbs', () => {
  let fake: FakeScreens
  let service: ScreensService
  let confirm: ReturnType<typeof vi.fn<(req: ConfirmRequest) => Promise<boolean>>>
  let domains: ReturnType<typeof vi.fn<(workspaceId: string) => Promise<SandboxDomainsResult>>>
  let verbs: ReturnType<typeof verbHandlers>
  let gate: CreateGate

  const run = (verb: string, args: unknown, caller: ExtensionCaller) =>
    verbs[verb](args, caller) as Promise<ExtensionResult>

  const build = (timeoutMs?: number) => {
    gate = new CreateGate({
      confirm,
      card: (name) => ({ title: 'screen', message: name }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
    verbs = verbHandlers({
      service,
      gate,
      translate,
      installed: () => true,
      sandboxDomains: domains,
      workspaceName: async (id) => `name-${id}`,
      agentOf: async () => undefined,
    })
  }

  beforeEach(() => {
    fake = fakeScreens()
    service = new ScreensService()
    confirm = vi.fn(async () => true)
    domains = vi.fn(async () => ({ ok: false as const, error: 'not-sandboxed' }))
    build()
  })

  afterEach(() => {
    service.stopAllNow()
    fake.restore()
  })

  it('SCX-C13 gives an agent in workspace A the agent token of the screen it created', async () => {
    const created = await run('create', argv(), agentIn('A'))
    expect(created.ok).toBe(true)
    const id = (created as { data: { id: string } }).data.id
    const res = await run('token', argv(), agentIn('A'))
    const [screen] = fake.screens()
    expect(screen.id).toBe(id)
    expect(screen.label).toBe('workspace:A')
    expect(res).toEqual({ ok: true, text: screen.agentToken })
    expect(await run('token', argv(id), agentIn('A'))).toEqual({
      ok: true,
      text: screen.agentToken,
    })
    expect(JSON.stringify(created)).not.toContain(screen.agentToken)
    expect(fake.calls().join('\n')).not.toContain(screen.agentToken)
  })

  it('SCX-C14 refuses an agent in workspace B the token of A or a stop of it, and leaves A untouched', async () => {
    const created = await run('create', argv(), agentIn('A'))
    const id = (created as { data: { id: string } }).data.id
    const before = fake.calls().length
    const token = await run('token', argv(id), agentIn('B'))
    expect(token).toMatchObject({ ok: false, error: 'refused' })
    expect(JSON.stringify(token)).not.toContain(fake.screens()[0].agentToken)
    expect(await run('stop', argv(id), agentIn('B'))).toMatchObject({ ok: false, error: 'refused' })
    expect(await run('token', argv(), agentIn('B'))).toMatchObject({ ok: false })
    expect(await run('click', argv('--screen', id, '1', '2'), agentIn('B'))).toMatchObject({
      ok: false,
      error: 'refused',
    })
    expect(fake.screens().map((s) => s.id)).toEqual([id])
    expect(fake.calls().slice(before)).toEqual([])
  })

  it('SCX-C15 asks once per workspace with Always, and again after Revoke', async () => {
    await run('create', argv(), agentIn('A'))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0].message).toBe('name-A')
    await run('create', argv(), agentIn('A'))
    expect(confirm).toHaveBeenCalledTimes(1)
    await run('create', argv(), agentIn('C'))
    expect(confirm).toHaveBeenCalledTimes(2)
    gate.revoke('A')
    await run('create', argv(), agentIn('A'))
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(fake.screens()).toHaveLength(4)
  })

  it('SCX-C2 refuses an agent create on a screens older than 0.1.1, before any card', async () => {
    fake.restore()
    fake = fakeScreens({ version: '0.1.0' })
    const res = await run('create', argv(), agentIn('A'))
    expect(res).toMatchObject({ ok: false, error: 'outdated' })
    expect((res as { message: string }).message).toContain('0.1.1')
    expect(confirm).not.toHaveBeenCalled()
    expect(fake.screens()).toEqual([])
  })

  it('SCX-C16 starts no screen when the human denies the card', async () => {
    confirm.mockResolvedValue(false)
    const res = await run('create', argv(), agentIn('A'))
    expect(res).toMatchObject({ ok: false, error: 'refused' })
    expect(fake.screens()).toEqual([])
    expect(fake.calls()).toEqual([])
    expect(gate.isAlways('A')).toBe(false)
  })

  it('SCX-C16 starts no screen when the human ignores the card, even if they answer later', async () => {
    let answer: (value: boolean) => void = () => {}
    confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    build(50)
    const res = await run('create', argv(), agentIn('A'))
    expect(res).toMatchObject({ ok: false, error: 'refused' })
    answer(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(fake.screens()).toEqual([])
    expect(gate.isAlways('A')).toBe(false)
  })

  it('needs no card when the human creates from the panel or the palette', async () => {
    const res = await run('create', argv(), { kind: 'user', workspaceId: 'A', capabilities: [] })
    expect(res.ok).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('SCX-C17 starts a sandboxed screen with the workspace domains and relays a screenshot', async () => {
    domains.mockResolvedValue({ ok: true, domains: ['example.test'] })
    const created = await run('create', argv(), agentIn('S', true))
    expect(created.ok).toBe(true)
    expect(domains).toHaveBeenCalledWith('S')
    expect(fake.screens()[0].allow).toEqual(['example.test'])
    const shot = await run('screenshot', argv(), agentIn('S', true))
    expect(shot).toMatchObject({ ok: true, data: { width: 1280, height: 800 } })
    expect(
      Buffer.from((shot as { data: { png: string } }).data.png, 'base64')
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG')
  })

  it('takes no --allow in a sandboxed workspace', async () => {
    domains.mockResolvedValue({ ok: true, domains: ['example.test'] })
    const res = await run('create', argv('--allow', 'evil.test'), agentIn('S', true))
    expect(res).toMatchObject({ ok: false, error: 'usage' })
    expect(fake.screens()).toEqual([])
  })

  it('relays only the flags each verb takes, so no file is written on the host', async () => {
    await run('create', argv(), agentIn('A'))
    const before = fake.calls().length
    for (const args of [
      argv('--out', '/tmp/x.png'),
      argv('--token', 'x'),
      argv('-o', 'x'),
      argv('--json'),
    ]) {
      expect(await run('screenshot', args, agentIn('A'))).toMatchObject({
        ok: false,
        error: 'usage',
      })
    }
    expect(await run('type', argv('--', '--out'), agentIn('A'))).toMatchObject({ ok: false })
    expect(fake.calls().slice(before)).toEqual([])
    expect(await run('click', argv('10', '20', '--button', 'right'), agentIn('A'))).toEqual({
      ok: true,
      text: 'ok',
    })
    expect(await run('launch', argv('--', 'firefox', '--new-window'), agentIn('A'))).toMatchObject({
      ok: true,
      data: { pid: 4242 },
    })
    const id = fake.screens()[0].id
    expect(fake.calls().slice(-2)).toEqual([
      `click ${id} 10 20 --button right --json`,
      `launch ${id} -- firefox --new-window --json`,
    ])
  })

  it('passes the service refusal through when the human owns input', async () => {
    await run('create', argv(), agentIn('A'))
    const { readFileSync, writeFileSync } = await import('node:fs')
    const file = `${fake.dir}/state.json`
    const state = JSON.parse(readFileSync(file, 'utf8'))
    state.screens[0].owner = 'human'
    writeFileSync(file, JSON.stringify(state))
    expect(await run('click', argv('1', '1'), agentIn('A'))).toMatchObject({
      ok: false,
      error: 'refused',
      message: 'human-owns-input',
    })
  })

  it('lists only the caller workspace screens and stops by default the only one', async () => {
    await run('create', argv(), agentIn('A'))
    await run('create', argv(), agentIn('B'))
    const listed = await run('list', argv(), agentIn('A'))
    expect((listed as { data: { screens: { id: string }[] } }).data.screens).toHaveLength(1)
    expect(await run('stop', argv(), agentIn('A'))).toMatchObject({ ok: true })
    expect(fake.screens().map((s) => s.label)).toEqual(['workspace:B'])
  })
})

describe('ostia screen ask-phone', () => {
  const askWith = (askPhone?: ReturnType<typeof vi.fn>) =>
    verbHandlers({
      service: new ScreensService(),
      gate: new CreateGate({
        confirm: async () => true,
        card: () => ({ title: 't', message: 'm' }),
      }),
      translate,
      installed: () => true,
      sandboxDomains: async () => ({ ok: false as const, error: 'not-sandboxed' }),
      workspaceName: async (id) => id,
      agentOf: async (paneId) => (paneId === 'pane-A' ? 'codex' : undefined),
      ...(askPhone ? { askPhone: askPhone as never } : {}),
    })['ask-phone']
  const caller: ExtensionCaller = {
    kind: 'pane',
    paneId: 'pane-A',
    workspaceId: 'A',
    capabilities: [],
  }

  it('PHA-C5 passes the agent’s reason and pane on and says what the phone answered', async () => {
    const askPhone = vi.fn().mockResolvedValue({ ok: true, data: { outcome: 'started' } })
    const ask = askWith(askPhone)
    const started = (await ask(
      { argv: ['--reason', 'check the login'] },
      caller,
    )) as ExtensionResult
    expect(askPhone).toHaveBeenCalledWith({
      sessionId: 'A',
      pane: 'pane-A',
      reason: 'check the login',
      agent: 'codex',
    })
    expect(started).toMatchObject({ ok: true })
    askPhone.mockResolvedValueOnce({ ok: true, data: { outcome: 'declined', reason: 'off' } })
    expect(await ask({ argv: ['check', 'it'] }, caller)).toMatchObject({
      ok: false,
      error: 'declined',
    })
    expect(askPhone).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'check it' }))
    askPhone.mockResolvedValueOnce({ ok: true, data: { outcome: 'declined', reason: 'denied' } })
    expect(await ask({ argv: ['--reason', 'x y'] }, caller)).toEqual({
      ok: false,
      error: 'declined',
      message: "The phone's human said no",
    })
    askPhone.mockResolvedValueOnce({ ok: true, data: { outcome: 'no-answer' } })
    expect(await ask({ argv: ['--reason', 'x y'] }, caller)).toMatchObject({ error: 'no-answer' })
    askPhone.mockResolvedValueOnce({ ok: false, error: 'busy' })
    expect(await ask({ argv: ['--reason', 'x y'] }, caller)).toMatchObject({ error: 'busy' })
  })

  it('PHA-C6 is for an agent pane only, needs a reason and says when phone screens are off', async () => {
    const askPhone = vi.fn()
    const ask = askWith(askPhone)
    expect(
      await ask({ argv: ['--reason', 'x'] }, { kind: 'palette', capabilities: [] } as never),
    ).toMatchObject({
      ok: false,
      error: 'refused',
    })
    expect(await ask({ argv: [] }, caller)).toMatchObject({ ok: false, error: 'usage' })
    expect(askPhone).not.toHaveBeenCalled()
    expect(await askWith()({ argv: ['--reason', 'x'] }, caller)).toMatchObject({
      ok: false,
      error: 'phone-off',
    })
  })
})
