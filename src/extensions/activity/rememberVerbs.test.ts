import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CommandHandler,
  ExtensionCaller,
  ExtensionResult,
} from '@aurigax-ai/ostia-extension-sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { Journal } from './journal'
import { RememberStore } from './remember'
import { REMEMBER_OPEN_MAX } from './rememberItem'
import { rememberVerbs } from './rememberVerbs'
import { activityVerbs } from './verbs'

const NOW = Date.UTC(2026, 9, 14, 12)

function pane(paneId: string, extra: Partial<ExtensionCaller> = {}): ExtensionCaller {
  return {
    kind: 'pane',
    paneId,
    workspaceId: 'w1',
    capabilities: [],
    ...extra,
  } as ExtensionCaller
}

describe('ostia activity remember', () => {
  let store: RememberStore
  let sessions: Record<string, { agent: string; session: string } | null>
  let changes: number
  let redact: (texts: string[]) => Promise<string[] | null>
  const verbs = (): Record<string, CommandHandler> => {
    const remembered = rememberVerbs({
      store,
      now: () => NOW,
      redact: (texts) => redact(texts),
      workspaceKind: async () => 'terminal',
      paneSession: async (id) => sessions[id] ?? null,
      changed: () => {
        changes++
      },
    })
    return {
      remember: remembered.remember,
      ...activityVerbs({
        journal: new Journal({ dir: null, now: () => NOW }),
        now: () => NOW,
        redact: async (texts) => texts,
        workspaceKind: async () => 'terminal',
        changed: () => {},
        remembered,
      }),
    }
  }
  const run = (verb: string, argv: string[], caller: ExtensionCaller) =>
    Promise.resolve(verbs()[verb]?.({ argv }, caller)) as Promise<ExtensionResult>
  const idOf = (res: ExtensionResult) => (res as { data: { id: string } }).data.id

  beforeEach(() => {
    store = new RememberStore({ dir: null, now: () => NOW })
    sessions = { p1: { agent: 'claude', session: 's1' }, p2: { agent: 'codex', session: 's2' } }
    changes = 0
    redact = async (texts) => texts.map((t) => t.replace(/sk_live_\w+/g, '[redacted]'))
  })

  it('keeps a redacted one-line task for the calling pane’s session and prints its id', async () => {
    const res = await run('remember', ['Rotate', 'sk_live_abc123\nkey'], pane('p1'))
    expect(res).toMatchObject({ ok: true, text: `remembered ${idOf(res)}` })
    const [item] = store.items('w1')
    expect(item).toMatchObject({
      text: 'Rotate [redacted] key',
      session: 's1',
      agent: 'claude',
      pane: 'p1',
      state: 'open',
    })
    expect(changes).toBe(1)
  })

  it('answers the same id for a task it already holds open', async () => {
    const first = await run('remember', ['Bisect fixtures'], pane('p1'))
    const again = await run('remember', ['Bisect fixtures'], pane('p1'))
    expect(idOf(again)).toBe(idOf(first))
    expect(store.items('w1')).toHaveLength(1)
  })

  it('refuses a missing task, an unknown option, a long task and a pane with no session', async () => {
    expect(await run('remember', [], pane('p1'))).toMatchObject({ ok: false, error: 'usage' })
    expect(await run('remember', ['--pane', 'p2'], pane('p1'))).toMatchObject({
      ok: false,
      error: 'usage',
    })
    expect(await run('remember', ['x'.repeat(201)], pane('p1'))).toMatchObject({
      ok: false,
      error: 'too-long',
    })
    expect(await run('remember', ['a task'], pane('p9'))).toMatchObject({
      ok: false,
      error: 'no-session',
    })
    expect(store.items('w1')).toEqual([])
  })

  it('refuses a caller that is not an agent’s own pane', async () => {
    const user = { kind: 'user', workspaceId: 'w1', capabilities: [] } as ExtensionCaller
    expect(await run('remember', ['a task'], user)).toMatchObject({
      ok: false,
      error: 'not-available',
    })
    expect(await run('remember', ['a task'], pane('p1', { manager: true }))).toMatchObject({
      ok: false,
      error: 'not-available',
    })
  })

  it('stores nothing when the secret scan fails', async () => {
    redact = async () => null
    expect(await run('remember', ['a task'], pane('p1'))).toMatchObject({
      ok: false,
      error: 'redaction-failed',
    })
    expect(store.items('w1')).toEqual([])
  })

  it('stops at the open limit', async () => {
    for (let i = 0; i < REMEMBER_OPEN_MAX; i++) await run('remember', [`task ${i}`], pane('p1'))
    expect(await run('remember', ['one more'], pane('p1'))).toMatchObject({
      ok: false,
      error: 'too-many',
    })
  })

  it('lists only the caller’s session, newest first, as tab-separated lines', async () => {
    await run('remember', ['first'], pane('p1'))
    await run('remember', ['other session'], pane('p2'))
    const res = await run('list', ['--remembered'], pane('p1'))
    expect(res.ok).toBe(true)
    const lines = (res as { text: string }).text.split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.split('\t').slice(1)).toEqual(['now', 'first'])
    const json = await run('list', ['--remembered', '--json'], pane('p1'))
    expect((json as { data: unknown[] }).data).toHaveLength(1)
  })

  it('says there are no entries, and refuses a workspace or since filter', async () => {
    expect(await run('list', ['--remembered'], pane('p1'))).toMatchObject({
      ok: true,
      text: 'no entries',
    })
    expect(await run('list', ['--remembered', '--workspace', 'w2'], pane('p1'))).toMatchObject({
      ok: false,
      error: 'usage',
    })
  })

  it('lets an agent finish its own task but not another session’s', async () => {
    const mine = idOf(await run('remember', ['mine'], pane('p1')))
    const theirs = idOf(await run('remember', ['theirs'], pane('p2')))
    expect(await run('done', [theirs], pane('p1'))).toMatchObject({ ok: false, error: 'not-yours' })
    expect(await run('done', [mine], pane('p1'))).toMatchObject({ ok: true, text: `${mine} done` })
    expect(store.find('w1', mine)?.state).toBe('done')
    expect(store.find('w1', theirs)?.state).toBe('open')
    expect(await run('list', ['--remembered'], pane('p1'))).toMatchObject({ text: 'no entries' })
  })

  it('leaves done to the human for a caller that is not a pane', async () => {
    const mine = idOf(await run('remember', ['mine'], pane('p1')))
    const user = { kind: 'user', workspaceId: 'w1', capabilities: [] } as ExtensionCaller
    expect(await run('done', [mine], user)).toMatchObject({ ok: false, error: 'not-available' })
  })
})

