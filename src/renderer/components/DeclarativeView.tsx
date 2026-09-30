import { cn } from '@/lib/utils'
import { CaretDownIcon, CaretRightIcon, WarningIcon } from '@phosphor-icons/react'
import type { ViewDoc, ViewGap, ViewInfo, ViewTone } from '@shared/views'
import { useMemo, useRef, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { useViewScope } from '../lib/useViewScope'
import { type BudgetProblem, type RenderNode, expandView } from '../lib/viewExpand'
import { runViewAction } from '../lib/views'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { Hint } from './Hint'
import { ATTENTION_ALERT } from './attentionStyles'
import { Alert } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Progress } from './ui/progress'
import { Separator } from './ui/separator'
import { viewIcon } from './viewIcons'

export type ViewDensity = 'rail' | 'pane'

export type RenderableView = ViewInfo & { doc: ViewDoc }

const TONE_TEXT: Record<ViewTone, string> = {
  neutral: 'text-fg',
  muted: 'text-fg-muted',
  brand: 'text-brand',
  ok: 'text-ok',
  warn: 'text-attn-fg',
  error: 'text-attn-fg',
}

const TONE_FILL: Record<ViewTone, string> = {
  neutral: '[&_[data-slot=progress-indicator]]:bg-fg-muted',
  muted: '[&_[data-slot=progress-indicator]]:bg-fg-muted',
  brand: '[&_[data-slot=progress-indicator]]:bg-brand',
  ok: '[&_[data-slot=progress-indicator]]:bg-ok',
  warn: '[&_[data-slot=progress-indicator]]:bg-attn',
  error: '[&_[data-slot=progress-indicator]]:bg-attn',
}

const TONE_BADGE: Record<ViewTone, string> = {
  neutral: 'border-line-strong text-fg',
  muted: 'border-line text-fg-muted',
  brand: 'border-brand/50 text-brand',
  ok: 'border-ok/50 text-ok',
  warn: 'border-attn/60 text-attn-fg',
  error: 'border-attn/60 text-attn-fg',
}

const GAP: Record<ViewGap, string> = { none: 'gap-0', sm: 'gap-1', md: 'gap-2', lg: 'gap-3' }

const TEXT_SIZE = { xs: 'text-ui-xs', sm: 'text-ui-sm', base: 'text-ui-base' } as const
const WEIGHT = { regular: 'font-normal', medium: 'font-medium', semibold: 'font-semibold' } as const
const JUSTIFY = { start: 'justify-start', between: 'justify-between', end: 'justify-end' } as const

interface RenderContext {
  view: RenderableView
  density: ViewDensity
  paneId: string | null
  workspaceId?: string
  d: Dict
}

function actionPane(ctx: RenderContext): string | null {
  if (ctx.paneId) return ctx.paneId
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  return workspaceId
    ? (useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId ?? null)
    : null
}

function budgetReason(d: Dict, problem: BudgetProblem): string {
  return problem.kind === 'list'
    ? fmt(d.views.budgetList, { path: problem.path, count: problem.count, max: problem.max })
    : fmt(d.views.budgetNodes, { max: problem.max })
}

function Section({
  node,
  ctx,
}: {
  node: Extract<RenderNode, { kind: 'section' }>
  ctx: RenderContext
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(node.collapsed)
  const Caret = collapsed ? CaretRightIcon : CaretDownIcon
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        className="flex items-center gap-1 self-start rounded-sm text-fg-muted text-ui-xs font-medium hover:text-fg"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
      >
        <Caret size={12} aria-hidden />
        {node.title}
      </button>
      {collapsed ? null : <Nodes nodes={node.children} ctx={ctx} />}
    </section>
  )
}

function Nodes({ nodes, ctx }: { nodes: RenderNode[]; ctx: RenderContext }): JSX.Element {
  return (
    <>
      {nodes.map((n) => (
        <Node key={n.key} node={n} ctx={ctx} />
      ))}
    </>
  )
}

