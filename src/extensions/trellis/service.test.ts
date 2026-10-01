import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrellisService, type WorkspaceRef } from './service'
import { type FakeTrellis, fakeTrellis, translate } from './testFake'

interface Recorded {
  chips: Record<string, unknown>[]
  cleared: { workspaceId: string; id: string }[]
  notes: { title: string; body?: string; path?: string }[]
  changes: number
}

describe('TrellisService with a fake trellis on PATH', () => {
  let env: FakeTrellis
  let root: string
  let fake: string
  let home: string
  let service: TrellisService | null
  let recorded: Recorded
  let workspaces: WorkspaceRef[] | Error
  let chipsAccepted = true

  const calls = (): string[] => env.calls()

  const make = (opts: Partial<ConstructorParameters<typeof TrellisService>[0]> = {}) => {
    service = new TrellisService({
      home,
      consumer: 'pine',
      translate,
      changeDelayMs: 10,
      host: {
        listWorkspaces: async () => {
          if (workspaces instanceof Error) throw workspaces
          return workspaces
        },
        setWorkspaceChip: async (chip) => {
          recorded.chips.push(chip)
          return { ok: chipsAccepted }
        },
        clearWorkspaceChip: async (workspaceId, id) => {
          recorded.cleared.push({ workspaceId, id })
        },
        notifyPanel: async (title, body, path) => {
          recorded.notes.push({ title, body, path })
        },
        changed: () => {
          recorded.changes += 1
        },
        log: () => {},
      },
      ...opts,
    })
    return service
  }

  const project = (name: string, marker: string): string => {
    const dir = join(home, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.trellis'), `${marker}\n`)
    return dir
  }

  beforeEach(() => {
    env = fakeTrellis()
    root = env.root
    fake = env.dir
    home = env.home
    recorded = { chips: [], cleared: [], notes: [], changes: 0 }
    chipsAccepted = true
    workspaces = []
    service = null
  })

  afterEach(async () => {
    service?.stop()
    await new Promise((r) => setTimeout(r, 120))
    env.restore()
  })

  it('shows open and claimed counts on workspaces whose workDir is a trellis project', async () => {
    const shop = project('shop', '/DEMO')
    workspaces = [
      { workspaceId: 's1', workDir: join(shop) },
      { workspaceId: 's2', workDir: home },
    ]
    await make().refreshSidebar()
    expect(recorded.chips).toEqual([
      {
        workspaceId: 's1',
        id: 'cards',
        text: '4',
        tooltip: '4 open · 2 claimed',
        icon: 'kanban',
        tone: 'brand',
        command: 'open',
      },
    ])
    expect(calls()).toContain('board show --project DEMO --json')
  })

  it('sends the chip again on the next refresh when the app refused it', async () => {
    const shop = project('shop', '/DEMO')
    workspaces = [{ workspaceId: 's1', workDir: shop }]
    chipsAccepted = false
    const svc = make()
    await svc.refreshSidebar()
    workspaces = []
    await svc.refreshSidebar()
    expect(recorded.chips).toHaveLength(1)
    expect(recorded.cleared).toEqual([])
  })

  it('clears a workspace item once the workspace is gone', async () => {
    const shop = project('shop', '/DEMO')
    workspaces = [{ workspaceId: 's1', workDir: shop }]
    const svc = make()
    await svc.refreshSidebar()
    workspaces = []
    await svc.refreshSidebar()
    expect(recorded.cleared).toEqual([{ workspaceId: 's1', id: 'cards' }])
  })

  it('shows nothing when pine cannot list workspaces', async () => {
    project('shop', '/DEMO')
    workspaces = new Error('refused')
    await make().refreshSidebar()
    expect(recorded.chips).toEqual([])
  })

  it('degrades quietly when trellis is not installed', async () => {
    workspaces = [{ workspaceId: 's1', workDir: project('shop', '/DEMO') }]
    const svc = make({ bin: join(root, 'no-such-trellis'), followRestartBaseMs: 20 })
    await svc.refreshSidebar()
    await svc.startEvents()
    await new Promise((r) => setTimeout(r, 200))
    expect(recorded.chips).toEqual([])
    expect(svc.followRestarts()).toBe(0)
    expect(await svc.init(home)).toEqual({
      ok: false,
      message: expect.stringContaining('Trellis is not installed'),
    })
  })

  it('never starts or asks for the trellis web UI', async () => {
    workspaces = [{ workspaceId: 's1', workDir: project('shop', '/DEMO') }]
    const svc = make()
    await svc.refreshSidebar()
    await svc.startEvents()
    await vi.waitFor(() => expect(calls().some((c) => c.endsWith('--follow'))).toBe(true))
    expect(calls().filter((c) => c.startsWith('ui') || c.startsWith('daemon'))).toEqual([])
  })

  it('tells the panel once for a burst of card, comment and entry events', async () => {
    const svc = make()
    await svc.refreshSidebar()
    for (const [seq, entity, ref] of [
      [1, 'card', 'DEMO-1'],
      [2, 'comment', 'DEMO-1'],
      [3, 'entry', '/DEMO/vault/database-concurrency'],
      [4, 'label', 'bug'],
    ] as const) {
      svc.onEventLine(JSON.stringify({ seq, actor: 'agent:x', entity, ref, action: 'created' }))
    }
    await vi.waitFor(() => expect(recorded.changes).toBe(1))
    await new Promise((r) => setTimeout(r, 60))
    expect(recorded.changes).toBe(1)
    svc.onEventLine(JSON.stringify({ seq: 5, entity: 'label', ref: 'bug', action: 'created' }))
    await new Promise((r) => setTimeout(r, 60))
    expect(recorded.changes).toBe(1)
  })

  it('acks the newest event it read so the consumer cursor advances', async () => {
    vi.useFakeTimers()
    try {
      const svc = make()
      svc.onEventLine(JSON.stringify({ seq: 7, entity: 'label', ref: 'bug', action: 'created' }))
      svc.onEventLine(JSON.stringify({ seq: 9, entity: 'label', ref: 'bug', action: 'created' }))
      svc.onEventLine('{"gap":true,"oldest":46}')
      expect(calls().filter((c) => c.startsWith('events ack'))).toEqual([])
      await vi.advanceTimersByTimeAsync(2100)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(calls()).toContain('events ack pine 9'))
    expect(calls().filter((c) => c.startsWith('events ack'))).toEqual(['events ack pine 9'])
  })

  it('primes a new consumer without notifying, then notifies for agent moves to review', async () => {
    writeFileSync(join(fake, 'consumers.json'), '[]')
    copyFileSync(join(fake, 'events.jsonl'), join(fake, 'prime.jsonl'))
    copyFileSync(join(fake, 'events.jsonl'), join(fake, 'follow.jsonl'))
    workspaces = [{ workspaceId: 's1', workDir: project('trellis', '/TRELLIS') }]
    const svc = make()
    await svc.refreshSidebar()
    await svc.startEvents()
    expect(calls()).toContain('events ack pine 57')
    await vi.waitFor(() => expect(recorded.notes).toHaveLength(3), { timeout: 3000 })
    expect(recorded.notes[0]).toEqual({
      title: 'Trellis: ready for your review',
      body: 'TRELLIS-13 Skill: when-to-use-trellis (the trigger layer)',
      path: '/card/TRELLIS-13',
    })
    expect(recorded.notes.map((n) => n.body?.split(' ')[0])).toEqual([
      'TRELLIS-13',
      'TRELLIS-14',
      'TRELLIS-4',
    ])
  })

  it('notifies for a project a workspace opened after the last sidebar refresh', async () => {
    const svc = make()
    await svc.refreshSidebar()
    workspaces = [{ workspaceId: 's1', workDir: project('shop', '/DEMO') }]
    svc.onEventLine(
      JSON.stringify({
        seq: 9,
        actor: 'agent:x',
        entity: 'card',
        ref: 'DEMO-3',
        title: 'Card 3',
        action: 'moved',
        field: 'column',
        new: 'review',
      }),
    )
    await vi.waitFor(() =>
      expect(recorded.notes).toEqual([
        {
          title: 'Trellis: ready for your review',
          body: 'DEMO-3 Card 3',
          path: '/card/DEMO-3',
        },
      ]),
    )
  })

  it('notifies for an event that arrives before its workspace is reported', async () => {
    const svc = make()
    await svc.refreshSidebar()
    svc.onEventLine(
      JSON.stringify({
        seq: 9,
        actor: 'agent:x',
        entity: 'card',
        ref: 'DEMO-3',
        title: 'Card 3',
        action: 'moved',
        field: 'column',
        new: 'review',
      }),
    )
    await new Promise((r) => setTimeout(r, 200))
    expect(recorded.notes).toEqual([])
    workspaces = [{ workspaceId: 's1', workDir: project('shop', '/DEMO') }]
    await vi.waitFor(
      () =>
        expect(recorded.notes).toEqual([
          {
            title: 'Trellis: ready for your review',
            body: 'DEMO-3 Card 3',
            path: '/card/DEMO-3',
          },
        ]),
      { timeout: 3000 },
    )
  })

  it('notifies about nothing when the human turned review notices off', async () => {
    writeFileSync(join(fake, 'consumers.json'), '[{"name":"pine","cursor":45,"lag":0,"gap":false}]')
    copyFileSync(join(fake, 'events.jsonl'), join(fake, 'follow.jsonl'))
    workspaces = [{ workspaceId: 's1', workDir: project('trellis', '/TRELLIS') }]
    const svc = make()
    svc.notifyKinds = { review: false, blocked: true }
    await svc.refreshSidebar()
    await svc.startEvents()
    await vi.waitFor(() => expect(calls().some((c) => c.endsWith('--follow'))).toBe(true))
    await new Promise((r) => setTimeout(r, 300))
    expect(recorded.notes).toEqual([])
  })

  it('ignores events for projects no workspace has open', async () => {
    writeFileSync(join(fake, 'consumers.json'), '[{"name":"pine","cursor":45,"lag":0,"gap":false}]')
    copyFileSync(join(fake, 'events.jsonl'), join(fake, 'follow.jsonl'))
    workspaces = [{ workspaceId: 's1', workDir: project('shop', '/DEMO') }]
    const svc = make()
    await svc.refreshSidebar()
    await svc.startEvents()
    await vi.waitFor(() => expect(calls().some((c) => c.endsWith('--follow'))).toBe(true))
    await new Promise((r) => setTimeout(r, 300))
    expect(recorded.notes).toEqual([])
    expect(
      calls().filter((c) => c.startsWith('events --consumer pine --json --all-projects --limit')),
    ).toEqual([])
  })

  it('backs off when the event feed keeps exiting instead of respawning in a loop', async () => {
    writeFileSync(join(fake, 'consumers.json'), '[{"name":"pine","cursor":0,"lag":0,"gap":false}]')
    writeFileSync(join(fake, 'follow-exits'), '')
    const svc = make({ followRestartBaseMs: 50 })
    await svc.startEvents()
    await new Promise((r) => setTimeout(r, 1000))
    const spawns = calls().filter((c) => c.endsWith('--follow')).length
    expect(spawns).toBeGreaterThanOrEqual(2)
    expect(spawns).toBeLessThanOrEqual(6)
  })

  it('runs trellis init in the given directory', async () => {
    const dir = join(home, 'shop')
    mkdirSync(dir)
    const res = await make().init(dir)
    expect(res).toEqual({ ok: true, text: `Trellis project SHOP is set up in ${dir}` })
    expect(readFileSync(join(fake, 'init-cwd'), 'utf8').trim()).toBe(dir)
    expect(calls()).toContain('init --json')
  })
})
