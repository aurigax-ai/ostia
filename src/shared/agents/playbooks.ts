import { skillDirective } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import coordinatorText from './playbooks/coordinator.md?raw'
import handoffText from './playbooks/handoff.md?raw'
import reviewText from './playbooks/review.md?raw'
import workerText from './playbooks/worker.md?raw'

export interface BuiltinPlaybook {
  id: string
  description: string
  text: string
}

export const BUILTIN_PLAYBOOKS: readonly BuiltinPlaybook[] = [
  {
    id: 'coordinator',
    description: 'Plan, dispatch, review and merge; write no code yourself.',
    text: coordinatorText,
  },
  {
    id: 'worker',
    description: 'Scout, build, test and open a PR; report to the coordinator.',
    text: workerText,
  },
  {
    id: 'review',
    description: 'One focused review of a PR against its issue.',
    text: reviewText,
  },
  {
    id: 'handoff',
    description: 'Start a clean new session on one topic, beside this one.',
    text: handoffText,
  },
]

interface PlaybookEdit {
  text: string
  from: string
}

export interface OwnPlaybook {
  description: string
  text: string
}

export interface PlaybooksSettings {
  enabled: Record<string, boolean>
  accepted: Record<string, string>
  edits: Record<string, PlaybookEdit>
  own: Record<string, OwnPlaybook>
}

export const DEFAULT_PLAYBOOKS: PlaybooksSettings = {
  enabled: {},
  accepted: {},
  edits: {},
  own: {},
}

const PLAYBOOK_NAME = /^[a-z][a-z0-9-]{0,31}$/
export const PLAYBOOK_TEXT_MAX = 8000
export const PLAYBOOK_DESCRIPTION_MAX = 120
export const OWN_PLAYBOOKS_MAX = 24

const CLAUDE_COMMANDS: readonly string[] = [
  'add-dir',
  'agents',
  'batch',
  'bug',
  'clear',
  'code-review',
  'compact',
  'config',
  'context',
  'copy',
  'cost',
  'debug',
  'doctor',
  'effort',
  'exit',
  'export',
  'fast',
  'feedback',
  'help',
  'hooks',
  'ide',
  'init',
  'install-github-app',
  'login',
  'logout',
  'loop',
  'mcp',
  'memory',
  'mobile',
  'model',
  'output-style',
  'permissions',
  'plugin',
  'pr-comments',
  'privacy-settings',
  'release-notes',
  'remote-control',
  'resume',
  'review',
  'rewind',
  'schedule',
  'security-review',
  'simplify',
  'skills',
  'stats',
  'status',
  'statusline',
  'terminal-setup',
  'theme',
  'todos',
  'ultrareview',
  'upgrade',
  'usage',
  'vim',
  'voice',
]

const RESERVED_NAMES: readonly string[] = [
  ...BUILTIN_PLAYBOOKS.map((p) => p.id),
  PRODUCT_NAME,
  ...CLAUDE_COMMANDS,
]

export type NameProblem = 'invalid' | 'reserved' | 'extension' | 'taken'
export type TextProblem = 'empty' | 'long' | 'control' | 'shell'
export type DescriptionProblem = 'empty' | 'long' | 'control'

const FORMAT_CHARACTER = /\p{Cf}/u

function hasControl(text: string, allowLineBreaks: boolean): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (allowLineBreaks && (code === 0x0a || code === 0x0d || code === 0x09)) continue
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true
    if (code === 0x2028 || code === 0x2029) return true
  }
  return false
}

export function playbookNameProblem(
  name: string,
  taken: readonly string[],
  extensionSkillIds: readonly string[],
): NameProblem | null {
  if (!PLAYBOOK_NAME.test(name)) return 'invalid'
  if (RESERVED_NAMES.includes(name)) return 'reserved'
  if (extensionSkillIds.includes(name)) return 'extension'
  return taken.includes(name) ? 'taken' : null
}

export function playbookTextProblem(text: string): TextProblem | null {
  if (text.trim() === '') return 'empty'
  if (text.length > PLAYBOOK_TEXT_MAX) return 'long'
  if (hasControl(text, true)) return 'control'
  return skillDirective(text) === null ? null : 'shell'
}

export function playbookDescriptionProblem(description: string): DescriptionProblem | null {
  if (description.trim() === '') return 'empty'
  if (description.length > PLAYBOOK_DESCRIPTION_MAX) return 'long'
  return hasControl(description, false) || FORMAT_CHARACTER.test(description) ? 'control' : null
}

export function playbookHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function builtinOf(id: string): BuiltinPlaybook | undefined {
  return BUILTIN_PLAYBOOKS.find((p) => p.id === id)
}

function textMap(raw: unknown, keep: (id: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isObject(raw)) return out
  for (const [id, value] of Object.entries(raw)) {
    if (keep(id) && typeof value === 'string') out[id] = value.slice(0, PLAYBOOK_TEXT_MAX)
  }
  return out
}

