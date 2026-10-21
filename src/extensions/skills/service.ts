import {
  cliArgs,
  type ExtensionCaller,
  type ExtensionResult,
  failure,
  namedArgs,
  ok,
} from '@aurigax-ai/ostia-extension-sdk'
import type { AppliedStore } from './appliedStore'
import { CASES_PER_RULE_MAX, MIN_EVAL_CASES, parseCaseInput } from './evalCase'
import { DRAFT_SYSTEM, draftInput, parseDrafts } from './evalDraft'
import { PAIRS_PER_CASE, runEval } from './evalRunner'
import type { EvalStore } from './evalStore'
import { type Complete, findRules } from './extract'
import { importCandidates } from './importLines'
import { buildInjection } from './inject'
import { isScope, type RuleDraft } from './rule'
import { type FolderScope, folderScope, projectScopeOf } from './scope'
import { scoreboard } from './scoreboard'
import { type ShapeProblem, shapeGate } from './shapeGate'
import type { SignalStore } from './signalStore'
import type { RulesStore } from './store'

interface WorkspaceInfo {
  kind: string
  workDir: string
}

export const HOLDOUT_SHARE = 0.1
const SESSION_PATTERN = /^[\w.:-]{1,128}$/

export interface SkillsDeps {
  store: RulesStore
  signals: SignalStore
  applied: AppliedStore
  evals: EvalStore
  complete: Complete
  now: () => number
  holdout: () => boolean
  random?: () => number
  redact: (texts: string[]) => Promise<string[] | null>
  workspace: (workspaceId: string) => Promise<WorkspaceInfo | null>
  confirmDelete: (rule: string, locale: string | undefined) => Promise<boolean>
  folderScopeOf?: (dir: string) => Promise<FolderScope>
  changed: () => void
}

export type SkillsCommand = (args: unknown, caller: ExtensionCaller) => Promise<ExtensionResult>

