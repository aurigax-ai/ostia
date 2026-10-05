import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { join } from 'node:path'
import type {
  AgentOfferOptions,
  AgentOfferResult,
  CommandHandler,
  ExtensionCaller,
  ExtensionResult,
  OpenTerminalResult,
  RunAgentOptions,
} from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AgentLauncher, panelHandlers } from './panelApi'
import { TrellisService } from './service'
import { AgentTasks } from './tasks'
import { type FakeTrellis, fakeTrellis, translate } from './testFake'

interface Confirm {
  title: string
  message: string
}

describe('trellis panel handlers', () => {
  let fake: FakeTrellis
  let service: TrellisService
  let handlers: Record<string, CommandHandler>
  let confirms: Confirm[]
  let answer: boolean
  let changes: number
  let daemon: Server | null
  let daemonRequests: { url: string; token: unknown }[]
  let runs: RunAgentOptions[]
  let offers: AgentOfferOptions[]
  let focused: string[]
  let marked: { paneId: string; ref: string }[]
  let runAnswer: OpenTerminalResult
  let offerAnswer: AgentOfferResult
  let focusAnswer: ExtensionResult
  let tasks: AgentTasks

  const caller = (workDir?: string, workspaceId?: string): ExtensionCaller => ({
    kind: 'user',
    capabilities: [],
    workDir,
    workspaceId,
    locale: 'en',
  })

  const run = async (command: string, args: unknown = {}, workDir?: string) =>
    (await handlers[command](args, caller(workDir))) as ExtensionResult & {
      data?: Record<string, unknown>
    }

  const inWorkspace = async (command: string, args: unknown) =>
    (await handlers[command](args, caller(undefined, 'w1'))) as ExtensionResult & {
      data?: Record<string, unknown>
    }

  const launcher = (): AgentLauncher => ({
    list: async () => ['claude', 'codex'],
    run: async (opts) => {
      runs.push(opts)
      return runAnswer
    },
    offer: async (opts) => {
      offers.push(opts)
      return offerAnswer
    },
    focus: async (paneId) => {
      focused.push(paneId)
      return focusAnswer
    },
    mark: (paneId, card) => marked.push({ paneId, ref: card.ref }),
  })

  const writes = (): string[] =>
    fake.calls().filter((c) => /^(card (new|move|comment|claim|renew|release)|init)/.test(c))

  const serveDaemon = async (): Promise<void> => {
    daemonRequests = []
    daemon = createServer((req, res) => {
      daemonRequests.push({ url: req.url ?? '', token: req.headers['x-trellis-token'] })
      const ref = /\/cards\/([A-Z0-9-]+)$/.exec(req.url ?? '')?.[1]
      const comments = fake.state().comments[ref ?? ''] ?? []
      res.writeHead(req.headers['x-trellis-token'] === 'TESTTOKEN' ? 200 : 401, {
        'content-type': 'application/json',
      })
      res.end(JSON.stringify({ comments, events: [] }))
    })
    await new Promise<void>((r) => daemon?.listen(0, '127.0.0.1', r))
    const address = daemon.address()
    const port = typeof address === 'object' && address ? address.port : 0
    writeFileSync(
      join(fake.dir, 'daemon-running.json'),
      readFileSync(join(fake.dir, 'daemon-running.json'), 'utf8').replace(
        'http://127.0.0.1:7788',
        `http://127.0.0.1:${port}`,
      ),
    )
    writeFileSync(join(fake.dir, 'daemon-up'), '')
  }

  beforeEach(() => {
    fake = fakeTrellis()
    confirms = []
    answer = true
    runs = []
    offers = []
    focused = []
    marked = []
    runAnswer = { ok: true, paneId: 'pane-x' }
    offerAnswer = { ok: true, sent: true, paneId: 'pane-y' }
    focusAnswer = { ok: true }
    tasks = new AgentTasks()
    changes = 0
    daemon = null
    service = new TrellisService({
      home: fake.home,
      consumer: 'ostia',
      translate,
      changeDelayMs: 1,
      host: {
        listWorkspaces: async () => [],
        setWorkspaceChip: async () => ({ ok: true }),
        clearWorkspaceChip: async () => {},
        notifyPanel: async () => {},
        changed: () => {
          changes += 1
        },
        log: () => {},
      },
    })
    handlers = panelHandlers({
      service,
      translate,
      agents: launcher(),
      tasks,
      daemonCacheMs: 0,
      confirm: async (req) => {
        confirms.push({ title: req.title, message: req.message })
        return answer
      },
    })
  })

  afterEach(async () => {
    service.stop()
    daemon?.close()
    fake.restore()
  })

  it('tells the panel the workspace project, every project and the human actor', async () => {
    const shop = join(fake.home, 'shop')
    mkdirSync(shop)
    writeFileSync(join(shop, '.trellis'), '/DEMO/boards/demo\n')
    expect((await run('context', {}, shop)).data).toEqual({
      actor: 'human:ostia',
      workspace: { project: 'DEMO', board: 'demo' },
      canInit: false,
      projects: [{ key: 'DEMO', name: 'DEMO' }],
    })
    expect((await run('context', {}, fake.home)).data).toMatchObject({
      workspace: null,
      canInit: true,
    })
  })

  it('answers not-installed instead of throwing when trellis is missing', async () => {
    const missing = new TrellisService({
      home: fake.home,
      consumer: 'ostia',
      translate,
      bin: join(fake.root, 'no-such-trellis'),
      host: {
        listWorkspaces: async () => [],
        setWorkspaceChip: async () => ({ ok: true }),
        clearWorkspaceChip: async () => {},
        notifyPanel: async () => {},
        changed: () => {},
        log: () => {},
      },
    })
    const res = await panelHandlers({
      service: missing,
      translate,
      agents: launcher(),
      tasks: new AgentTasks(),
      confirm: async () => true,
    }).context({}, caller())
    expect(res).toMatchObject({ ok: false, error: 'not-installed' })
    missing.stop()
  })

  it('shows the board with its boards, and the trellis error for an unknown project', async () => {
    const res = await run('board', { project: 'DEMO' })
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ board: { project: 'DEMO' }, boards: [{ slug: 'demo' }] })
    expect(await run('board', { project: 'NOPE' })).toEqual({
      ok: false,
      error: 'project_not_found',
      message: 'no project NOPE\ntrellis card ls --all-projects   # known: DEMO',
    })
  })

  it('refuses arguments that are not refs, keys or slugs before running trellis', async () => {
    const attempts: [string, unknown][] = [
      ['board', { project: '--help' }],
      ['board', { project: 'DEMO', board: '../x' }],
      ['card', { ref: '--json' }],
      ['move', { ref: 'DEMO-1 --steal', column: 'done' }],
      ['move', { ref: 'DEMO-1', column: '' }],
      ['comment', { ref: 'DEMO-1', body: '   ' }],
      ['claim', { ref: 'x' }],
      ['create', { project: 'DEMO', title: '' }],
      ['create', { project: 'DEMO', title: 'ok', priority: 'highest' }],
      ['vault', { project: 'demo' }],
      ['entry', { project: 'DEMO', slug: '../../etc/passwd' }],
    ]
    for (const [command, args] of attempts) {
      expect(await run(command, args), `${command} ${JSON.stringify(args)}`).toMatchObject({
        ok: false,
        error: 'invalid-args',
      })
    }
    expect(fake.calls()).toEqual([])
  })

  it('opens a card without comments when no daemon runs, never starting one', async () => {
    const res = await run('card', { ref: 'demo-1', board: 'demo' })
    expect(res.data).toMatchObject({ card: { ref: 'DEMO-1', priority: 'high' }, thread: null })
    expect(fake.calls()).toEqual(['card show DEMO-1 --json', 'daemon status --json'])
  })

  it('reads comments from a running daemon with its token, on loopback only', async () => {
    await serveDaemon()
    const res = await run('card', { ref: 'DEMO-1', board: 'demo' })
    expect((res.data?.thread as { comments: { body: string }[] }).comments).toMatchObject([
      { body: 'Reproduced on **main**; the cart total is `null`.\n' },
    ])
    expect(daemonRequests).toEqual([{ url: '/api/p/DEMO/b/demo/cards/DEMO-1', token: 'TESTTOKEN' }])
  })

  it('moves, comments, claims and releases through the CLI and tells the panel', async () => {
    expect((await run('move', { ref: 'DEMO-3', column: 'review' })).ok).toBe(true)
    expect((await run('comment', { ref: 'DEMO-3', body: '@/etc/hostname' })).ok).toBe(true)
    expect((await run('claim', { ref: 'DEMO-3' })).ok).toBe(true)
    expect((await run('renew', { ref: 'DEMO-3' })).ok).toBe(true)
    expect((await run('release', { ref: 'DEMO-3' })).ok).toBe(true)
    const state = fake.state()
    expect(state.board.columns[2].cards.map((c) => c.ref)).toContain('DEMO-3')
    expect(state.comments['DEMO-3']).toMatchObject([
      { actor: 'human:ostia', body: '@/etc/hostname' },
    ])
    expect(writes().map((c) => c.split(' ').slice(0, 3).join(' '))).toEqual([
      'card move DEMO-3',
      'card comment DEMO-3',
      'card claim DEMO-3',
      'card renew DEMO-3',
      'card release DEMO-3',
    ])
    await new Promise((r) => setTimeout(r, 30))
    expect(changes).toBeGreaterThanOrEqual(1)
  })

  it('passes a failed write back with the trellis message and changes nothing', async () => {
    const res = await run('claim', { ref: 'DEMO-1' })
    expect(res).toMatchObject({ ok: false, error: 'contention' })
    await new Promise((r) => setTimeout(r, 30))
    expect(changes).toBe(0)
  })

  it('creates a card in the chosen column with a one-line title', async () => {
    const res = await run('create', {
      project: 'DEMO',
      title: 'Fix\nthe   cart',
      body: 'Details',
      column: 'review',
      priority: 'urgent',
    })
    expect(res.data).toMatchObject({
      card: { title: 'Fix the cart', column: 'review', priority: 'urgent' },
    })
  })

  it('lists vault entries and reads one', async () => {
    const list = await run('vault', { project: 'DEMO' })
    expect((list.data?.entries as unknown[]).length).toBe(2)
    const entry = await run('entry', { project: 'DEMO', slug: 'database-concurrency' })
    expect(entry.data).toMatchObject({ entry: { title: 'Database concurrency' } })
    expect(writes()).toEqual([])
  })

  it('runs trellis init only after the human confirms', async () => {
    const dir = join(fake.home, 'shop')
    mkdirSync(dir)
    answer = false
    expect(await run('init', {}, dir)).toMatchObject({ ok: false, error: 'cancelled' })
    expect(writes()).toEqual([])
    answer = true
    expect(await run('init', {}, dir)).toMatchObject({ ok: true })
    expect(confirms[1]).toEqual({
      title: 'Initialize Trellis project',
      message: `Run \`trellis init\` in ${dir}?`,
    })
    expect(readFileSync(join(fake.dir, 'init-cwd'), 'utf8').trim()).toBe(dir)
  })

  it('starts the chosen agent in the panel workspace with a prompt built from the card', async () => {
    const res = await inWorkspace('start', { ref: 'demo-1', agent: 'claude', board: 'demo' })
    expect(res).toMatchObject({ ok: true, data: { ref: 'DEMO-1', agent: 'claude' } })
    expect(runs).toHaveLength(1)
    expect(runs[0].workspaceId).toBe('w1')
    expect(runs[0].agent).toBe('claude')
    const prompt = runs[0].prompt
    expect(prompt).toContain('Work on Trellis card DEMO-1: Checkout fails on an empty cart')
    expect(prompt).toContain('1. Empty the cart\n2. Press **Pay**')
    expect(prompt).toContain('`trellis card show DEMO-1`')
    expect(prompt).toContain('`trellis card claim DEMO-1`')
    expect(prompt).toContain('`trellis card comment DEMO-1 --body')
    expect(prompt).toContain('`trellis card move DEMO-1 review`')
    expect(marked).toEqual([{ paneId: 'pane-x', ref: 'DEMO-1' }])
    expect((await run('tasks')).data).toEqual({
      tasks: [{ ref: 'DEMO-1', agent: 'claude', at: expect.any(Number) }],
    })
    expect(writes()).toEqual([])
  })

  it('refuses a start without a workspace, a known card or a plain agent name', async () => {
    expect(await run('start', { ref: 'DEMO-1', agent: 'claude' })).toMatchObject({
      ok: false,
      error: 'no-workspace',
    })
    for (const agent of ['', '--yolo', 'claude code', 'a;b']) {
      expect(await inWorkspace('start', { ref: 'DEMO-1', agent })).toMatchObject({
        ok: false,
        error: 'invalid-args',
      })
    }
    expect(await inWorkspace('start', { ref: 'DEMO-99', agent: 'claude' })).toMatchObject({
      ok: false,
      error: 'card_not_found',
    })
    expect(runs).toEqual([])
  })

  it('passes a refused run back and tracks nothing', async () => {
    runAnswer = { ok: false, error: 'unknown-agent', message: 'no agent by that name' }
    expect(await inWorkspace('start', { ref: 'DEMO-1', agent: 'gemini' })).toEqual({
      ok: false,
      error: 'unknown-agent',
      message: 'no agent by that name',
    })
    expect((await run('tasks')).data).toEqual({ tasks: [] })
    expect(marked).toEqual([])
  })

  it('offers one line naming the card to the human and tracks the agent they picked', async () => {
    offerAnswer = { ok: true, sent: false }
    expect(await inWorkspace('offer', { ref: 'DEMO-3', board: 'demo' })).toMatchObject({
      ok: true,
      data: { sent: false },
    })
    expect(tasks.list()).toEqual([])
    expect(offers[0]).toEqual({
      workspaceId: 'w1',
      label: 'DEMO-3 · Write the rollback runbook',
      text: expect.stringContaining('Work on Trellis card DEMO-3 (Write the rollback runbook)'),
    })
    expect(offers[0].text).not.toContain('\n')
    expect(offers[0].text).toContain('`trellis card move DEMO-3 review`')

    offerAnswer = { ok: true, sent: true, paneId: 'pane-y' }
    expect(await inWorkspace('offer', { ref: 'DEMO-3' })).toMatchObject({
      ok: true,
      data: { sent: true },
    })
    expect(tasks.list()).toMatchObject([{ ref: 'DEMO-3', paneId: 'pane-y', agent: null }])
    expect(marked).toEqual([{ paneId: 'pane-y', ref: 'DEMO-3' }])
  })

  it('focuses the tracked pane and forgets it once the pane is gone', async () => {
    expect(await run('focus', { ref: 'DEMO-1' })).toMatchObject({ ok: false, error: 'no-task' })
    await inWorkspace('start', { ref: 'DEMO-1', agent: 'codex' })
    expect(await run('focus', { ref: 'demo-1' })).toEqual({ ok: true })
    expect(focused).toEqual(['pane-x'])
    focusAnswer = { ok: false, error: 'unknown-pane' }
    expect(await run('focus', { ref: 'DEMO-1' })).toMatchObject({
      ok: false,
      error: 'pane-closed',
    })
    expect(tasks.list()).toEqual([])
  })

  it('lists the agent names it may start', async () => {
    expect((await run('agents')).data).toEqual({ agents: ['claude', 'codex'] })
  })
})
