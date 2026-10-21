import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { childPath } from '../common/jsonLocated'
import { bindingsOf, compileTemplate, hasBindings, isIdentifier, parsePath } from './viewBindings'
import {
  isHttpUrl,
  NODE_KEYS,
  type NodeBase,
  VIEW_ARGS_MAX,
  VIEW_BUTTON_VARIANTS,
  VIEW_GAPS,
  VIEW_ICON_TONES,
  VIEW_ICONS,
  VIEW_JUSTIFY,
  VIEW_KV_MAX,
  VIEW_MAX_DEPTH,
  VIEW_MAX_LIST_ITEMS,
  VIEW_MAX_NODES,
  VIEW_NODE_TYPES,
  VIEW_SOURCES,
  VIEW_TEXT_MAX,
  VIEW_TEXT_SIZES,
  VIEW_TITLE_MAX,
  VIEW_TONES,
  VIEW_URL_MAX,
  VIEW_WEIGHTS,
  type ViewAction,
  type ViewGap,
  type ViewNode,
  type ViewNodeType,
  type ViewProblem,
  type ViewSource,
  type ViewTone,
} from './views'

const VIEW_PROBLEMS_MAX = 50

const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const HTTP_PREFIX = /^https?:\/\//i

export class Checker {
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
