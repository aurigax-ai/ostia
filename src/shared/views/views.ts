import { childPath, parseLocatedJson } from '../common/jsonLocated'
import { bindingsOf, compileTemplate, hasBindings, isIdentifier, parsePath } from './viewBindings'

export const VIEW_VERSION = 1
export const OPEN_VIEW_COMMAND = 'views.open'
export const VIEW_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
export const VIEW_FILE_EXTENSION = '.json'
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
export const VIEW_PROBLEMS_MAX = 50

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

interface NodeBase {
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

const DOC_KEYS = ['$schema', 'version', 'title', 'placement', 'icon', 'description', 'root']

const NODE_KEYS: Record<ViewNodeType, readonly string[]> = {
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

const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const HTTP_PREFIX = /^https?:\/\//i

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

class Checker {
  problems: ViewProblem[] = []
  nodes = 0
  sources = new Set<ViewSource>()
  ticks = false

  constructor(private readonly lines: Map<string, number>) {}

  report(path: string, message: string): void {
    if (this.problems.length >= VIEW_PROBLEMS_MAX) return
    let probe = path
    let line = this.lines.get(probe)
    while (line === undefined && probe) {
      const cut = Math.max(probe.lastIndexOf('.'), probe.lastIndexOf('['))
      probe = cut > 0 ? probe.slice(0, cut) : ''
      line = this.lines.get(probe)
    }
    this.problems.push({ path: path || '(document)', ...(line ? { line } : {}), message })
  }

  keys(obj: Record<string, unknown>, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        this.report(
          childPath(path, key),
          `unknown property '${key}' (allowed: ${allowed.join(', ')})`,
        )
      }
    }
  }

  template(value: unknown, path: string, scope: ReadonlySet<string>, max = VIEW_TEXT_MAX): string {
    if (typeof value !== 'string') {
      this.report(path, 'must be a string')
      return ''
    }
    if (value.length > max) this.report(path, `longer than ${max} characters`)
    const compiled = compileTemplate(value)
    if (compiled instanceof Error) {
      this.report(path, compiled.message)
      return value
    }
    for (const binding of bindingsOf(value)) {
      this.root(binding.path[0], path, scope)
      if (binding.filters.includes('relative')) this.ticks = true
    }
    return value
  }

  root(name: string, path: string, scope: ReadonlySet<string>): void {
    if (scope.has(name)) return
    if ((VIEW_SOURCES as readonly string[]).includes(name)) {
      this.sources.add(name as ViewSource)
      if (name === 'clock') this.ticks = true
      return
    }
    const names = [...VIEW_SOURCES, ...scope].join(', ')
    this.report(path, `unknown data source '${name}' (known here: ${names})`)
  }

  title(value: unknown, path: string, scope: ReadonlySet<string>): string {
    const text = this.template(value, path, scope, VIEW_TITLE_MAX)
    if (typeof value === 'string' && !value.trim()) this.report(path, 'must not be empty')
    return text
  }

  oneOf<T extends string>(
    obj: Record<string, unknown>,
    key: string,
    path: string,
    allowed: readonly T[],
  ): T | undefined {
    const value = obj[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      this.report(childPath(path, key), `must be one of: ${allowed.join(', ')}`)
      return undefined
    }
    return value as T
  }

