import { isCoreSource } from '../boards/git'
import { EXTENSION_VERB_PATTERN } from '../extensions'

export const CORE_VERBS: readonly string[] = [
  'whoami',
  'manager',
  'commands',
  'info',
  'cwd',
  'pane.list',
  'workspace.list',
  'workspace',
  'notify',
  'ask',
  'state',
  'resume-token',
  'claude-hook',
  'permission-hook',
  'agent-hook',
  'open',
  'diff',
  'docs',
  'process',
  'pane',
  'token',
  'vault',
  'sandbox',
  'secret',
  'bus',
  'settings',
  'browse',
  'gateway',
  'ext',
  'workflow',
  'view',
  'git',
  'ports',
]

const RESERVED_VERBS = new Set([...CORE_VERBS, 'agent'])

export function verbProblem(verb: unknown): string | null {
  if (typeof verb !== 'string' || !EXTENSION_VERB_PATTERN.test(verb)) {
    return `contributes.verb '${String(verb)}' must match ${EXTENSION_VERB_PATTERN}`
  }
  if (RESERVED_VERBS.has(verb) || isCoreSource(verb)) {
    return `contributes.verb '${verb}' is a built-in verb`
  }
  return null
}
