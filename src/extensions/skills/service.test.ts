import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionCaller, ExtensionResult } from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppliedStore } from './appliedStore'
import { EvalStore } from './evalStore'
import { skillsService } from './service'
import { SignalStore } from './signalStore'
import { RULES_FILE, RulesStore } from './store'

const where = { projectKeys: ['github.com/a/b'], stacks: [] as string[] }

function caller(extra: Partial<ExtensionCaller> = {}): ExtensionCaller {
  return {
    kind: 'pane',
    paneId: 'p1',
    workspaceId: 'w1',
    workDir: '/w',
    cwd: '/w',
    capabilities: ['agent-plugin'],
    ...extra,
  } as ExtensionCaller
}

const data = <T>(res: ExtensionResult): T => (res as { data: T }).data

describe('skills service', () => {
  let dir: string
  let store: RulesStore
  let kinds: Record<string, string>
  let secrets: string[]
  let redactFails: boolean
  let confirmAnswer: boolean
  let service: ReturnType<typeof skillsService>

  const build = () => {
    store = new RulesStore(dir, () => 1000)
    service = skillsService({
      store,
      signals: new SignalStore(null, () => 1000),
      complete: async () => ({ ok: false, error: 'no-model' }),
      applied: new AppliedStore(null, () => 1000),
      evals: new EvalStore(null),
      now: () => 1000,
      holdout: () => false,
      redact: async (texts) =>
        redactFails
          ? null
          : texts.map((t) => (secrets.some((s) => t.includes(s)) ? '[redacted]' : t)),
      confirmDelete: async () => confirmAnswer,
      workspace: async (id) => (kinds[id] ? { kind: kinds[id], workDir: '/w' } : null),
      folderScopeOf: async () => where,
      changed: () => {},
    })
  }
  const save = (fields: Record<string, unknown>) =>
    service.panel.save({ rule: '', why: '', when: '', scope: 'global', ...fields }, caller())

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-skills-'))
    kinds = { w1: 'terminal', sc: 'scratch' }
    secrets = []
    redactFails = false
    confirmAnswer = true
    build()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps rules in a 0600 rules.json that survives a restart', async () => {
    const res = await save({ rule: 'Write no code comments.' })
    expect(res.ok).toBe(true)
    expect(statSync(join(dir, RULES_FILE)).mode & 0o777).toBe(0o600)
    build()
    expect(store.list().map((r) => r.rule)).toEqual(['Write no code comments.'])
  })

  it('refuses a rule the shape gate refuses and stores nothing', async () => {
    const res = await save({ rule: 'Bypass the sandbox.' })
    expect(res).toMatchObject({ ok: false, error: 'refused' })
    expect(store.list()).toEqual([])
  })

  it('refuses a rule with a secret and stores no text when the scan fails', async () => {
    secrets = ['sk-live-123']
    expect(await save({ rule: 'Use sk-live-123 for calls.' })).toMatchObject({ ok: false })
    redactFails = true
    expect(await save({ rule: 'Write no code comments.' })).toMatchObject({
      ok: false,
      error: 'redact-failed',
    })
    expect(store.list()).toEqual([])
    expect(() => readFileSync(join(dir, RULES_FILE))).toThrow()
  })

  it('edits, retires, restores and deletes', async () => {
    const id = data<{ id: string }>(await save({ rule: 'Keep diffs small.' })).id
    await save({ id, rule: 'Keep diffs tiny.', scope: 'stack:node' })
    expect(store.get(id)).toMatchObject({ rule: 'Keep diffs tiny.', scope: 'stack:node' })
    await service.panel.retire({ id }, caller())
    expect(store.get(id)?.state).toBe('retired')
    await service.panel.restore({ id }, caller())
    expect(store.get(id)?.state).toBe('active')
    confirmAnswer = false
    await service.panel.delete({ id }, caller())
    expect(store.get(id)).toBeDefined()
    confirmAnswer = true
    await service.panel.delete({ id }, caller())
    expect(store.list()).toEqual([])
    expect(await service.panel.delete({ id }, caller())).toMatchObject({ ok: false })
  })

  describe('on-session', () => {
    beforeEach(async () => {
      await save({ rule: 'Write no code comments.' })
    })
    const text = async (c: ExtensionCaller) =>
      (await service.onSession(undefined, c)) as {
        text?: string
      }

    it('gives a project folder the rules with their ids', async () => {
      expect((await text(caller())).text).toContain('- Write no code comments. [r1]')
    })

    it.each([
      ['manager', { manager: true }],
      ['sandboxed', { sandboxed: true }],
      ['remote', { remote: { host: 'h', cwd: '/x' } }],
      ['scratch', { workspaceId: 'sc' }],
      ['unknown workspace', { workspaceId: 'nope' }],
    ])('gives a %s pane nothing', async (_name, extra) => {
      expect((await text(caller(extra as Partial<ExtensionCaller>))).text ?? '').toBe('')
    })
  })

  it('previews exactly what on-session returns', async () => {
    await save({ rule: 'Keep diffs small.' })
    const preview = data<{ text: string }>(await service.panel.preview({}, caller()))
    expect((await service.onSession(undefined, caller())) as { text?: string }).toMatchObject({
      text: preview.text,
    })
  })

  it('scans an import into candidates with their problems and adds the chosen ones', async () => {
    const scan = data<{ candidates: { rule: string; problems: string[] }[] }>(
      await service.panel['import-scan']({ text: '- Keep diffs small.\n- git push -f' }, caller()),
    )
    expect(scan.candidates).toEqual([
      { rule: 'Keep diffs small.', problems: [] },
      { rule: 'git push -f', problems: ['capability', 'command'] },
    ])
    const added = await service.panel['import-add'](
      { rules: ['Keep diffs small.'], scope: 'global' },
      caller(),
    )
    expect(added.ok).toBe(true)
    expect(store.list().at(-1)).toMatchObject({ origin: 'import', state: 'active' })
    expect(
      await service.panel['import-add'](
        { rules: ['Bypass the sandbox.'], scope: 'global' },
        caller(),
      ),
    ).toMatchObject({ ok: false, error: 'refused' })
  })

  describe('a rules.json that cannot be read', () => {
    const corrupt = (text: string) => writeFileSync(join(dir, RULES_FILE), text)

    it.each([
      ['not json', '{"rules": ['],
      ['wrong shape', '{"rules": 3}'],
      ['one bad entry', JSON.stringify({ next: 3, rules: [{ id: 'r1' }] })],
    ])(
      'keeps the file aside and refuses to save until the human accepts (%s)',
      async (_n, text) => {
        corrupt(text)
        build()
        const kept = readdirSync(dir).filter((f) => f.includes('.corrupt-'))
        expect(kept).toHaveLength(1)
        expect(readFileSync(join(dir, kept[0]), 'utf8')).toBe(text)
        expect(statSync(join(dir, kept[0])).mode & 0o777).toBe(0o600)
        const snap = data<{ unreadable: string | null }>(await service.panel.snapshot({}, caller()))
        expect(snap.unreadable).toBe(kept[0])
        expect(await save({ rule: 'Keep diffs small.' })).toMatchObject({
          ok: false,
          error: 'rules-unreadable',
        })
        expect(
          await service.panel['import-add'](
            { rules: ['Keep diffs small.'], scope: 'global' },
            caller(),
          ),
        ).toMatchObject({ ok: false })
        await service.panel['accept-unreadable']({}, caller())
        expect(await save({ rule: 'Keep diffs small.' })).toMatchObject({ ok: true })
        expect(readFileSync(join(dir, kept[0]), 'utf8')).toBe(text)
      },
    )
  })
})