  bool(obj: Record<string, unknown>, key: string, path: string): boolean | undefined {
    const value = obj[key]
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') {
      this.report(childPath(path, key), 'must be true or false')
      return undefined
    }
    return value
  }

  url(value: unknown, path: string, scope: ReadonlySet<string>): string {
    const url = this.template(value, path, scope, VIEW_URL_MAX)
    if (typeof value !== 'string') return url
    const compiled = compileTemplate(url)
    if (compiled instanceof Error) return url
    if (!hasBindings(url)) {
      if (!isHttpUrl(url)) this.report(path, 'must be an http:// or https:// URL')
      return url
    }
    const single = compiled.length === 1 && typeof compiled[0] !== 'string'
    if (!single && !HTTP_PREFIX.test(url)) {
      this.report(path, "must start with 'http://' or 'https://', or be a single {{binding}}")
    }
    return url
  }

  args(value: unknown, path: string, scope: ReadonlySet<string>): void {
    if (typeof value === 'string') {
      this.template(value, path, scope)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => this.args(v, childPath(path, i), scope))
      return
    }
    if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) this.args(v, childPath(path, k), scope)
      return
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return
    this.report(path, 'must be JSON data')
  }

  action(value: unknown, path: string, scope: ReadonlySet<string>): ViewAction | null {
    if (!isRecord(value)) {
      this.report(path, 'must be an object with "command" (and optional "args") or "openUrl"')
      return null
    }
    if ('openUrl' in value) {
      this.keys(value, path, ['openUrl'])
      return { openUrl: this.url(value.openUrl, childPath(path, 'openUrl'), scope) }
    }
    this.keys(value, path, ['command', 'args'])
    const command = value.command
    if (typeof command !== 'string' || !COMMAND_ID.test(command)) {
      this.report(childPath(path, 'command'), 'must be a palette command id, e.g. "workspace.new"')
      return null
    }
    if (value.args === undefined) return { command }
    const argsPath = childPath(path, 'args')
    if (!isRecord(value.args)) {
      this.report(argsPath, 'must be an object')
      return null
    }
    if (JSON.stringify(value.args).length > VIEW_ARGS_MAX) {
      this.report(argsPath, `larger than ${VIEW_ARGS_MAX} characters of JSON`)
    }
    this.args(value.args, argsPath, scope)
    return { command, args: value.args }
  }

  children(value: unknown, path: string, depth: number, scope: ReadonlySet<string>): ViewNode[] {
    if (!Array.isArray(value)) {
      this.report(path, 'must be an array of nodes')
      return []
    }
    const out: ViewNode[] = []
    value.forEach((child, i) => {
      const node = this.node(child, childPath(path, i), depth, scope)
      if (node) out.push(node)
    })
    return out
  }

  node(value: unknown, path: string, depth: number, scope: ReadonlySet<string>): ViewNode | null {
    if (!isRecord(value)) {
      this.report(path, 'must be a node object with a "type"')
      return null
    }
    this.nodes++
    if (this.nodes === VIEW_MAX_NODES + 1) {
      this.report(path, `more than ${VIEW_MAX_NODES} nodes in one view`)
    }
    if (depth > VIEW_MAX_DEPTH) {
      this.report(path, `nested deeper than ${VIEW_MAX_DEPTH} levels`)
      return null
    }
    const type = value.type
    if (typeof type !== 'string' || !Object.hasOwn(NODE_KEYS, type)) {
      this.report(childPath(path, 'type'), `must be one of: ${VIEW_NODE_TYPES.join(', ')}`)
      return null
    }
    const t = type as ViewNodeType
    this.keys(value, path, ['type', 'if', ...NODE_KEYS[t]])
    const base: NodeBase = {}
    if (value.if !== undefined) {
      const cond = this.template(value.if, childPath(path, 'if'), scope)
      const compiled = compileTemplate(cond)
      if (
        !(compiled instanceof Error) &&
        (compiled.length !== 1 || typeof compiled[0] === 'string')
      ) {
        this.report(childPath(path, 'if'), 'must be a single {{binding}}')
      }
      base.if = cond
    }
    const at = (key: string): string => childPath(path, key)
    const opt = <K extends string, V>(key: K, v: V | undefined): { [P in K]?: V } =>
      (v === undefined ? {} : { [key]: v }) as { [P in K]?: V }

    switch (t) {
      case 'stack':
        return {
          ...base,
          type: t,
          children: this.children(value.children, at('children'), depth + 1, scope),
          ...opt('gap', this.oneOf(value, 'gap', path, VIEW_GAPS)),
        }
      case 'row':
        return {
          ...base,
          type: t,
          children: this.children(value.children, at('children'), depth + 1, scope),
          ...opt('gap', this.oneOf(value, 'gap', path, VIEW_GAPS)),
          ...opt('justify', this.oneOf(value, 'justify', path, VIEW_JUSTIFY)),
          ...opt('wrap', this.bool(value, 'wrap', path)),
        }
      case 'section':
        return {
          ...base,
          type: t,
          title: this.title(value.title, at('title'), scope),
          children: this.children(value.children, at('children'), depth + 1, scope),
          ...opt('collapsed', this.bool(value, 'collapsed', path)),
        }
      case 'text':
        return {
          ...base,
          type: t,
          text: this.template(value.text, at('text'), scope),
          ...opt('tone', this.oneOf(value, 'tone', path, VIEW_TONES)),
          ...opt('size', this.oneOf(value, 'size', path, VIEW_TEXT_SIZES)),
          ...opt('weight', this.oneOf(value, 'weight', path, VIEW_WEIGHTS)),
          ...opt('mono', this.bool(value, 'mono', path)),
          ...opt('truncate', this.bool(value, 'truncate', path)),
        }
      case 'badge':
        return {
          ...base,
          type: t,
          text: this.template(value.text, at('text'), scope, VIEW_TITLE_MAX),
          ...opt('tone', this.oneOf(value, 'tone', path, VIEW_TONES)),
        }
      case 'icon': {
        const name = this.oneOf(value, 'name', path, VIEW_ICONS)
        if (value.name === undefined) this.report(at('name'), 'is required')
        return {
          ...base,
          type: t,
          name: name ?? 'circle',
          ...opt('tone', this.oneOf(value, 'tone', path, VIEW_ICON_TONES)),
          ...opt(
            'label',
            value.label === undefined
              ? undefined
              : this.template(value.label, at('label'), scope, VIEW_TITLE_MAX),
          ),
        }
      }
      case 'list':
        return this.list(value, path, depth, scope, base)
      case 'button':
        return {
          ...base,
          type: t,
          label: this.title(value.label, at('label'), scope),
          ...opt('icon', this.oneOf(value, 'icon', path, VIEW_ICONS)),
          ...opt('variant', this.oneOf(value, 'variant', path, VIEW_BUTTON_VARIANTS)),
          action: this.action(value.action, at('action'), scope) ?? { command: 'invalid' },
        }
      case 'link':
        return {
          ...base,
          type: t,
          label: this.title(value.label, at('label'), scope),
          url: this.url(value.url, at('url'), scope),
        }
      case 'progress':
        return this.progress(value, path, scope, base)
      case 'kv':
        return { ...base, type: t, items: this.kv(value.items, at('items'), scope) }
      case 'divider':
        return { ...base, type: t }
    }
  }

  list(
    value: Record<string, unknown>,
    path: string,
    depth: number,
    scope: ReadonlySet<string>,
    base: NodeBase,
  ): ViewNode {
    const at = (key: string): string => childPath(path, key)
    let source = ''
    if (typeof value.for !== 'string') {
      this.report(at('for'), 'must be a data path such as "workspaces" or "workspace.ports"')
    } else {
      const parsed = parsePath(value.for)
      if (parsed instanceof Error) this.report(at('for'), parsed.message)
      else this.root(parsed[0], at('for'), scope)
      source = value.for
    }
    let as = 'item'
    if (value.as !== undefined) {
      if (typeof value.as !== 'string' || !isIdentifier(value.as)) {
        this.report(at('as'), 'must be a simple name such as "ws"')
      } else if ((VIEW_SOURCES as readonly string[]).includes(value.as) || scope.has(value.as)) {
        this.report(at('as'), `'${value.as}' is already a data source or an outer list's name`)
      } else {
        as = value.as
      }
    }
    let limit: number | undefined
    if (value.limit !== undefined) {
      const n = value.limit
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > VIEW_MAX_LIST_ITEMS) {
        this.report(at('limit'), `must be a whole number from 1 to ${VIEW_MAX_LIST_ITEMS}`)
      } else {
        limit = n
      }
    }
    const inner = new Set(scope).add(as)
    const item = this.node(value.item, at('item'), depth + 1, inner)
    return {
      ...base,
      type: 'list',
      for: source,
      as,
      item: item ?? { type: 'divider' },
      ...(limit === undefined ? {} : { limit }),
      ...(value.empty === undefined
        ? {}
        : { empty: this.template(value.empty, at('empty'), scope, VIEW_TITLE_MAX) }),
      ...(this.oneOf(value, 'gap', path, VIEW_GAPS) ? { gap: value.gap as ViewGap } : {}),
    }
  }

  progress(
    value: Record<string, unknown>,
    path: string,
    scope: ReadonlySet<string>,
    base: NodeBase,
  ): ViewNode {
    const at = (key: string): string => childPath(path, key)
    let amount: number | string = 0
    if (typeof value.value === 'number' && Number.isFinite(value.value)) {
      amount = value.value
    } else if (typeof value.value === 'string') {
      amount = this.template(value.value, at('value'), scope)
      const compiled = compileTemplate(amount)
      if (
        !(compiled instanceof Error) &&
        (compiled.length !== 1 || typeof compiled[0] === 'string')
      ) {
        this.report(at('value'), 'must be a number or a single {{binding}}')
      }
    } else {
      this.report(at('value'), 'must be a number or a single {{binding}}')
    }
    let max: number | undefined
    if (value.max !== undefined) {
      if (typeof value.max !== 'number' || !Number.isFinite(value.max) || value.max <= 0) {
        this.report(at('max'), 'must be a number above 0')
      } else {
        max = value.max
      }
    }
    return {
      ...base,
      type: 'progress',
      value: amount,
      ...(max === undefined ? {} : { max }),
      ...(value.label === undefined
        ? {}
        : { label: this.template(value.label, at('label'), scope, VIEW_TITLE_MAX) }),
      ...(this.oneOf(value, 'tone', path, VIEW_TONES) ? { tone: value.tone as ViewTone } : {}),
    }
  }

  kv(value: unknown, path: string, scope: ReadonlySet<string>): { key: string; value: string }[] {
    if (!Array.isArray(value)) {
      this.report(path, 'must be an array of {"key", "value"} pairs')
      return []
    }
    if (value.length > VIEW_KV_MAX) this.report(path, `more than ${VIEW_KV_MAX} pairs`)
    const out: { key: string; value: string }[] = []
    value.slice(0, VIEW_KV_MAX).forEach((pair, i) => {
      const at = childPath(path, i)
      if (!isRecord(pair)) {
        this.report(at, 'must be an object with "key" and "value"')
        return
      }
      this.keys(pair, at, ['key', 'value'])
      out.push({
        key: this.template(pair.key, childPath(at, 'key'), scope, VIEW_TITLE_MAX),
        value: this.template(pair.value, childPath(at, 'value'), scope),
      })
    })
    return out
  }
}

