import coordinatorText from './playbooks/coordinator.md?raw'
import rememberText from './playbooks/remember.md?raw'
import reviewText from './playbooks/review.md?raw'
import workerText from './playbooks/worker.md?raw'

export interface BuiltinPlaybook {
  id: string
  description: string
  text: string
  defaultOn: boolean
}

export const BUILTIN_PLAYBOOKS: readonly BuiltinPlaybook[] = [
  {
    id: 'coordinator',
    description: 'Plan, dispatch, review and merge; write no code yourself.',
    text: coordinatorText,
    defaultOn: false,
  },
  {
    id: 'worker',
    description: 'Scout, build, test and open a PR; report to the coordinator.',
    text: workerText,
    defaultOn: false,
  },
  {
    id: 'review',
    description: 'One focused review of a PR against its issue.',
    text: reviewText,
    defaultOn: false,
  },
  {
    id: 'remember',
    description: 'Note a task to pick up later, even after /clear or a resume.',
    text: rememberText,
    defaultOn: true,
  },
]

interface PlaybookEdit {
  text: string
  from: string
}

export interface OwnPlaybook {
  description: string
  text: string
  enabled: boolean
}

export interface PlaybooksSettings {
  enabled: Record<string, boolean>
  edits: Record<string, PlaybookEdit>
  own: Record<string, OwnPlaybook>
}

export const DEFAULT_PLAYBOOKS: PlaybooksSettings = { enabled: {}, edits: {}, own: {} }

const PLAYBOOK_NAME = /^[a-z][a-z0-9-]{0,31}$/
export const PLAYBOOK_TEXT_MAX = 8000
export const PLAYBOOK_DESCRIPTION_MAX = 120
export const OWN_PLAYBOOKS_MAX = 24

const RESERVED_NAMES: readonly string[] = [...BUILTIN_PLAYBOOKS.map((p) => p.id), 'ostia']

export type NameProblem = 'invalid' | 'reserved' | 'taken'
export type TextProblem = 'empty' | 'long' | 'control' | 'shell'
export type DescriptionProblem = 'empty' | 'long' | 'control'

const INLINE_INJECTION = /[!\u01c3][`\u02cb\u02f4\u2035$]/
const FENCED_INJECTION = /(?:[`\u02cb\u02f4\u2035]{3,}|~{3,})[ \t]*[!\u01c3$]/
const LINE_BREAKS = /\r\n|[\n\r\u0085\u2028\u2029]/

function hasControl(text: string, allowLineBreaks: boolean): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (allowLineBreaks && (code === 0x0a || code === 0x0d || code === 0x09)) continue
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true
    if (code === 0x2028 || code === 0x2029) return true
  }
  return false
}

export function playbookNameProblem(name: string, taken: readonly string[]): NameProblem | null {
  if (!PLAYBOOK_NAME.test(name)) return 'invalid'
  if (RESERVED_NAMES.includes(name)) return 'reserved'
  return taken.includes(name) ? 'taken' : null
}

export function playbookTextProblem(text: string): TextProblem | null {
  if (text.trim() === '') return 'empty'
  if (text.length > PLAYBOOK_TEXT_MAX) return 'long'
  if (hasControl(text, true)) return 'control'
  for (const line of text.split(LINE_BREAKS)) {
    const flat = line.normalize('NFKC')
    if (INLINE_INJECTION.test(flat) || FENCED_INJECTION.test(flat)) return 'shell'
  }
  return null
}

export function playbookDescriptionProblem(description: string): DescriptionProblem | null {
  if (description.trim() === '') return 'empty'
  if (description.length > PLAYBOOK_DESCRIPTION_MAX) return 'long'
  return hasControl(description, false) ? 'control' : null
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
      if (playbookNameProblem(name, []) !== null || !isObject(value)) continue
      own[name] = {
        description:
          typeof value.description === 'string'
            ? value.description.slice(0, PLAYBOOK_DESCRIPTION_MAX)
            : '',
        text: typeof value.text === 'string' ? value.text.slice(0, PLAYBOOK_TEXT_MAX) : '',
        enabled: value.enabled === true,
      }
    }
  }
  return { enabled, edits, own }
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
}

export function resolvePlaybooks(settings: PlaybooksSettings): ResolvedPlaybook[] {
  const builtins = BUILTIN_PLAYBOOKS.map((p): ResolvedPlaybook => {
    const edit = settings.edits[p.id]
    const edited = edit !== undefined && edit.text !== p.text
    return {
      id: p.id,
      builtin: true,
      description: p.description,
      text: edited ? edit.text : p.text,
      defaultText: p.text,
      enabled: settings.enabled[p.id] ?? p.defaultOn,
      edited,
      defaultChanged: edited && edit.from !== playbookHash(p.text),
    }
  })
  const own = Object.entries(settings.own).map(
    ([id, p]): ResolvedPlaybook => ({
      id,
      builtin: false,
      description: p.description,
      text: p.text,
      defaultText: null,
      enabled: p.enabled,
      edited: false,
      defaultChanged: false,
    }),
  )
  return [...builtins, ...own]
}

export function activePlaybooks(settings: PlaybooksSettings): ResolvedPlaybook[] {
  return resolvePlaybooks(settings).filter(
    (p) =>
      p.enabled &&
      playbookTextProblem(p.text) === null &&
      (p.builtin || playbookDescriptionProblem(p.description) === null),
  )
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
  const own = settings.own[id]
  if (own) return { ...settings, own: { ...settings.own, [id]: { ...own, enabled } } }
  if (!builtinOf(id)) return settings
  return { ...settings, enabled: { ...settings.enabled, [id]: enabled } }
}

export function withPlaybookText(
  settings: PlaybooksSettings,
  id: string,
  text: string,
): PlaybooksSettings {
  const own = settings.own[id]
  if (own) return { ...settings, own: { ...settings.own, [id]: { ...own, text } } }
  const builtin = builtinOf(id)
  if (!builtin) return settings
  if (text === builtin.text) return withPlaybookReset(settings, id)
  const kept = settings.edits[id]
  const from = kept && kept.text !== builtin.text ? kept.from : playbookHash(builtin.text)
  return { ...settings, edits: { ...settings.edits, [id]: { text, from } } }
}

export function withPlaybookReset(settings: PlaybooksSettings, id: string): PlaybooksSettings {
  const { [id]: _dropped, ...edits } = settings.edits
  return { ...settings, edits }
}

export function withOwnPlaybook(
  settings: PlaybooksSettings,
  name: string,
  fields: { description: string; text: string },
  replaces?: string,
): PlaybooksSettings {
  const previous = settings.own[replaces ?? name]
  const own = { ...settings.own }
  if (replaces !== undefined) delete own[replaces]
  own[name] = { ...fields, enabled: previous?.enabled ?? false }
  return { ...settings, own }
}

export function withoutOwnPlaybook(settings: PlaybooksSettings, name: string): PlaybooksSettings {
  const { [name]: _dropped, ...own } = settings.own
  return { ...settings, own }
}
