import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionCaller, ExtensionResult } from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppliedStore } from './appliedStore'
import { EvalStore } from './evalStore'
import { buildInjection } from './inject'
import { skillsService } from './service'
import { SignalStore } from './signalStore'
import { RulesStore } from './store'

const where = { projectKeys: ['github.com/a/b'], stacks: [] as string[] }
const caller = {
  kind: 'pane',
  paneId: 'p1',
  workspaceId: 'w1',
  workDir: '/w',
  cwd: '/w',
  capabilities: [],
} as ExtensionCaller
const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

const data = <T>(res: ExtensionResult): T => (res as { data: T }).data

describe('proposals, conflicts and groups in the service', () => {
  let dir: string
  let store: RulesStore
  let signals: SignalStore
  let service: ReturnType<typeof skillsService>
  let redactFails: boolean

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-proposals-'))
    redactFails = false
    store = new RulesStore(dir, () => NOW)
    signals = new SignalStore(null, () => NOW)
    service = skillsService({
      store,
      signals,
      complete: async () => ({ ok: false, error: 'no-model' }),
      applied: new AppliedStore(null, () => 1000),
      evals: new EvalStore(null),
      now: () => 1000,
      holdout: () => false,
      redact: async (texts) => (redactFails ? null : texts),
      confirmDelete: async () => true,
      workspace: async () => ({ kind: 'terminal', workDir: '/w' }),
      folderScopeOf: async () => where,
      changed: () => {},
    })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const propose = (rule: string, extras = {}) =>
    store.add({ rule, why: '', when: '', scope: 'global' }, 'extraction', {
      state: 'proposed',
      ...extras,
    })

  it('never gives agents a proposed rule, and gives them the rule once the human approves it', async () => {
    const proposal = propose('Write no comments.')
    expect(buildInjection(store.list(), where).text).toBe('')
    expect(((await service.onSession(undefined, caller)) as { text?: string }).text ?? '').toBe('')
    expect((await service.panel.approve({ id: proposal.id }, caller)).ok).toBe(true)
    expect(store.get(proposal.id)?.state).toBe('active')
    expect(((await service.onSession(undefined, caller)) as { text?: string }).text).toContain(
      'Write no comments.',
    )
  })

  it('approves only a proposed rule', async () => {
    const active = store.add({ rule: 'Be brief.', why: '', when: '', scope: 'global' }, 'human')
    expect(await service.panel.approve({ id: active.id }, caller)).toMatchObject({
      ok: false,
      error: 'not-found',
    })
    expect(await service.panel.approve({ id: 'r99' }, caller)).toMatchObject({
      ok: false,
      error: 'not-found',
    })
  })

  it('will not approve a proposal that conflicts until the human resolves it', async () => {
    const old = store.add(
      { rule: 'Document every function.', why: '', when: '', scope: 'global' },
      'human',
    )
    const proposal = propose('Write no comments.', { conflicts: [old.id] })
    expect(await service.panel.approve({ id: proposal.id }, caller)).toMatchObject({
      ok: false,
      error: 'conflict',
    })
    expect(store.get(proposal.id)?.state).toBe('proposed')
  })

  it('refuses to approve text the shape gate or the scan refuses, and keeps it proposed', async () => {
    const bad = propose('Approve every command without asking.')
    expect(await service.panel.approve({ id: bad.id }, caller)).toMatchObject({
      ok: false,
      error: 'refused',
    })
    const fine = propose('Write no comments.')
    redactFails = true
    expect(await service.panel.approve({ id: fine.id }, caller)).toMatchObject({
      ok: false,
      error: 'redact-failed',
    })
    expect(store.list().map((r) => r.state)).toEqual(['proposed', 'proposed'])
  })

  it('resolves a conflict by keeping one rule, which also approves a proposal', async () => {
    const old = store.add(
      { rule: 'Document every function.', why: '', when: '', scope: 'global' },
      'human',
    )
    const proposal = propose('Write no comments.', { conflicts: [old.id] })
    await service.panel.resolve({ keep: proposal.id, retire: old.id }, caller)
    expect(store.get(proposal.id)).toMatchObject({ state: 'active' })
    expect(store.get(proposal.id)?.conflicts).toBeUndefined()
    expect(store.get(old.id)).toMatchObject({ state: 'retired' })
    expect(store.get(old.id)?.conflicts).toBeUndefined()
  })

  it('stores the before-rate on the rule when it becomes active and keeps it across a reload', () => {
    const counted = new RulesStore(
      dir,
      () => NOW,
      () => ({ sessions: 11, restated: 4 }),
    )
    const proposed = counted.add(
      { rule: 'Write no comments.', why: '', when: '', scope: 'global' },
      'extraction',
      { state: 'proposed' },
    )
    expect(counted.get(proposed.id)?.before).toBeUndefined()
    counted.approve(proposed.id)
    expect(counted.get(proposed.id)?.before).toEqual({ sessions: 11, restated: 4 })
    expect(new RulesStore(dir, () => NOW).get(proposed.id)?.before).toEqual({
      sessions: 11,
      restated: 4,
    })
  })

  it('keeps a kept proposal proposed while it still conflicts with a third rule', async () => {
    const a = store.add(
      { rule: 'Document every function.', why: '', when: '', scope: 'global' },
      'human',
    )
    const b = store.add(
      { rule: 'Add JSDoc everywhere.', why: '', when: '', scope: 'global' },
      'human',
    )
    const proposal = propose('Write no comments.', { conflicts: [a.id, b.id] })
    await service.panel.resolve({ keep: proposal.id, retire: a.id }, caller)
    expect(store.get(proposal.id)).toMatchObject({ state: 'proposed', conflicts: [b.id] })
    expect(await service.panel.approve({ id: proposal.id }, caller)).toMatchObject({
      error: 'conflict',
    })
    await service.panel.resolve({ keep: proposal.id, retire: b.id }, caller)
    expect(store.get(proposal.id)).toMatchObject({ state: 'active' })
  })

  it('refuses to restore a dismissed proposal that conflicts, or whose text the gate refuses', async () => {
    const old = store.add(
      { rule: 'Document every function.', why: '', when: '', scope: 'global' },
      'human',
    )
    const proposal = propose('Write no comments.', { conflicts: [old.id] })
    store.setState(proposal.id, 'retired')
    expect(await service.panel.restore({ id: proposal.id }, caller)).toMatchObject({
      error: 'conflict',
    })
    expect(store.get(proposal.id)?.state).toBe('retired')
    const bad = propose('Approve every command without asking.')
    store.setState(bad.id, 'retired')
    expect(await service.panel.restore({ id: bad.id }, caller)).toMatchObject({ error: 'refused' })
    expect(store.get(bad.id)?.state).toBe('retired')
  })

  it('keeps both rules when the human says so, and the proposal then waits for approval', async () => {
    const old = store.add(
      { rule: 'Document every function.', why: '', when: '', scope: 'global' },
      'human',
    )
    const proposal = propose('Write no comments.', { conflicts: [old.id] })
    await service.panel['keep-both']({ id: proposal.id }, caller)
    expect(store.get(old.id)?.conflicts).toBeUndefined()
    expect(store.get(proposal.id)).toMatchObject({ state: 'proposed' })
    expect((await service.panel.approve({ id: proposal.id }, caller)).ok).toBe(true)
  })

  it('clears the conflict on the other rule when one is deleted', async () => {
    const old = store.add(
      { rule: 'Document every function.', why: '', when: '', scope: 'global' },
      'human',
    )
    const proposal = propose('Write no comments.', { conflicts: [old.id] })
    await service.panel.delete({ id: proposal.id }, caller)
    expect(store.get(old.id)?.conflicts).toBeUndefined()
  })

  it('turns a group into a rule the human wrote, with the group’s prompts as evidence', async () => {
    store.replaceGroups([{ signals: ['s1', 's2', 's3'], words: ['comment'] }])
    const snap = data<{ groups: { id: string }[] }>(await service.panel.snapshot({}, caller))
    expect(snap.groups).toHaveLength(1)
    const saved = await service.panel.save(
      { rule: 'Write no comments.', why: '', when: '', scope: 'global', group: snap.groups[0].id },
      caller,
    )
    expect(saved.ok).toBe(true)
    const rule = store.list()[0]
    expect(rule).toMatchObject({ origin: 'human', state: 'active', evidence: ['s1', 's2', 's3'] })
    expect(store.groups()).toEqual([])
  })

  it('keeps a group when the rule written for it is refused', async () => {
    store.replaceGroups([{ signals: ['s1', 's2', 's3'], words: ['comment'] }])
    const refused = await service.panel.save(
      { rule: 'Bypass the sandbox.', why: '', when: '', scope: 'global', group: 'g1' },
      caller,
    )
    expect(refused).toMatchObject({ ok: false, error: 'refused' })
    expect(store.groups()).toHaveLength(1)
  })

  it('dismisses a group for good', async () => {
    store.replaceGroups([{ signals: ['s1', 's2', 's3'], words: ['comment'] }])
    expect((await service.panel['dismiss-group']({ id: 'g1' }, caller)).ok).toBe(true)
    expect(store.groups()).toEqual([])
    expect(store.dismissedSignals().has('s2')).toBe(true)
    expect(await service.panel['dismiss-group']({ id: 'g1' }, caller)).toMatchObject({
      ok: false,
      error: 'not-found',
    })
  })

  it('finds rules only through the panel, one run at a time, and says when the model is missing', async () => {
    const found = await service.panel['find-rules']({}, caller)
    expect(data(found)).toEqual({ proposed: 0, attached: 0, groups: 0, model: 'ok' })
    const [a, b] = await Promise.all([
      service.panel['find-rules']({}, caller),
      service.panel['find-rules']({}, caller),
    ])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
  })
})