interface Checked {
  draft: RuleDraft
  problems: ShapeProblem[]
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function skillsService(deps: SkillsDeps): {
  onSession: SkillsCommand
  panel: Record<string, SkillsCommand>
} {
  const { store, redact, workspace, confirmDelete, changed } = deps
  let finding = false
  let running: { rule: string; done: number; total: number } | null = null
  let stopped = false
  let failedRun: { rule: string; error: string } | null = null
  const scopeOf = deps.folderScopeOf ?? folderScope

  const check = async (draft: RuleDraft): Promise<Checked | null> => {
    const texts = [draft.rule, draft.why, draft.when]
    const clean = await redact(texts)
    if (!clean) return null
    const secret = clean.some((t, i) => t !== texts[i])
    return { draft, problems: shapeGate(draft, { secret }) }
  }

  const draftOf = (args: unknown): RuleDraft | null => {
    const a = namedArgs(args)
    const scope = textOf(a.scope)
    if (!isScope(scope)) return null
    return { rule: textOf(a.rule), why: textOf(a.why), when: textOf(a.when), scope }
  }

  const unreadable = (): ExtensionResult | null =>
    store.unreadable ? failure('rules-unreadable', store.unreadable) : null

  const refusal = (checked: Checked | null): ExtensionResult | null => {
    if (!checked) return failure('redact-failed')
    return checked.problems.length > 0 ? failure('refused', checked.problems.join(',')) : null
  }

  const whereDir = async (caller: ExtensionCaller): Promise<string | null> => {
    if (caller.cwd ?? caller.workDir) return caller.cwd ?? caller.workDir ?? null
    const info = caller.workspaceId ? await workspace(caller.workspaceId) : null
    return info?.workDir || null
  }

  const injectionFor = async (dir: string) => buildInjection(store.list(), await scopeOf(dir))

  const sessionOf = (args: unknown): string => {
    try {
      const id = (JSON.parse(cliArgs(args)?.stdin ?? '') as { session_id?: unknown }).session_id
      return typeof id === 'string' && SESSION_PATTERN.test(id) ? id : ''
    } catch {
      return ''
    }
  }

  const onSession: SkillsCommand = async (args, caller) => {
    const info = caller.workspaceId ? await workspace(caller.workspaceId) : null
    if (!info || info.kind === 'scratch' || caller.manager || caller.sandboxed || caller.remote) {
      return ok()
    }
    const dir = await whereDir(caller)
    if (!dir) return ok()
    const where = await scopeOf(dir)
    const rules = store.list()
    const session = sessionOf(args)
    const prior = session ? deps.applied.list().find((a) => a.session === session) : undefined
    const random = deps.random ?? Math.random
    const held = prior
      ? prior.held
      : deps.holdout()
        ? buildInjection(rules, where)
            .included.filter(() => random() < HOLDOUT_SHARE)
            .map((r) => r.id)
        : []
    const given =
      held.length > 0
        ? buildInjection(
            rules.filter((r) => !held.includes(r.id)),
            where,
          )
        : buildInjection(rules, where)
    if (session && !prior && (given.included.length > 0 || held.length > 0)) {
      deps.applied.add({
        at: deps.now(),
        session,
        workspace: caller.workspaceId ?? '',
        rules: given.included.map((r) => r.id),
        held,
      })
    }
    return ok(given.text, { count: given.included.length })
  }

  const snapshot: SkillsCommand = async (_args, caller) => {
    const dir = await whereDir(caller)
    const where = dir ? await scopeOf(dir) : null
    return ok(undefined, {
      rules: store.list(),
      project: where ? projectScopeOf(where) : null,
      stacks: where?.stacks ?? [],
      unreadable: store.unreadable,
      groups: store.groups(),
    })
  }

  const save: SkillsCommand = async (args) => {
    const blocked = unreadable()
    if (blocked) return blocked
    const draft = draftOf(args)
    if (!draft) return failure('invalid-args')
    const refused = refusal(await check(draft))
    if (refused) return refused
    const id = textOf(namedArgs(args).id)
    if (id) {
      if (!store.update(id, draft)) return failure('not-found')
      changed()
      return ok(undefined, { id })
    }
    const group = store.takeGroup(textOf(namedArgs(args).group))
    const rule = store.add(draft, 'human', group ? { evidence: group.signals } : {})
    changed()
    return ok(undefined, { id: rule.id })
  }

  const approve: SkillsCommand = async (args) => {
    const blocked = unreadable()
    if (blocked) return blocked
    const rule = store.get(textOf(namedArgs(args).id))
    if (rule?.state !== 'proposed') return failure('not-found')
    if ((rule.conflicts?.length ?? 0) > 0) return failure('conflict')
    const refused = refusal(await check(rule))
    if (refused) return refused
    store.approve(rule.id)
    changed()
    return ok()
  }

  const resolve: SkillsCommand = async (args) => {
    const blocked = unreadable()
    if (blocked) return blocked
    const a = namedArgs(args)
    const keep = store.get(textOf(a.keep))
    const others = (keep?.conflicts ?? []).filter((id) => id !== textOf(a.retire))
    if (keep?.state === 'proposed' && others.length === 0) {
      const refused = refusal(await check(keep))
      if (refused) return refused
    }
    if (!store.resolve(textOf(a.keep), textOf(a.retire))) return failure('not-found')
    changed()
    return ok()
  }

  const restore: SkillsCommand = async (args) => {
    const blocked = unreadable()
    if (blocked) return blocked
    const rule = store.get(textOf(namedArgs(args).id))
    if (!rule) return failure('not-found')
    if ((rule.conflicts?.length ?? 0) > 0) return failure('conflict')
    const refused = refusal(await check(rule))
    if (refused) return refused
    store.setState(rule.id, 'active')
    changed()
    return ok()
  }

  const keepBoth: SkillsCommand = async (args) => {
    const blocked = unreadable()
    if (blocked) return blocked
    if (!store.keepBoth(textOf(namedArgs(args).id))) return failure('not-found')
    changed()
    return ok()
  }

  const dismissGroup: SkillsCommand = async (args) => {
    if (!store.dismissGroup(textOf(namedArgs(args).id))) return failure('not-found')
    changed()
    return ok()
  }

  const find: SkillsCommand = async () => {
    const blocked = unreadable()
    if (blocked) return blocked
    if (finding) return failure('busy')
    finding = true
    try {
      const result = await findRules({
        store,
        signals: () => deps.signals.list(),
        complete: deps.complete,
        check,
      })
      changed()
      return ok(undefined, result)
    } finally {
      finding = false
    }
  }

  const byId = (action: (id: string) => boolean, confirm = false): SkillsCommand => {
    return async (args, caller) => {
      const blocked = unreadable()
      if (blocked) return blocked
      const id = textOf(namedArgs(args).id)
      if (confirm && store.get(id) && !(await confirmed(id, caller))) return ok()
      if (!action(id)) return failure('not-found')
      changed()
      return ok()
    }
  }

  const confirmed = async (id: string, caller: ExtensionCaller): Promise<boolean> => {
    return confirmDelete(store.get(id)?.rule ?? '', caller.locale)
  }

  const acceptUnreadable: SkillsCommand = async () => {
    store.acceptUnreadable()
    changed()
    return ok()
  }

  const preview: SkillsCommand = async (_args, caller) => {
    const dir = await whereDir(caller)
    if (!dir) return ok(undefined, { text: '', included: [], cut: [] })
    const injection = await injectionFor(dir)
    return ok(undefined, {
      text: injection.text,
      included: injection.included.map((r) => r.id),
      cut: injection.cut.map((r) => r.id),
    })
  }

  const importScan: SkillsCommand = async (args) => {
    const lines = importCandidates(textOf(namedArgs(args).text))
    const candidates = []
    for (const line of lines) {
      const checked = await check({ rule: line, why: '', when: '', scope: 'global' })
      if (!checked) return failure('redact-failed')
      candidates.push({ rule: line, problems: checked.problems })
    }
    return ok(undefined, { candidates })
  }

  const importAdd: SkillsCommand = async (args) => {
    const blocked = unreadable()
    if (blocked) return blocked
    const a = namedArgs(args)
    const scope = textOf(a.scope)
    const items = Array.isArray(a.rules)
      ? a.rules.filter((r): r is string => typeof r === 'string')
      : []
    if (!isScope(scope) || items.length === 0) return failure('invalid-args')
    const checks: Checked[] = []
    for (const rule of items) {
      const refused = await check({ rule, why: '', when: '', scope })
      if (!refused || refused.problems.length > 0) return refusal(refused) ?? failure('refused')
      checks.push(refused)
    }
    for (const c of checks) store.add(c.draft, 'import')
    changed()
    return ok(undefined, { added: checks.length })
  }

  const board: SkillsCommand = async () =>
    ok(undefined, {
      scores: scoreboard({
        rules: store.list(),
        signals: deps.signals.list(),
        applied: deps.applied.list(),
        now: deps.now(),
      }),
      evals: {
        cases: deps.evals.listCases(),
        runs: deps.evals.listRuns(),
        running,
        failed: failedRun,
      },
    })

  const caseTexts = (input: { prompt: string; files: { content: string }[] }): string[] => [
    input.prompt,
    ...input.files.map((f) => f.content),
  ]

  const saveCase: SkillsCommand = async (args) => {
    const a = namedArgs(args)
    const rule = store.get(textOf(a.rule))
    const input = parseCaseInput(a)
    if (!rule || !input) return failure(rule ? 'invalid-args' : 'not-found')
    if (deps.evals.listCases().filter((c) => c.rule === rule.id).length >= CASES_PER_RULE_MAX) {
      return failure('too-many')
    }
    const texts = caseTexts(input)
    const clean = await redact(texts)
    if (!clean) return failure('redact-failed')
    if (clean.some((t, i) => t !== texts[i])) return failure('refused', 'secret')
    deps.evals.addCase(rule.id, input, 'human')
    changed()
    return ok()
  }

  const evalCaseById = (action: (id: string) => boolean): SkillsCommand => {
    return async (args) => {
      if (!action(textOf(namedArgs(args).id))) return failure('not-found')
      changed()
      return ok()
    }
  }

  const draftCases: SkillsCommand = async (args) => {
    const rule = store.get(textOf(namedArgs(args).rule))
    if (!rule) return failure('not-found')
    const room =
      CASES_PER_RULE_MAX - deps.evals.listCases().filter((c) => c.rule === rule.id).length
    if (room <= 0) return failure('too-many')
    const answer = await deps.complete(DRAFT_SYSTEM, draftInput(rule.rule)).catch(() => null)
    if (!answer?.ok) return failure(answer?.error ?? 'failed')
    let added = 0
    for (const input of parseDrafts(answer.text).slice(0, room)) {
      const texts = caseTexts(input)
      const clean = await redact(texts)
      if (!clean || clean.some((t, i) => t !== texts[i])) continue
      deps.evals.addCase(rule.id, input, 'model')
      added += 1
    }
    changed()
    return ok(undefined, { added })
  }

  const runTest: SkillsCommand = async (args) => {
    const rule = store.get(textOf(namedArgs(args).rule))
    if (rule?.state !== 'active') return failure('not-found')
    if (running) return failure('busy')
    const cases = deps.evals.listCases().filter((c) => c.rule === rule.id && c.accepted)
    if (cases.length < MIN_EVAL_CASES) return failure('few-cases')
    running = { rule: rule.id, done: 0, total: cases.length * PAIRS_PER_CASE * 2 }
    stopped = false
    failedRun = null
    changed()
    void runEval(rule, cases, {
      complete: deps.complete,
      random: deps.random ?? Math.random,
      now: deps.now,
      cancelled: () => stopped,
      progress: (done, total) => {
        running = { rule: rule.id, done, total }
        changed()
      },
    })
      .then((outcome) => {
        if (outcome.ok) deps.evals.addRun(outcome.run)
        else if (outcome.error !== 'cancelled') failedRun = { rule: rule.id, error: outcome.error }
      })
      .finally(() => {
        running = null
        changed()
      })
    return ok()
  }

  const cancelTest: SkillsCommand = async () => {
    stopped = true
    return ok()
  }

  const exportRules: SkillsCommand = async () => ok(undefined, { rules: store.list() })

  return {
    onSession,
    panel: {
      snapshot,
      save,
      retire: byId((id) => store.setState(id, 'retired')),
      restore,
      approve,
      resolve,
      'keep-both': keepBoth,
      'dismiss-group': dismissGroup,
      'find-rules': find,
      scoreboard: board,
      'save-case': saveCase,
      'delete-case': evalCaseById((id) => deps.evals.removeCase(id)),
      'accept-case': evalCaseById((id) => deps.evals.accept(id)),
      'draft-cases': draftCases,
      'run-eval': runTest,
      'cancel-eval': cancelTest,
      delete: byId((id) => {
        const removed = store.remove(id)
        if (removed) deps.evals.removeRule(id)
        return removed
      }, true),
      'accept-unreadable': acceptUnreadable,
      preview,
      'import-scan': importScan,
      'import-add': importAdd,
      export: exportRules,
    },
  }
}
