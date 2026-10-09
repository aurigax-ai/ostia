import { childPath } from '@shared/jsonLocated'
import {
  type ViewFormat,
  type ViewScope,
  resolveArgs,
  resolveText,
  resolveValue,
  truthy,
} from '@shared/viewBindings'
import {
  VIEW_MAX_LIST_ITEMS,
  VIEW_MAX_RENDERED_NODES,
  type ViewButtonVariant,
  type ViewDoc,
  type ViewGap,
  type ViewIcon,
  type ViewIconTone,
  type ViewJustify,
  type ViewNode,
  type ViewTextSize,
  type ViewTone,
  type ViewWeight,
  isHttpUrl,
} from '@shared/views'

export type ViewActionTarget =
  | {
      kind: 'command'
      command: string
      template?: Record<string, unknown>
      args?: Record<string, unknown>
    }
  | { kind: 'url'; url: string | null }

interface Keyed {
  key: string
}

export type RenderNode = Keyed &
  (
    | { kind: 'stack'; gap: ViewGap; children: RenderNode[] }
    | {
        kind: 'row'
        gap: ViewGap
        justify: ViewJustify
        wrap: boolean
        children: RenderNode[]
      }
    | { kind: 'section'; title: string; collapsed: boolean; children: RenderNode[] }
    | {
        kind: 'text'
        text: string
        tone: ViewTone
        size: ViewTextSize
        weight: ViewWeight
        mono: boolean
        truncate: boolean
      }
    | { kind: 'badge'; text: string; tone: ViewTone }
    | { kind: 'icon'; name: ViewIcon; tone: ViewIconTone; label: string }
    | { kind: 'list'; gap: ViewGap; items: RenderNode[]; empty: string | null }
    | {
        kind: 'button'
        label: string
        icon: ViewIcon | null
        variant: ViewButtonVariant
        action: ViewActionTarget
      }
    | { kind: 'link'; label: string; url: string | null }
    | { kind: 'progress'; ratio: number; label: string; tone: ViewTone }
    | { kind: 'kv'; items: { key: string; value: string }[] }
    | { kind: 'divider' }
  )

export type BudgetProblem =
  | { kind: 'list'; path: string; count: number; max: number }
  | { kind: 'nodes'; max: number }

export type ExpandResult =
  | { ok: true; root: RenderNode | null }
  | { ok: false; problem: BudgetProblem }

class OverBudget extends Error {
  constructor(readonly problem: BudgetProblem) {
    super(problem.kind)
  }
}

function safeUrl(value: unknown): string | null {
  return typeof value === 'string' && isHttpUrl(value) ? value : null
}

function itemKey(item: unknown, index: number): string {
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    const id = Object.hasOwn(item, 'id') ? (item as { id: unknown }).id : undefined
    if (typeof id === 'string' || typeof id === 'number') return `#${id}`
  }
  return `@${index}`
}

function ratioOf(value: unknown, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || max <= 0) return 0
  return Math.min(1, Math.max(0, n / max))
}

export function expandView(doc: ViewDoc, data: ViewScope, fmt: ViewFormat): ExpandResult {
  let count = 0

  const expand = (
    node: ViewNode,
    path: string,
    key: string,
    scope: ViewScope,
  ): RenderNode | null => {
    if (node.if !== undefined && !truthy(resolveValue(node.if, scope, fmt))) return null
    count++
    if (count > VIEW_MAX_RENDERED_NODES) {
      throw new OverBudget({ kind: 'nodes', max: VIEW_MAX_RENDERED_NODES })
    }
    const text = (template: string): string => resolveText(template, scope, fmt)
    const kids = (children: ViewNode[]): RenderNode[] =>
      children.flatMap((child, i) => {
        const at = childPath(childPath(path, 'children'), i)
        return expand(child, at, `${key}/${i}`, scope) ?? []
      })

    switch (node.type) {
      case 'stack':
        return { key, kind: 'stack', gap: node.gap ?? 'sm', children: kids(node.children) }
      case 'row':
        return {
          key,
          kind: 'row',
          gap: node.gap ?? 'sm',
          justify: node.justify ?? 'start',
          wrap: node.wrap ?? false,
          children: kids(node.children),
        }
      case 'section':
        return {
          key,
          kind: 'section',
          title: text(node.title),
          collapsed: node.collapsed ?? false,
          children: kids(node.children),
        }
      case 'text':
        return {
          key,
          kind: 'text',
          text: text(node.text),
          tone: node.tone ?? 'neutral',
          size: node.size ?? 'sm',
          weight: node.weight ?? 'regular',
          mono: node.mono ?? false,
          truncate: node.truncate ?? false,
        }
      case 'badge':
        return { key, kind: 'badge', text: text(node.text), tone: node.tone ?? 'neutral' }
      case 'icon':
        return {
          key,
          kind: 'icon',
          name: node.name,
          tone: node.tone ?? 'muted',
          label: node.label ? text(node.label) : '',
        }
      case 'list': {
        const raw = resolveValue(`{{${node.for}}}`, scope, fmt)
        const all = Array.isArray(raw) ? raw : []
        const max = node.limit ?? VIEW_MAX_LIST_ITEMS
        if (node.limit === undefined && all.length > VIEW_MAX_LIST_ITEMS) {
          throw new OverBudget({ kind: 'list', path, count: all.length, max })
        }
        const items = all.slice(0, max).flatMap((item, i) => {
          const inner = { ...scope, [node.as]: item }
          const k = `${key}${itemKey(item, i)}`
          return expand(node.item, childPath(path, 'item'), k, inner) ?? []
        })
        return {
          key,
          kind: 'list',
          gap: node.gap ?? 'none',
          items,
          empty: items.length === 0 && node.empty ? text(node.empty) : null,
        }
      }
      case 'button': {
        const action: ViewActionTarget =
          'openUrl' in node.action
            ? { kind: 'url', url: safeUrl(resolveValue(node.action.openUrl, scope, fmt)) }
            : {
                kind: 'command',
                command: node.action.command,
                ...(node.action.args
                  ? {
                      template: node.action.args,
                      args: resolveArgs(node.action.args, scope, fmt) as Record<string, unknown>,
                    }
                  : {}),
              }
        return {
          key,
          kind: 'button',
          label: text(node.label),
          icon: node.icon ?? null,
          variant: node.variant ?? 'outline',
          action,
        }
      }
      case 'link':
        return {
          key,
          kind: 'link',
          label: text(node.label),
          url: safeUrl(resolveValue(node.url, scope, fmt)),
        }
      case 'progress': {
        const value =
          typeof node.value === 'number' ? node.value : resolveValue(node.value, scope, fmt)
        return {
          key,
          kind: 'progress',
          ratio: ratioOf(value, node.max ?? 100),
          label: node.label ? text(node.label) : '',
          tone: node.tone ?? 'brand',
        }
      }
      case 'kv':
        return {
          key,
          kind: 'kv',
          items: node.items.map((pair) => ({ key: text(pair.key), value: text(pair.value) })),
        }
      case 'divider':
        return { key, kind: 'divider' }
    }
  }

  try {
    return { ok: true, root: expand(doc.root, 'root', 'root', data) }
  } catch (err) {
    if (err instanceof OverBudget) return { ok: false, problem: err.problem }
    throw err
  }
}
