import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrellisService, type WorkspaceRef } from './service'

const FIXTURES = join(__dirname, '../../../test/fixtures/tools')
const CLAIM_LIVE_AT = 1790323096200 - 1

interface Recorded {
  chips: Record<string, unknown>[]
  cleared: { workspaceId: string; id: string }[]
  notes: { title: string; body?: string; path?: string }[]
}

describe('TrellisService with a fake trellis on PATH', () => {
  let root: string
  let fake: string
  let home: string
  let savedPath: string | undefined
  let service: TrellisService | null
  let recorded: Recorded
  let workspaces: WorkspaceRef[] | Error
  let chipsAccepted = true

  const calls = (): string[] => {
    const log = join(fake, 'calls.log')
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
  }

  const make = (opts: Partial<ConstructorParameters<typeof TrellisService>[0]> = {}) => {
    service = new TrellisService({
      home,
      consumer: 'pine',
      now: () => CLAIM_LIVE_AT,
      uiProbeMs: 150,
      uiStartTimeoutMs: 3000,
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
    root = mkdtempSync(join(tmpdir(), 'pine-trellis-svc-'))
    fake = join(root, 'fake')
    home = join(root, 'home')
    mkdirSync(fake)
    mkdirSync(home)
    for (const f of readdirSync(join(FIXTURES, 'trellis'))) {
      copyFileSync(join(FIXTURES, 'trellis', f), join(fake, f))
    }
    savedPath = process.env.PATH
    process.env.PATH = `${join(FIXTURES, 'bin')}:${savedPath}`
    process.env.FAKE_TRELLIS_DIR = fake
    recorded = { chips: [], cleared: [], notes: [] }
    chipsAccepted = true
    workspaces = []
    service = null
  })

  afterEach(async () => {
    service?.stop()
    await new Promise((r) => setTimeout(r, 120))
    process.env.PATH = savedPath
    Reflect.deleteProperty(process.env, 'FAKE_TRELLIS_DIR')
    rmSync(root, { recursive: true, force: true })
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
        tooltip: '4 open · 1 claimed',
        icon: 'kanban',
        tone: 'brand',
        command: 'open',
      },
    ])
    expect(calls()).toContain('card ls --json --all --project DEMO')
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
    process.env.PATH = join(root, 'empty-bin')
    workspaces = [{ workspaceId: 's1', workDir: project('shop', '/DEMO') }]
    const svc = make({ followRestartBaseMs: 20 })
    await svc.refreshSidebar()
    await expect(svc.ensureUi()).rejects.toMatchObject({ code: 'not-installed' })
    await svc.startEvents()
    await new Promise((r) => setTimeout(r, 200))
    expect(recorded.chips).toEqual([])
    expect(svc.followRestarts()).toBe(0)
    expect(svc.owned()).toBe(false)
  })

  it('uses the running daemon UI without starting a server', async () => {
    writeFileSync(join(fake, 'daemon-up'), '')
    const svc = make()
    await expect(svc.ensureUi()).resolves.toBe('http://127.0.0.1:7788/?token=TESTTOKEN')
    expect(svc.owned()).toBe(false)
    expect(calls()).toContain('ui --json')
  })

  it('serves the UI itself when no daemon runs, and stops it on shutdown', async () => {
    const svc = make()
    await expect(svc.ensureUi()).resolves.toBe('http://127.0.0.1:7788/?token=TESTTOKEN')
    expect(svc.owned()).toBe(true)
    expect(existsSync(join(fake, 'serving'))).toBe(true)
    svc.stop()
    await vi.waitFor(() => expect(existsSync(join(fake, 'serving'))).toBe(false), {
      timeout: 2000,
    })
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
      path: '/p/TRELLIS/card/TRELLIS-13',
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
          path: '/p/DEMO/card/DEMO-3',
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
            path: '/p/DEMO/card/DEMO-3',
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
  })
})
