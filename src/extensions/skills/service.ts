import {
  type ExtensionCaller,
  type ExtensionResult,
  failure,
  namedArgs,
  ok,
} from '@aurigax-ai/ostia-extension-sdk'
import { importCandidates } from './importLines'
import { buildInjection } from './inject'
import { type RuleDraft, isScope } from './rule'
import { type FolderScope, folderScope, projectScopeOf } from './scope'
import { type ShapeProblem, shapeGate } from './shapeGate'
import type { RulesStore } from './store'

interface WorkspaceInfo {
  kind: string
  workDir: string
}

export interface SkillsDeps {
  store: RulesStore
  redact: (texts: string[]) => Promise<string[] | null>
  workspace: (workspaceId: string) => Promise<WorkspaceInfo | null>
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
  const { store, redact, workspace, changed } = deps
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

  const onSession: SkillsCommand = async (_args, caller) => {
    const info = caller.workspaceId ? await workspace(caller.workspaceId) : null
    if (!info || info.kind === 'scratch' || caller.manager || caller.sandboxed || caller.remote) {
      return ok()
    }
    const dir = await whereDir(caller)
    return dir ? ok((await injectionFor(dir)).text) : ok()
  }

  const snapshot: SkillsCommand = async (_args, caller) => {
    const dir = await whereDir(caller)
    const where = dir ? await scopeOf(dir) : null
    return ok(undefined, {
      rules: store.list(),
      project: where ? projectScopeOf(where) : null,
      stacks: where?.stacks ?? [],
    })
  }

  const save: SkillsCommand = async (args) => {
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
    const rule = store.add(draft, 'human')
    changed()
    return ok(undefined, { id: rule.id })
  }

  const byId = (action: (id: string) => boolean): SkillsCommand => {
    return async (args) => {
      const id = textOf(namedArgs(args).id)
      if (!action(id)) return failure('not-found')
      changed()
      return ok()
    }
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

  const exportRules: SkillsCommand = async () => ok(undefined, { rules: store.list() })

  return {
    onSession,
    panel: {
      snapshot,
      save,
      retire: byId((id) => store.setState(id, 'retired')),
      restore: byId((id) => store.setState(id, 'active')),
      delete: byId((id) => store.remove(id)),
      preview,
      'import-scan': importScan,
      'import-add': importAdd,
      export: exportRules,
    },
  }
}
