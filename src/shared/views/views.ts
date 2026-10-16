export const VIEW_VERSION = 1
export const OPEN_VIEW_COMMAND = 'views.open'
export const VIEW_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const VIEW_FILE_EXTENSION = '.json'
export const VIEW_FILE_MAX_BYTES = 64 * 1024
export const VIEW_FILES_MAX = 50
export const VIEW_MAX_NODES = 200
export const VIEW_MAX_DEPTH = 10
export const VIEW_MAX_LIST_ITEMS = 50
export const VIEW_MAX_RENDERED_NODES = 1000
export const VIEW_KV_MAX = 20
export const VIEW_TITLE_MAX = 60
export const VIEW_TEXT_MAX = 500
export const VIEW_ARGS_MAX = 4096
export const VIEW_URL_MAX = 2048

export const VIEW_PLACEMENTS = ['sidebar', 'panel'] as const
export type ViewPlacement = (typeof VIEW_PLACEMENTS)[number]

export const VIEW_SOURCES = [
  'workspace',
  'workspaces',
  'panes',
  'ports',
  'approvals',
  'notifications',
  'clock',
] as const
export type ViewSource = (typeof VIEW_SOURCES)[number]

export const VIEW_ICONS = [
  'lightning',
  'play',
  'stop',
  'terminal',
  'globe',
  'folder',
  'file',
  'git-branch',
  'git-pull-request',
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
  'bell',
  'clock',
  'check',
  'warning',
  'x',
  'circle',
  'server',
  'plug',
  'user',
  'star',
  'plus',
  'arrow-right',
] as const
export type ViewIcon = (typeof VIEW_ICONS)[number]

export const VIEW_TONES = ['neutral', 'muted', 'brand', 'ok', 'warn', 'error'] as const
export type ViewTone = (typeof VIEW_TONES)[number]
export const VIEW_ICON_TONES = ['neutral', 'muted', 'ok', 'warn', 'error'] as const
export type ViewIconTone = (typeof VIEW_ICON_TONES)[number]
export const VIEW_GAPS = ['none', 'sm', 'md', 'lg'] as const
export type ViewGap = (typeof VIEW_GAPS)[number]
export const VIEW_JUSTIFY = ['start', 'between', 'end'] as const
export type ViewJustify = (typeof VIEW_JUSTIFY)[number]
export const VIEW_TEXT_SIZES = ['xs', 'sm', 'base'] as const
export type ViewTextSize = (typeof VIEW_TEXT_SIZES)[number]
export const VIEW_WEIGHTS = ['regular', 'medium', 'semibold'] as const
export type ViewWeight = (typeof VIEW_WEIGHTS)[number]
export const VIEW_BUTTON_VARIANTS = ['default', 'outline', 'ghost'] as const
export type ViewButtonVariant = (typeof VIEW_BUTTON_VARIANTS)[number]

export type ViewAction = { command: string; args?: Record<string, unknown> } | { openUrl: string }

export interface NodeBase {
  if?: string
}

export type ViewNode =
  | (NodeBase & { type: 'stack'; children: ViewNode[]; gap?: ViewGap })
  | (NodeBase & {
      type: 'row'
      children: ViewNode[]
      gap?: ViewGap
      justify?: ViewJustify
      wrap?: boolean
    })
  | (NodeBase & { type: 'section'; title: string; children: ViewNode[]; collapsed?: boolean })
  | (NodeBase & {
      type: 'text'
      text: string
      tone?: ViewTone
      size?: ViewTextSize
      weight?: ViewWeight
      mono?: boolean
      truncate?: boolean
    })
  | (NodeBase & { type: 'badge'; text: string; tone?: ViewTone })
  | (NodeBase & { type: 'icon'; name: ViewIcon; tone?: ViewIconTone; label?: string })
  | (NodeBase & {
      type: 'list'
      for: string
      as: string
      limit?: number
      item: ViewNode
      empty?: string
      gap?: ViewGap
    })
  | (NodeBase & {
      type: 'button'
      label: string
      icon?: ViewIcon
      variant?: ViewButtonVariant
      action: ViewAction
    })
  | (NodeBase & { type: 'link'; label: string; url: string })
  | (NodeBase & {
      type: 'progress'
      value: number | string
      max?: number
      label?: string
      tone?: ViewTone
    })
  | (NodeBase & { type: 'kv'; items: { key: string; value: string }[] })
  | (NodeBase & { type: 'divider' })

export type ViewNodeType = ViewNode['type']

export interface ViewDoc {
  version: typeof VIEW_VERSION
  title: string
  placement: ViewPlacement
  icon?: ViewIcon
  description?: string
  root: ViewNode
  sources: ViewSource[]
  ticks: boolean
}

export interface ViewProblem {
  path: string
  line?: number
  message: string
}

export type ViewStatus = 'pending' | 'enabled' | 'disabled'

export interface ViewInfo {
  name: string
  file: string
  status: ViewStatus
  title: string
  placement: ViewPlacement | null
  icon?: ViewIcon
  description?: string
  doc: ViewDoc | null
  stale: boolean
  problems: ViewProblem[]
}

export interface ViewListing {
  dir: string
  views: ViewInfo[]
}

export interface ViewsApi {
  list: () => Promise<ViewListing>
  setEnabled: (name: string, enabled: boolean) => Promise<ViewListing>
  reveal: (name: string) => Promise<boolean>
  onChanged: (cb: (listing: ViewListing) => void) => () => void
}

export type ViewParseResult = { ok: true; doc: ViewDoc } | { ok: false; problems: ViewProblem[] }

export const NODE_KEYS: Record<ViewNodeType, readonly string[]> = {
  stack: ['children', 'gap'],
  row: ['children', 'gap', 'justify', 'wrap'],
  section: ['title', 'children', 'collapsed'],
  text: ['text', 'tone', 'size', 'weight', 'mono', 'truncate'],
  badge: ['text', 'tone'],
  icon: ['name', 'tone', 'label'],
  list: ['for', 'as', 'limit', 'item', 'empty', 'gap'],
  button: ['label', 'icon', 'variant', 'action'],
  link: ['label', 'url'],
  progress: ['value', 'max', 'label', 'tone'],
  kv: ['items'],
  divider: [],
}

export const VIEW_NODE_TYPES = Object.keys(NODE_KEYS) as ViewNodeType[]

export function isHttpUrl(raw: string): boolean {
  if (raw.length > VIEW_URL_MAX) return false
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function viewNameOf(fileName: string): string | null {
  if (!fileName.endsWith(VIEW_FILE_EXTENSION)) return null
  const name = fileName.slice(0, -VIEW_FILE_EXTENSION.length)
  return VIEW_NAME.test(name) ? name : null
}

export function formatViewProblem(file: string, p: ViewProblem): string {
  return `${file}${p.line ? `:${p.line}` : ''}: ${p.path}: ${p.message}`
}
