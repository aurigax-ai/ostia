import type { SurfaceKind } from '../layout/types'

export const ACTION_PLACES = ['paneHeader', 'tabMenu'] as const
export type ActionPlace = (typeof ACTION_PLACES)[number]

export const ACTION_ICONS = [
  'lightning',
  'play',
  'terminal',
  'globe',
  'folder',
  'file',
  'git-branch',
  'bug',
  'rocket',
  'sparkle',
  'robot',
  'code',
  'book',
  'gear',
  'wrench',
  'refresh',
  'search',
  'database',
  'package',
  'flask',
  'eye',
  'link',
  'chat',
  'checklist',
  'broom',
] as const
export type ActionIcon = (typeof ACTION_ICONS)[number]

const PANE_KINDS: readonly SurfaceKind[] = [
  'terminal',
  'editor',
  'browser',
  'extension',
  'diff',
  'view',
]

export interface UserAction {
  id: string
  title: string
  command: string
  args?: Record<string, unknown>
  icon?: ActionIcon
  in: ActionPlace[]
  paneKinds?: SurfaceKind[]
}

export const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
export const ACTION_TITLE_MAX = 60
export const ACTION_ARGS_MAX = 4096
export const ACTIONS_MAX = 50

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function subset<T extends string>(allowed: readonly T[], raw: unknown): T[] | null {
  if (!Array.isArray(raw)) return null
  if (!raw.every((v) => allowed.includes(v as T))) return null
  return [...new Set(raw as T[])]
}

function parseAction(raw: unknown): UserAction | null {
  if (!isRecord(raw)) return null
  const { id, title, command, args, icon, paneKinds } = raw
  if (typeof id !== 'string' || !ACTION_ID.test(id)) return null
  if (typeof title !== 'string' || !title.trim() || title.length > ACTION_TITLE_MAX) return null
  if (typeof command !== 'string' || !COMMAND_ID.test(command)) return null
  if (args !== undefined && (!isRecord(args) || JSON.stringify(args).length > ACTION_ARGS_MAX)) {
    return null
  }
  if (icon !== undefined && !ACTION_ICONS.includes(icon as ActionIcon)) return null
  const places = raw.in === undefined ? [] : subset(ACTION_PLACES, raw.in)
  if (!places) return null
  const kinds = paneKinds === undefined ? undefined : subset(PANE_KINDS, paneKinds)
  if (kinds === null) return null
  return {
    id,
    title,
    command,
    ...(args ? { args: args as Record<string, unknown> } : {}),
    ...(icon ? { icon: icon as ActionIcon } : {}),
    in: places,
    ...(kinds ? { paneKinds: kinds } : {}),
  }
}

export function parseActions(raw: unknown): UserAction[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: UserAction[] = []
  for (const entry of raw.slice(0, ACTIONS_MAX)) {
    const action = parseAction(entry)
    if (!action || seen.has(action.id)) continue
    seen.add(action.id)
    out.push(action)
  }
  return out
}

export function actionFingerprint(action: Pick<UserAction, 'command' | 'args'>): string {
  return JSON.stringify([action.command, action.args ?? null])
}

export interface ActionContext {
  cwd?: string
  file?: string
}

export function fillArgs(
  args: Record<string, unknown> | undefined,
  ctx: ActionContext,
): Record<string, unknown> | undefined {
  if (!args) return undefined
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/\{(cwd|file)\}/g, (_m, key: keyof ActionContext) => ctx[key] ?? '')
    }
    if (Array.isArray(value)) return value.map(fill)
    if (isRecord(value))
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]))
    return value
  }
  return fill(args) as Record<string, unknown>
}

export function actionsFor(
  actions: readonly UserAction[],
  place: ActionPlace,
  kind: SurfaceKind,
): UserAction[] {
  return actions.filter((a) => a.in.includes(place) && (!a.paneKinds || a.paneKinds.includes(kind)))
}
