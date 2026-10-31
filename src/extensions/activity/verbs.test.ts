import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionCaller, ExtensionResult } from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JOURNAL_DIR, Journal } from './journal'
import { RememberStore } from './remember'
import { rememberVerbs } from './rememberVerbs'
import { activityVerbs, type Entry } from './verbs'

const NOW = Date.UTC(2026, 9, 14, 12)

function pane(paneId: string, workspaceId: string, extra: Partial<ExtensionCaller> = {}) {
  return {
    kind: 'pane',
    paneId,
    workspaceId,
    workDir: '/w',
    cwd: '/w/src',
    capabilities: ['read-board'],
    ...extra,
  } as ExtensionCaller
}

describe('ostia activity verbs', () => {
  let dir: string
  let journal: Journal
  let redact: (texts: string[]) => Promise<string[] | null>
  let changes: number
  const kinds: Record<string, string> = { w1: 'terminal', w2: 'terminal', sc1: 'scratch' }
  const verbs = () =>
    activityVerbs({
      journal,
      now: () => NOW,
      redact: (texts) => redact(texts),
      workspaceKind: async (id) => kinds[id] ?? null,
      changed: () => {
        changes++
      },
      remembered: rememberVerbs({
        store: new RememberStore({ dir: null, now: () => NOW }),
        now: () => NOW,
        redact: async (texts) => texts,
        workspaceKind: async (id) => kinds[id] ?? null,
        paneSession: async () => null,
        changed: () => {},
      }),
    })
  const run = (verb: string, argv: string[], caller: ExtensionCaller): Promise<ExtensionResult> =>
    Promise.resolve(verbs()[verb]?.({ argv }, caller)) as Promise<ExtensionResult>
  const data = <T>(res: ExtensionResult): T => (res as { data: T }).data
  const add = async (text: string, caller: ExtensionCaller, ...flags: string[]) => {
    const res = await run('add', [text, ...flags], caller)
    if (!res.ok) throw new Error(`${res.error}: ${res.message}`)
    return data<Entry>(res)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-activity-verbs-'))
    journal = new Journal({ dir, now: () => NOW })
    redact = async (texts) => texts.map((t) => t.replace(/sk_live_\w+/g, '[redacted]'))
    changes = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('adds a redacted needs-you note from the calling pane and answers with the id it read back', async () => {
    const res = await run(
      'add',
      ['Set', 'STRIPE_KEY=sk_live_abc123', '--needs-you', '--link', 'docs/setup.md'],
      pane('p1', 'w1'),
    )
    expect(res.ok).toBe(true)
    const entry = data<Entry>(res)
    expect((res as { text: string }).text).toBe(entry.id)
    expect(entry).toMatchObject({
      kind: 'note',
      pane: 'p1',
      text: 'Set STRIPE_KEY=[redacted]',
      needsYou: true,
      link: '/w/src/docs/setup.md',
      time: new Date(NOW).toISOString(),
    })
    expect(journal.openNeedsYou('w1').map((n) => n.id)).toEqual([entry.id])
    expect(readFileSync(join(dir, JOURNAL_DIR, 'w1.jsonl'), 'utf8')).not.toContain('sk_live')
    expect(changes).toBe(1)
  })

  it('stores nothing when the secret scan fails, and says so', async () => {
    redact = async () => null
    const res = await run('add', ['token sk_live_abc', '--needs-you'], pane('p1', 'w1'))
    expect(res).toMatchObject({ ok: false, error: 'redaction-failed' })
    redact = async () => {
      throw new Error('scan died')
    }
    expect(await run('add', ['again'], pane('p1', 'w1'))).toMatchObject({
      ok: false,
      error: 'redaction-failed',
    })
    expect(journal.events('w1')).toEqual([])
    expect(changes).toBe(0)
  })

  it('refuses an empty or oversized text, an unknown option, a bad link and a caller that is not a pane', async () => {
    const caller = pane('p1', 'w1')
    expect(await run('add', [], caller)).toMatchObject({ ok: false, error: 'usage' })
    expect(await run('add', ['x'.repeat(2001)], caller)).toMatchObject({
      ok: false,
      error: 'too-long',
    })
    expect(await run('add', ['hi', '--tab', 'x'], caller)).toMatchObject({
      ok: false,
      error: 'usage',
      message: expect.stringContaining('unknown option --tab'),
    })
    expect(await run('add', ['hi', '--link', 'javascript:alert(1)'], caller)).toMatchObject({
      ok: false,
      error: 'usage',
    })
    expect(
      await run('add', ['hi'], { kind: 'user', workspaceId: 'w1', capabilities: [] }),
    ).toMatchObject({ ok: false, error: 'not-available' })
    expect(journal.events('w1')).toEqual([])
  })

  it('lists and shows only the caller’s workspace, another one only with all-workspaces', async () => {
    const mine = await add('mine', pane('p1', 'w1'), '--needs-you')
    const theirs = await add('theirs', pane('p2', 'w2'))
    const listed = await run('list', ['--json'], pane('p1', 'w1'))
    expect(data<Entry[]>(listed).map((e) => e.id)).toEqual([mine.id])
    expect(await run('show', [theirs.id], pane('p1', 'w1'))).toMatchObject({
      ok: false,
      error: 'unknown-entry',
    })
    expect(await run('list', ['--workspace', 'w2'], pane('p1', 'w1'))).toMatchObject({
      ok: false,
      error: 'needs-elevation',
      message: 'all-workspaces',
    })
    expect(
      await run(
        'list',
        ['--workspace', 'w2'],
        pane('p1', 'w1', { capabilities: ['all-workspaces'], sandboxed: true }),
      ),
    ).toMatchObject({ ok: false, error: 'needs-elevation' })
    const elevated = pane('p1', 'w1', { capabilities: ['all-workspaces'] })
    const other = await run('list', ['--workspace', 'w2', '--json'], elevated)
    expect(data<Entry[]>(other).map((e) => e.text)).toEqual(['theirs'])
    const shown = await run('show', [theirs.id, '--workspace', 'w2'], elevated)
    expect((shown as { text: string }).text).toContain('theirs')
  })

  it('filters by needs-you, open and since, and prints one line per entry', async () => {
    const caller = pane('p1', 'w1')
    const open = await add('check the report', caller, '--needs-you')
    const closed = await add('rotate the key', caller, '--needs-you')
    await add('refactored the parser', caller)
    await run('done', [closed.id], caller)
    const ids = async (...flags: string[]) =>
      data<Entry[]>(await run('list', [...flags, '--json'], caller)).map((e) => e.id)
    expect(await ids('--needs-you')).toEqual([open.id, closed.id])
    expect(await ids('--open')).toEqual([open.id])
    expect(await ids('--since', '1h')).toHaveLength(3)
    expect(await ids('--since', '2030-01-01T00:00')).toEqual([])
    expect(await run('list', ['--since', 'yesterday-ish'], caller)).toMatchObject({
      ok: false,
      error: 'usage',
    })
    const text = (await run('list', ['--needs-you'], caller)) as { text: string }
    expect(text.text.split('\n')).toEqual([
      `${open.id}\t${open.time}\tneeds-you\tcheck the report`,
      `${closed.id}\t${closed.time}\tneeds-you done\trotate the key`,
    ])
  })

  it('lets an agent mark only its own needs-you item done, and answers with the state it read back', async () => {
    const mine = await add('review the migration', pane('p1', 'w1'), '--needs-you')
    const note = await add('just a note', pane('p1', 'w1'))
    const other = await add('their item', pane('p2', 'w1'), '--needs-you')
    expect(await run('done', [other.id], pane('p1', 'w1'))).toMatchObject({
      ok: false,
      error: 'not-yours',
    })
    expect(await run('done', [note.id], pane('p1', 'w1'))).toMatchObject({
      ok: false,
      error: 'not-needs-you',
    })
    expect(await run('done', ['zzzzzzzzzz'], pane('p1', 'w1'))).toMatchObject({
      ok: false,
      error: 'unknown-entry',
    })
    const done = await run('done', [mine.id], pane('p1', 'w1'))
    expect(done).toMatchObject({ ok: true, text: `${mine.id} done`, data: { done: true } })
    expect(journal.openNeedsYou('w1').map((n) => n.id)).toEqual([other.id])
  })

  it('keeps a scratch or sandboxed workspace’s notes in memory only', async () => {
    await add('scratch note', pane('p3', 'sc1'), '--needs-you')
    await add('sandboxed note', pane('p4', 'w2', { sandboxed: true }))
    expect(journal.keepsOnDisk('sc1')).toBe(false)
    expect(journal.keepsOnDisk('w2')).toBe(false)
    expect(journal.openNeedsYou('sc1')).toHaveLength(1)
    const reloaded = new Journal({ dir, now: () => NOW })
    reloaded.load()
    expect(reloaded.workspaceIds()).toEqual([])
  })

  it('reads the archive with --archived', async () => {
    const caller = pane('p1', 'w1')
    const old = await add('last month', caller)
    const later = new Journal({
      dir,
      now: () => NOW + 10,
      retention: { liveMs: 1, archiveMs: 365 * 86_400_000 },
    })
    later.load()
    journal = later
    expect(data<Entry[]>(await run('list', ['--json'], caller))).toEqual([])
    const archived = data<Entry[]>(await run('list', ['--archived', '--json'], caller))
    expect(archived.map((e) => e.id)).toEqual([old.id])
    expect(await run('show', [old.id], caller)).toMatchObject({ ok: true })
  })
})