describe('remember hardening', () => {
  it('collapses control, format and bidi characters of a task to spaces', async () => {
    const store = new RememberStore({ dir: null, now: () => NOW })
    const remembered = rememberVerbs({
      store,
      now: () => NOW,
      redact: async (texts) => texts,
      workspaceKind: async () => 'terminal',
      paneSession: async () => ({ agent: 'claude', session: 's1' }),
      changed: () => {},
    })
    const res = await remembered.remember(
      { argv: ['a\u202Eb\u200Bc\u0085d\u2028e', 'f'] },
      pane('p1'),
    )
    expect(res).toMatchObject({ ok: true })
    expect(store.items('w1')[0]?.text).toBe('a b c d e f')
  })

  it('never takes a store that is already on disk off the disk because the workspace kind is unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ostia-remember-kind-'))
    try {
      const store = new RememberStore({ dir, now: () => NOW })
      const make = (kind: string | null) =>
        rememberVerbs({
          store,
          now: () => NOW,
          redact: async (texts) => texts,
          workspaceKind: async () => kind,
          paneSession: async () => ({ agent: 'claude', session: 's1' }),
          changed: () => {},
        })
      await make('terminal').remember({ argv: ['first task'] }, pane('p1'))
      const file = join(dir, 'remember', 'w1.json')
      expect(existsSync(file)).toBe(true)
      await make(null).remember({ argv: ['second task'] }, pane('p1'))
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8')).toContain('second task')
      await make('terminal').remember({ argv: ['third task'] }, pane('p1', { sandboxed: true }))
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps a new workspace of an unknown kind in memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ostia-remember-kind-'))
    try {
      const store = new RememberStore({ dir, now: () => NOW })
      const remembered = rememberVerbs({
        store,
        now: () => NOW,
        redact: async (texts) => texts,
        workspaceKind: async () => null,
        paneSession: async () => ({ agent: 'claude', session: 's1' }),
        changed: () => {},
      })
      await remembered.remember({ argv: ['a task'] }, pane('p1'))
      expect(existsSync(join(dir, 'remember'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses done from a later session in the same pane or a pane with no session', async () => {
    const store = new RememberStore({ dir: null, now: () => NOW })
    const sessions: Record<string, { agent: string; session: string } | null> = {
      p1: { agent: 'claude', session: 's1' },
    }
    const remembered = rememberVerbs({
      store,
      now: () => NOW,
      redact: async (texts) => texts,
      workspaceKind: async () => 'terminal',
      paneSession: async (id) => sessions[id] ?? null,
      changed: () => {},
    })
    const res = await remembered.remember({ argv: ['mine'] }, pane('p1'))
    const id = (res as { data: { id: string } }).data.id
    sessions.p1 = { agent: 'claude', session: 's2' }
    expect(await remembered.done(id, pane('p1'))).toMatchObject({ ok: false, error: 'not-yours' })
    sessions.p1 = null
    expect(await remembered.done(id, pane('p1'))).toMatchObject({ ok: false, error: 'not-yours' })
    expect(store.find('w1', id)?.state).toBe('open')
  })
})
