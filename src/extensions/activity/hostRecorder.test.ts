import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folderWithin, HostRecorder, type HostWorkspace } from './hostRecorder'
import { HOST_DIR, JOURNAL_DIR, Journal } from './journal'

describe('HostRecorder', () => {
  let dir: string
  let journal: Journal
  let clock: number
  const changed = vi.fn()
  const workspaces: Record<string, HostWorkspace> = {
    w1: { workspaceId: 'w1', kind: 'terminal', workDir: '/work/shop' },
    w2: { workspaceId: 'w2', kind: 'terminal', workDir: '/work/site' },
    s1: { workspaceId: 's1', kind: 'scratch', workDir: '/tmp/scratch' },
    b1: { workspaceId: 'b1', kind: 'terminal', workDir: '/work/box', sandboxed: true },
  }

  const recorder = (redact = async (texts: string[]) => texts): HostRecorder =>
    new HostRecorder({
      journal,
      now: () => clock++,
      redact,
      workspace: async (id) => workspaces[id] ?? null,
      changed,
    })
  const file = (workspaceId: string): string =>
    join(dir, HOST_DIR, JOURNAL_DIR, `${workspaceId}.jsonl`)
  const hosts = (workspaceId: string) =>
    journal.events(workspaceId).flatMap((r) => (r.kind === 'host' ? [r] : []))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-activity-host-'))
    journal = new Journal({ dir: join(dir, HOST_DIR), now: () => clock })
    clock = 1000
    changed.mockClear()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records started, closed, status, hibernated and woken with the pane and nothing else', async () => {
    const rec = recorder()
    rec.accept('pane.created', { paneId: 'p1', workspaceId: 'w1' })
    rec.accept('pane.attention', { paneId: 'p1', workspaceId: 'w1', state: 'working' })
    rec.accept('pane.attention', { paneId: 'p1', workspaceId: 'w1', state: 'cleared' })
    rec.accept('pane.lifecycle', { paneId: 'p1', workspaceId: 'w1', state: 'hibernated' })
    rec.accept('pane.lifecycle', { paneId: 'p1', workspaceId: 'w1', state: 'woken' })
    rec.accept('pane.closed', { paneId: 'p1', workspaceId: 'w1' })
    await rec.settled()
    expect(hosts('w1').map((r) => [r.pane, r.host, r.state])).toEqual([
      ['p1', 'started', undefined],
      ['p1', 'state', 'working'],
      ['p1', 'hibernated', undefined],
      ['p1', 'woken', undefined],
      ['p1', 'closed', undefined],
    ])
    expect(changed).toHaveBeenCalledTimes(6)
  })

  it('tells the panel when a pane’s status is cleared, without recording it', async () => {
    const rec = recorder()
    rec.accept('pane.attention', { paneId: 'p1', workspaceId: 'w1', state: 'cleared' })
    await rec.settled()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(hosts('w1')).toEqual([])
  })

  it('skips a repeat of the same event for a pane', async () => {
    const rec = recorder()
    rec.accept('pane.attention', { paneId: 'p1', workspaceId: 'w1', state: 'waiting' })
    rec.accept('pane.attention', { paneId: 'p1', workspaceId: 'w1', state: 'waiting' })
    rec.accept('pane.attention', { paneId: 'p1', workspaceId: 'w1', state: 'done' })
    await rec.settled()
    expect(hosts('w1').map((r) => r.state)).toEqual(['waiting', 'done'])
  })

  it('stores a folder relative to the workspace folder, redacted, and drops it when the scan fails', async () => {
    const rec = recorder(async (texts) => texts.map((t) => t.replace('hunter2', '[redacted]')))
    rec.accept('cwd.changed', { paneId: 'p1', workspaceId: 'w1', cwd: '/work/shop/src/hunter2' })
    rec.accept('cwd.changed', { paneId: 'p1', workspaceId: 'w1', cwd: '/work/shop' })
    rec.accept('cwd.changed', { paneId: 'p1', workspaceId: 'w1', cwd: '/etc/ssh' })
    await rec.settled()
    expect(hosts('w1').map((r) => r.folder)).toEqual(['src/[redacted]', '.', '…/ssh'])
    const failing = recorder(async () => {
      throw new Error('scan failed')
    })
    failing.accept('cwd.changed', { paneId: 'p2', workspaceId: 'w1', cwd: '/work/shop/x' })
    await failing.settled()
    expect(hosts('w1')).toHaveLength(3)
  })

  it('records a bus message in each workspace of a pane involved, from and to only, never text', async () => {
    const rec = recorder()
    rec.accept('bus.message', {
      id: 'm1',
      from: { id: 'a', workspaceId: 'w1' },
      to: { id: 'b', workspaceId: 'w2' },
      kind: 'task',
      phase: 'queued',
    })
    rec.accept('bus.message', {
      id: 'm2',
      from: { id: 'ostia' },
      to: { id: 'a', workspaceId: 'w1' },
      kind: 'message',
      phase: 'delivered',
    })
    await rec.settled()
    expect(hosts('w1').map((r) => [r.pane, r.from, r.to, r.message, r.state, r.ref])).toEqual([
      ['a', 'a', '@elsewhere', 'task', 'queued', 'm1'],
      ['a', '@ostia', 'a', 'message', 'delivered', 'm2'],
    ])
    expect(hosts('w2').map((r) => [r.pane, r.from, r.to])).toEqual([['b', '@elsewhere', 'b']])
    const stored = journal.events('w1').map((r) => Object.keys(r))
    expect(stored.flat()).not.toContain('text')
  })

  it('keeps the host events of a project workspace on disk, and of a scratch, sandboxed or unknown workspace only in memory', async () => {
    const rec = recorder()
    for (const workspaceId of ['w1', 's1', 'b1', 'gone']) {
      rec.accept('pane.created', { paneId: `p-${workspaceId}`, workspaceId })
    }
    await rec.settled()
    expect(existsSync(file('w1'))).toBe(true)
    expect(readFileSync(file('w1'), 'utf8')).toContain('"host":"started"')
    for (const workspaceId of ['s1', 'b1', 'gone']) {
      expect(existsSync(file(workspaceId))).toBe(false)
      expect(hosts(workspaceId)).toHaveLength(1)
    }
  })
})

