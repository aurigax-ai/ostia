import { type Candidate, candidateGroups } from './grouping'
import { containment, keywords } from './keywords'
import { PHRASING_SYSTEM, parsePhrasing, phrasingInput } from './phrasing'
import type { Rule, RuleDraft } from './rule'
import type { Signal } from './signal'
import type { RulesStore } from './store'

export const MODEL_CALLS_MAX = 8
const DUPLICATE_SHARE = 0.5

export type Complete = (
  system: string,
  input: string,
) => Promise<{ ok: true; text: string } | { ok: false; error: string }>

export interface ExtractDeps {
  store: RulesStore
  signals: () => Signal[]
  complete: Complete
  check: (draft: RuleDraft) => Promise<{ problems: string[] } | null>
}

export interface FindResult {
  proposed: number
  attached: number
  groups: number
  model: 'ok' | 'none' | 'failed'
}

function matching(candidate: Candidate, rules: readonly Rule[]): Rule | undefined {
  const ids = new Set(candidate.signals.map((s) => s.id))
  const topic = new Set(candidate.topic)
  return rules.find(
    (rule) =>
      rule.evidence?.some((id) => ids.has(id)) ||
      containment(topic, keywords(`${rule.rule} ${rule.when}`)) >= DUPLICATE_SHARE,
  )
}

export async function findRules(deps: ExtractDeps): Promise<FindResult> {
  const { store, complete, check } = deps
  const skipped = store.dismissedSignals()
  const signals = deps.signals().filter((s) => !skipped.has(s.id))
  const result: FindResult = { proposed: 0, attached: 0, groups: 0, model: 'ok' }
  const unphrased: Candidate[] = []
  let calls = 0
  for (const candidate of candidateGroups(signals)) {
    const ids = candidate.signals.map((s) => s.id)
    const home = matching(candidate, store.list())
    if (home) {
      if (home.state !== 'retired' && ids.some((id) => !home.evidence?.includes(id))) {
        store.addEvidence(home.id, ids)
        result.attached += 1
      }
      continue
    }
    if (result.model !== 'ok' || calls >= MODEL_CALLS_MAX) {
      unphrased.push(candidate)
      continue
    }
    calls += 1
    const existing = store.list().filter((r) => r.state !== 'retired')
    const answer = await complete(
      PHRASING_SYSTEM,
      phrasingInput(
        candidate.signals.map((s) => s.text),
        candidate.scope,
        existing.map((r) => ({ id: r.id, rule: r.rule })),
      ),
    ).catch(() => ({ ok: false as const, error: 'failed' }))
    if (!answer.ok) {
      result.model = answer.error === 'no-model' ? 'none' : 'failed'
      unphrased.push(candidate)
      continue
    }
    const phrasing = parsePhrasing(answer.text, new Set(existing.map((r) => r.id)))
    const draft = phrasing && {
      rule: phrasing.rule,
      why: phrasing.why,
      when: phrasing.when,
      scope: candidate.scope,
    }
    const checked = draft ? await check(draft) : null
    if (!phrasing || !draft || !checked || checked.problems.length > 0) {
      unphrased.push(candidate)
      continue
    }
    const same = phrasing.sameAs ? store.get(phrasing.sameAs) : undefined
    if (same) {
      store.addEvidence(same.id, ids)
      result.attached += 1
      continue
    }
    store.add(draft, 'extraction', {
      state: 'proposed',
      evidence: ids,
      conflicts: phrasing.conflictsWith ? [phrasing.conflictsWith] : [],
    })
    result.proposed += 1
  }
  store.replaceGroups(
    unphrased.map((c) => ({ signals: c.signals.map((s) => s.id), words: c.words })),
  )
  result.groups = unphrased.length
  return result
}
