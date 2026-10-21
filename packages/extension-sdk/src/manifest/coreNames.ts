import { EXTENSION_VERB_PATTERN } from '../contract/extensions'

export const GIT_SOURCE = 'git'
export const PORTS_SOURCE = 'ports'
const CORE_SOURCES: readonly string[] = [GIT_SOURCE, PORTS_SOURCE]

export function isCoreSource(id: string): boolean {
  return CORE_SOURCES.includes(id)
}

export const CORE_VERBS: readonly string[] = [
  'whoami',
  'docs',
  'open',
  'diff',
  'ask',
  'state',
  'notify',
  'pane',
  'process',
  'agent',
  'workspace',
  'bus',
  'browse',
  'git',
  'ports',
  'view',
  'snippet',
  'settings',
  'vault',
  'secret',
  'sandbox',
  'ext',
  'manager',
  'commands',
  'token',
  'gateway',
  'polkit',
  'cmux',
  'resume-token',
  'claude-hook',
  'codex-hook',
  'turn-hook',
  'codex-server',
  'permission-hook',
  'agent-hook',
]

const RESERVED_VERBS = new Set(CORE_VERBS)

export function verbProblem(verb: unknown): string | null {
  if (typeof verb !== 'string' || !EXTENSION_VERB_PATTERN.test(verb)) {
    return `contributes.verb '${String(verb)}' must match ${EXTENSION_VERB_PATTERN}`
  }
  if (RESERVED_VERBS.has(verb) || isCoreSource(verb)) {
    return `contributes.verb '${verb}' is a built-in verb`
  }
  return null
}