export function parsePlaybooks(raw: unknown): PlaybooksSettings {
  const src = isObject(raw) ? raw : {}
  const enabled: Record<string, boolean> = {}
  if (isObject(src.enabled)) {
    for (const [id, value] of Object.entries(src.enabled)) {
      if (PLAYBOOK_NAME.test(id) && typeof value === 'boolean') enabled[id] = value
    }
  }
  const edits: Record<string, PlaybookEdit> = {}
  if (isObject(src.edits)) {
    for (const [id, value] of Object.entries(src.edits)) {
      if (!builtinOf(id) || !isObject(value)) continue
      if (typeof value.text !== 'string' || typeof value.from !== 'string') continue
      edits[id] = { text: value.text.slice(0, PLAYBOOK_TEXT_MAX), from: value.from.slice(0, 16) }
    }
  }
  const own: Record<string, OwnPlaybook> = {}
  if (isObject(src.own)) {
    for (const [name, value] of Object.entries(src.own)) {
      if (Object.keys(own).length >= OWN_PLAYBOOKS_MAX) break
      if (playbookNameProblem(name, [], []) !== null || !isObject(value)) continue
      own[name] = {
        description:
          typeof value.description === 'string'
            ? value.description.slice(0, PLAYBOOK_DESCRIPTION_MAX)
            : '',
        text: typeof value.text === 'string' ? value.text.slice(0, PLAYBOOK_TEXT_MAX) : '',
      }
    }
  }
  return {
    enabled,
    accepted: textMap(src.accepted, (id) => PLAYBOOK_NAME.test(id)),
    edits,
    own,
  }
}

export interface ResolvedPlaybook {
  id: string
  builtin: boolean
  description: string
  text: string
  defaultText: string | null
  enabled: boolean
  edited: boolean
  defaultChanged: boolean
  unaccepted: string | null
}

export function resolvePlaybooks(settings: PlaybooksSettings): ResolvedPlaybook[] {
  const builtins = BUILTIN_PLAYBOOKS.map((p): ResolvedPlaybook => {
    const edit = settings.edits[p.id]
    const differs = edit !== undefined && edit.text !== p.text
    const accepted = differs && settings.accepted[p.id] === edit.text
    return {
      id: p.id,
      builtin: true,
      description: p.description,
      text: accepted ? edit.text : p.text,
      defaultText: p.text,
      enabled: settings.enabled[p.id] ?? false,
      edited: accepted,
      defaultChanged: accepted && edit.from !== playbookHash(p.text),
      unaccepted: differs && !accepted ? edit.text : null,
    }
  })
  const own = Object.entries(settings.own).map(
    ([id, p]): ResolvedPlaybook => ({
      id,
      builtin: false,
      description: p.description,
      text: p.text,
      defaultText: null,
      enabled: settings.enabled[id] ?? false,
      edited: false,
      defaultChanged: false,
      unaccepted: settings.accepted[id] === p.text ? null : p.text,
    }),
  )
  return [...builtins, ...own]
}

export function activePlaybooks(settings: PlaybooksSettings): ResolvedPlaybook[] {
  return resolvePlaybooks(settings).filter(
    (p) =>
      p.enabled &&
      (p.builtin || p.unaccepted === null) &&
      playbookTextProblem(p.text) === null &&
      (p.builtin || playbookDescriptionProblem(p.description) === null),
  )
}

export function isBuiltinPlaybookOn(settings: PlaybooksSettings, id: string): boolean {
  return activePlaybooks(settings).some((p) => p.builtin && p.id === id)
}

export function playbookSkillText(playbook: ResolvedPlaybook): string {
  return [
    '---',
    `name: ${playbook.id}`,
    `description: ${JSON.stringify(playbook.description.replace(/\s+/g, ' ').trim())}`,
    'argument-hint: "[task]"',
    'disable-model-invocation: true',
    '---',
    '',
    playbook.text.trimEnd(),
    '',
  ].join('\n')
}

export function withPlaybookEnabled(
  settings: PlaybooksSettings,
  id: string,
  enabled: boolean,
): PlaybooksSettings {
  if (!settings.own[id] && !builtinOf(id)) return settings
  return { ...settings, enabled: { ...settings.enabled, [id]: enabled } }
}

function without<T>(record: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _dropped, ...rest } = record
  return rest
}

export function withPlaybookReset(settings: PlaybooksSettings, id: string): PlaybooksSettings {
  return {
    ...settings,
    edits: without(settings.edits, id),
    accepted: without(settings.accepted, id),
  }
}

export function withPlaybookText(
  settings: PlaybooksSettings,
  id: string,
  text: string,
): PlaybooksSettings {
  const accepted = { ...settings.accepted, [id]: text }
  const own = settings.own[id]
  if (own) return { ...settings, accepted, own: { ...settings.own, [id]: { ...own, text } } }
  const builtin = builtinOf(id)
  if (!builtin) return settings
  if (text === builtin.text) return withPlaybookReset(settings, id)
  const kept = settings.edits[id]
  const from = kept && kept.text !== builtin.text ? kept.from : playbookHash(builtin.text)
  return { ...settings, accepted, edits: { ...settings.edits, [id]: { text, from } } }
}

export function withPlaybookAccepted(settings: PlaybooksSettings, id: string): PlaybooksSettings {
  const text = settings.own[id]?.text ?? settings.edits[id]?.text
  return text === undefined
    ? settings
    : { ...settings, accepted: { ...settings.accepted, [id]: text } }
}

export function withOwnPlaybook(
  settings: PlaybooksSettings,
  name: string,
  fields: OwnPlaybook,
  replaces?: string,
): PlaybooksSettings {
  const moved = replaces === undefined ? name : replaces
  const kept = settings.enabled[moved]
  let enabled = settings.enabled
  let own = settings.own
  let accepted = settings.accepted
  if (replaces !== undefined) {
    enabled = without(enabled, replaces)
    own = without(own, replaces)
    accepted = without(accepted, replaces)
  }
  if (kept !== undefined) enabled = { ...enabled, [name]: kept }
  return {
    ...settings,
    enabled,
    accepted: { ...accepted, [name]: fields.text },
    own: { ...own, [name]: fields },
  }
}

export function withoutOwnPlaybook(settings: PlaybooksSettings, name: string): PlaybooksSettings {
  return {
    ...settings,
    enabled: without(settings.enabled, name),
    accepted: without(settings.accepted, name),
    own: without(settings.own, name),
  }
}