function Node({ node, ctx }: { node: RenderNode; ctx: RenderContext }): JSX.Element | null {
  const rail = ctx.density === 'rail'
  switch (node.kind) {
    case 'stack':
      return (
        <div className={cn('flex min-w-0 flex-col', GAP[node.gap])}>
          <Nodes nodes={node.children} ctx={ctx} />
        </div>
      )
    case 'row':
      return (
        <div
          className={cn(
            'flex min-w-0 items-center',
            GAP[node.gap],
            JUSTIFY[node.justify],
            node.wrap && 'flex-wrap',
          )}
        >
          <Nodes nodes={node.children} ctx={ctx} />
        </div>
      )
    case 'section':
      return <Section node={node} ctx={ctx} />
    case 'text':
      return (
        <span
          className={cn(
            'min-w-0',
            TONE_TEXT[node.tone],
            TEXT_SIZE[node.size],
            WEIGHT[node.weight],
            node.mono && 'font-mono tabular-nums',
            node.truncate ? 'truncate' : 'break-words',
          )}
        >
          {node.text}
        </span>
      )
    case 'badge':
      return node.text ? (
        <Badge
          variant="outline"
          className={cn('h-4 shrink-0 px-1.5 text-ui-xs tabular-nums', TONE_BADGE[node.tone])}
        >
          {node.text}
        </Badge>
      ) : null
    case 'icon': {
      const Icon = viewIcon(node.name)
      return (
        <Icon
          size={rail ? 12 : 14}
          className={cn('shrink-0', TONE_TEXT[node.tone])}
          {...(node.label ? { role: 'img', 'aria-label': node.label } : { 'aria-hidden': true })}
        />
      )
    }
    case 'list':
      return node.items.length === 0 ? (
        node.empty ? (
          <span className="text-fg-muted text-ui-sm">{node.empty}</span>
        ) : null
      ) : (
        <ul className={cn('flex min-w-0 flex-col', GAP[node.gap])}>
          {node.items.map((item) => (
            <li key={item.key} className="min-w-0">
              <Node node={item} ctx={ctx} />
            </li>
          ))}
        </ul>
      )
    case 'button': {
      const Icon = node.icon ? viewIcon(node.icon) : null
      const disabled = node.action.kind === 'url' && !node.action.url
      return (
        <Button
          variant={node.variant}
          size={rail ? 'xs' : 'sm'}
          className="max-w-full min-w-0 shrink-0"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation()
            runViewAction(ctx.view, node.label, node.action, actionPane(ctx), ctx.workspaceId)
          }}
        >
          {Icon ? <Icon data-icon="inline-start" aria-hidden /> : null}
          <span className="truncate">{node.label}</span>
        </Button>
      )
    }
    case 'link': {
      const url = node.url
      if (!url) return <span className="text-fg-muted text-ui-sm">{node.label}</span>
      return (
        <Hint label={fmt(ctx.d.views.openUrl, { url })}>
          <button
            type="button"
            className="w-fit min-w-0 truncate rounded-sm text-brand text-ui-sm underline-offset-2 hover:underline"
            onClick={(e) => {
              e.stopPropagation()
              runViewAction(ctx.view, node.label, { kind: 'url', url }, null, ctx.workspaceId)
            }}
          >
            {node.label}
          </button>
        </Hint>
      )
    }
    case 'progress':
      return (
        <div className="flex min-w-0 flex-col gap-1">
          {node.label ? (
            <div className="flex items-baseline justify-between gap-2 text-ui-xs">
              <span className="truncate text-fg-muted">{node.label}</span>
              <span className="text-fg tabular-nums">{Math.round(node.ratio * 100)}%</span>
            </div>
          ) : null}
          <Progress
            value={Math.round(node.ratio * 100)}
            aria-label={node.label || undefined}
            className={cn('[&_[data-slot=progress-track]]:bg-surface-3', TONE_FILL[node.tone])}
          />
        </div>
      )
    case 'kv':
      return (
        <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-ui-sm">
          {node.items.map((pair, i) => (
            <div key={`${pair.key}-${i}`} className="contents">
              <dt className="truncate text-fg-muted">{pair.key}</dt>
              <dd className="min-w-0 truncate text-fg tabular-nums">{pair.value}</dd>
            </div>
          ))}
        </dl>
      )
    case 'divider':
      return <Separator className="my-1 bg-line" />
  }
}

export function ViewStatusNote({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Alert className={cn(ATTENTION_ALERT, 'flex items-start gap-1.5 text-ui-xs')}>
      <WarningIcon size={12} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </Alert>
  )
}

export function DeclarativeView({
  view,
  density,
  paneId,
  workspaceId,
}: {
  view: RenderableView
  density: ViewDensity
  paneId: string | null
  workspaceId?: string
}): JSX.Element {
  const d = useDict()
  const { scope, format } = useViewScope(view.doc)
  const result = useMemo(() => expandView(view.doc, scope, format), [view.doc, scope, format])
  const lastGood = useRef<RenderNode | null>(null)
  if (result.ok) lastGood.current = result.root
  const root = result.ok ? result.root : lastGood.current
  const ctx: RenderContext = { view, density, paneId, workspaceId, d }
  return (
    <div
      className={cn('flex min-w-0 flex-col', density === 'rail' ? 'gap-1.5' : 'gap-3')}
      data-view={view.name}
    >
      {view.stale ? <ViewStatusNote>{d.views.stale}</ViewStatusNote> : null}
      {result.ok ? null : (
        <ViewStatusNote>
          {fmt(d.views.overBudget, { reason: budgetReason(d, result.problem) })}
        </ViewStatusNote>
      )}
      {root ? <Node node={root} ctx={ctx} /> : null}
    </div>
  )
}
