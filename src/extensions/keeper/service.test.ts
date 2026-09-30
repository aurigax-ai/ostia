import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type PollIntervals, type PollState, isAllowedKeeperCall } from './keeper'
import { KeeperService } from './service'

const FIXTURES = join(__dirname, '../../../test/fixtures/tools')

describe('KeeperService with a fake keeper on PATH', () => {
  let root: string
  let fake: string
  let savedPath: string | undefined
  let service: KeeperService | null
  let sidebar: { key: string; text: string; tone?: string; icon?: string }[]
  let notes: { title: string; body?: string; path?: string }[]
  let polls: PollState[]
  let intervals: PollIntervals[]

  const use = (fixture: string, as: string): void =>
    copyFileSync(join(FIXTURES, 'keeper', fixture), join(fake, as))
  const calls = (): string[] => {
    const log = join(fake, 'calls.log')
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
  }
  const make = (): KeeperService => {
    service = new KeeperService({
      host: {
        setSidebarItem: async (item) => {
          sidebar.push(item)
        },
        notifyPanel: async (title, body, path) => {
          notes.push({ title, body, path })
        },
        log: () => {},
      },
      delayFor: (s, i) => {
        polls.push(s)
        if (i) intervals.push(i)
        return null
      },
    })
    return service
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pine-keeper-svc-'))
    fake = join(root, 'fake')
    mkdirSync(fake)
    use('status-running.txt', 'status.txt')
    use('approve-empty.json', 'approve.json')
    use('ui.txt', 'ui.txt')
    savedPath = process.env.PATH
    process.env.PATH = `${join(FIXTURES, 'bin')}:${savedPath}`
    process.env.FAKE_KEEPER_DIR = fake
    sidebar = []
    notes = []
    polls = []
    intervals = []
    service = null
  })

  afterEach(() => {
    service?.stop()
    process.env.PATH = savedPath
    Reflect.deleteProperty(process.env, 'FAKE_KEEPER_DIR')
    rmSync(root, { recursive: true, force: true })
  })

  it('shows a count and notifies once when approvals are waiting', async () => {
    use('approve-pending.json', 'approve.json')
    const svc = make()
    await svc.tick()
    expect(sidebar).toEqual([
      { key: 'approvals', text: '2 waiting for approval', icon: 'shield', tone: 'warn' },
    ])
    expect(notes).toEqual([
      {
        title: 'Keeper needs approval',
        body: '2 queries are waiting (codex: close stale carts)',
        path: '/approvals',
      },
    ])
    await svc.tick()
    expect(notes).toHaveLength(1)
    expect(polls.at(-1)).toMatchObject({ installed: true, pending: 2, failures: 0 })
  })

  it('removes the item when the queue empties', async () => {
    use('approve-pending.json', 'approve.json')
    const svc = make()
    await svc.tick()
    use('approve-empty.json', 'approve.json')
    await svc.tick()
    expect(sidebar.at(-1)).toEqual({ key: 'approvals', text: '' })
  })

  it('shows nothing and never asks for the queue while the daemon is down', async () => {
    use('status-stopped.txt', 'status.txt')
    const svc = make()
    await svc.tick()
    await svc.tick()
    expect(sidebar).toEqual([])
    expect(svc.state).toBe('down')
    expect(calls()).toEqual(['daemon status', 'daemon status'])
    expect(polls.map((p) => p.failures)).toEqual([1, 2])
    expect(await svc.uiUrl()).toBeNull()
  })

  it('stops polling when keeper is not installed', async () => {
    process.env.PATH = join(root, 'empty-bin')
    const svc = make()
    await svc.tick()
    expect(svc.state).toBe('not-installed')
    expect(polls.at(-1)).toMatchObject({ installed: false })
    expect(sidebar).toEqual([])
    expect(svc.unavailableMessage()).toMatch(/not installed/)
  })

  it('reports the dashboard address from keeper ui', async () => {
    expect(await make().uiUrl()).toBe('http://127.0.0.1:7773')
  })

  it('never passes a ticket to keeper approve', async () => {
    use('approve-pending.json', 'approve.json')
    const svc = make()
    await svc.tick()
    await svc.uiUrl()
    await svc.tick()
    const argv = calls()
    expect(argv.length).toBeGreaterThan(0)
    expect(argv.every((line) => isAllowedKeeperCall(line.split(' ')))).toBe(true)
    expect(argv.filter((l) => l.startsWith('approve'))).toEqual([
      'approve --json',
      'approve --json',
    ])
  })

  it('polls again right away when the window gains focus', async () => {
    const svc = make()
    svc.setFocused(true)
    await new Promise((r) => setTimeout(r, 200))
    expect(calls()).toContain('approve --json')
    expect(polls.at(-1)).toMatchObject({ focused: true })
  })

  it('keeps counting but stays quiet when the human turned notices off', async () => {
    use('approve-pending.json', 'approve.json')
    const svc = make()
    svc.configure({ intervals: { fastMs: 2000, idleMs: 30_000 }, notify: false })
    await svc.tick()
    expect(sidebar.at(-1)).toMatchObject({ text: '2 waiting for approval' })
    expect(notes).toEqual([])
  })

  it('schedules the next check with the configured intervals', async () => {
    const svc = make()
    svc.configure({ intervals: { fastMs: 2000, idleMs: 30_000 }, notify: true })
    await svc.tick()
    expect(intervals.at(-1)).toEqual({ fastMs: 2000, idleMs: 30_000 })
  })
})
