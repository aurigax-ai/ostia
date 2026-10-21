import type { ExtensionManifest } from '../contract/extensions'
import type { FileKindContribution } from '../contract/fileKinds'

const VIEW_RANK = { option: 0, default: 1 } as const

function missing(update: readonly string[], bundled: readonly string[]): string | undefined {
  const known = new Set(bundled)
  return update.find((item) => !known.has(item))
}

function kindProblem(update: FileKindContribution, bundled: FileKindContribution[]): string | null {
  const known = bundled.find((kind) => kind.id === update.id)
  if (!known) return `file kind ${update.id} is new`
  const pattern = missing(
    update.selector.map((s) => s.filenamePattern),
    known.selector.map((s) => s.filenamePattern),
  )
  if (pattern) return `file kind ${update.id} claims ${pattern}, which the bundled one does not`
  if (update.browse && !known.browse) return `file kind ${update.id} gains the browse role`
  if (update.view) {
    if (!known.view) return `file kind ${update.id} gains a viewer`
    if (VIEW_RANK[update.view.priority] > VIEW_RANK[known.view.priority]) {
      return `file kind ${update.id} raises its viewer priority`
    }
  }
  return null
}

export function builtinUpdateProblem(
  bundled: ExtensionManifest,
  update: ExtensionManifest,
): string | null {
  const a = bundled.contributes
  const u = update.contributes
  const capability = missing(update.capabilities, bundled.capabilities)
  if (capability) return `asks for ${capability}, which the bundled one does not`
  if (update.main !== undefined && bundled.main === undefined) return 'starts a program'
  for (const command of u.commands) {
    const extra = missing(command.capabilities, bundled.capabilities)
    if (extra) return `command ${command.id} asks for ${extra}`
    const known = a.commands.find((c) => c.id === command.id)
    if (command.needsPlaybook && !known?.needsPlaybook) {
      return `command ${command.id} gains needsPlaybook`
    }
  }
  for (const kind of u.fileKinds ?? []) {
    const problem = kindProblem(kind, a.fileKinds ?? [])
    if (problem) return problem
  }
  const checks: [string, string[], string[]][] = [
    [
      'an agent skill',
      (u.agentSkills ?? []).map((s) => `${s.name}:${s.bare === true}`),
      (a.agentSkills ?? []).map((s) => `${s.name}:${s.bare === true}`),
    ],
    [
      'an agent hook',
      (u.agentHooks ?? []).map((h) => `${h.event}:${h.command}`),
      (a.agentHooks ?? []).map((h) => `${h.event}:${h.command}`),
    ],
    ['an assist point', u.assist, a.assist],
    [
      'a language server',
      (u.languageServers ?? []).map((s) => s.id),
      (a.languageServers ?? []).map((s) => s.id),
    ],
    ['a secret', u.secrets.map((s) => s.key), a.secrets.map((s) => s.key)],
    [
      'a connection kind',
      (u.connections ?? []).map((c) => c.kind),
      (a.connections ?? []).map((c) => c.kind),
    ],
  ]
  for (const [label, update_, bundled_] of checks) {
    const extra = missing(update_, bundled_)
    if (extra) return `adds ${label} (${extra})`
  }
  if (u.verb !== undefined && u.verb !== a.verb) return 'changes its verb'
  return null
}