export function parseViewValue(raw: unknown, lines = new Map<string, number>()): ViewParseResult {
  const c = new Checker(lines)
  if (!isRecord(raw)) {
    c.report('', 'a view file must be a JSON object')
    return { ok: false, problems: c.problems }
  }
  c.keys(raw, '', DOC_KEYS)
  if (raw.$schema !== undefined && typeof raw.$schema !== 'string') {
    c.report('$schema', 'must be a string')
  }
  if (raw.version !== VIEW_VERSION) c.report('version', `must be ${VIEW_VERSION}`)
  const empty = new Set<string>()
  let title = ''
  if (typeof raw.title !== 'string' || !raw.title.trim()) c.report('title', 'is required')
  else if (raw.title.length > VIEW_TITLE_MAX) {
    c.report('title', `longer than ${VIEW_TITLE_MAX} characters`)
  } else title = raw.title
  const placement = c.oneOf(raw, 'placement', '', VIEW_PLACEMENTS)
  if (raw.placement === undefined) c.report('placement', 'is required (sidebar or panel)')
  const icon = c.oneOf(raw, 'icon', '', VIEW_ICONS)
  let description: string | undefined
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || raw.description.length > 200) {
      c.report('description', 'must be a string of at most 200 characters')
    } else description = raw.description
  }
  const root = raw.root === undefined ? null : c.node(raw.root, 'root', 1, empty)
  if (raw.root === undefined) c.report('root', 'is required')
  if (c.problems.length > 0 || !root || !placement) return { ok: false, problems: c.problems }
  return {
    ok: true,
    doc: {
      version: VIEW_VERSION,
      title,
      placement,
      ...(icon ? { icon } : {}),
      ...(description ? { description } : {}),
      root,
      sources: VIEW_SOURCES.filter((s) => c.sources.has(s)),
      ticks: c.ticks,
    },
  }
}

export function parseViewText(text: string): ViewParseResult {
  const located = parseLocatedJson(text)
  if ('message' in located) {
    return {
      ok: false,
      problems: [
        {
          path: '(document)',
          line: located.line,
          message: `invalid JSON at column ${located.column}: ${located.message}`,
        },
      ],
    }
  }
  return parseViewValue(located.value, located.lines)
}

export function formatViewProblem(file: string, p: ViewProblem): string {
  return `${file}${p.line ? `:${p.line}` : ''}: ${p.path}: ${p.message}`
}
