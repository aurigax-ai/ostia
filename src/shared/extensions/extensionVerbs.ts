import { isCoreSource } from '../boards/git'
import { EXTENSION_VERB_PATTERN } from '../extensions'

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
