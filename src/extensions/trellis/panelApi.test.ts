import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { join } from 'node:path'
import type {
  CommandHandler,
  ExtensionCaller,
  ExtensionResult,
} from '@aurigax-ai/pine-extension-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { panelHandlers } from './panelApi'
import { TrellisService } from './service'
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

  const caller = (workDir?: string): ExtensionCaller => ({
    kind: 'user',
    capabilities: [],
    workDir,
    locale: 'en',
  })

  const run = async (command: string, args: unknown = {}, workDir?: string) =>
    (await handlers[command](args, caller(workDir))) as ExtensionResult & {
      data?: Record<string, unknown>
    }

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
    changes = 0
    daemon = null
    service = new TrellisService({
      home: fake.home,
      consumer: 'pine',
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
      actor: 'human:pine',
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
      consumer: 'pine',
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
      { actor: 'human:pine', body: '@/etc/hostname' },
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
})