describe('the host journal', () => {
  it('has its own file and cap, so a flood of host events never pushes an agent turn out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ostia-activity-host-cap-'))
    let clock = 1
    const turns = new Journal({ dir, now: () => clock })
    const hostJournal = new Journal({ dir: join(dir, HOST_DIR), now: () => clock, maxBytes: 2000 })
    turns.append(
      'w1',
      {
        v: 2,
        t: 1,
        id: 'abcdefghij',
        pane: 'p',
        agent: 'claude',
        session: 's',
        kind: 'stop',
        text: 'recap',
      },
      true,
    )
    const rec = new HostRecorder({
      journal: hostJournal,
      now: () => clock++,
      redact: async (texts) => texts,
      workspace: async () => ({ workspaceId: 'w1', kind: 'terminal', workDir: '/w' }),
      changed: () => {},
    })
    for (let i = 0; i < 200; i++)
      rec.accept('cwd.changed', { paneId: 'p', workspaceId: 'w1', cwd: `/w/dir${i}` })
    await rec.settled()
    expect(turns.events('w1')).toHaveLength(1)
    expect(hostJournal.events('w1').length).toBeLessThan(200)
    expect(existsSync(join(dir, JOURNAL_DIR, 'w1.jsonl'))).toBe(true)
    expect(readFileSync(join(dir, JOURNAL_DIR, 'w1.jsonl'), 'utf8')).not.toContain('"host"')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('folderWithin', () => {
  it('shows a path inside the workspace folder relative, the folder as a dot and a path outside by its name', () => {
    expect(folderWithin('/work/shop/a/b', '/work/shop')).toBe('a/b')
    expect(folderWithin('/work/shop', '/work/shop')).toBe('.')
    expect(folderWithin('/work/shop-old/a', '/work/shop')).toBe('…/a')
    expect(folderWithin('/x/y', '')).toBe('…/y')
  })
})
