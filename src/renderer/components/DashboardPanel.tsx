import { cn } from '@/lib/utils'
import { AppWindowIcon, ArrowSquareOutIcon, ChatTextIcon, XIcon } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { allPanes, paneIds } from '../layout/tree'
import { unreadCount } from '../lib/attention'
import {
  DASHBOARD_PATH_CHARS,
  type NeedsYouItem,
  type PaneWhere,
  needsYouItems,
  paneWhere,
} from '../lib/dashboard'
import { shortenPath } from '../lib/railMeta'
import { type RemoteWorkspace, remoteWorkspacesOf } from '../lib/windowWorkspaces'
import { markWorkspaceRead, revealPane } from '../lib/workspaceActivity'
import { latestAttentionMessage, runningTitle } from '../lib/workspaceSummary'
import { useApprovalsStore } from '../stores/approvalsStore'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useQuestionsStore } from '../stores/questionsStore'
import { useUIStore } from '../stores/uiStore'
import { useWindowsStore } from '../stores/windowsStore'
import { type Workspace, type WorkspaceState, useWorkspacesStore } from '../stores/workspacesStore'
import { AgentComposer } from './AgentComposer'
import { ApprovalCard } from './ApprovalCard'
import { WorkspaceChips } from './ExtensionChips'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { stateLabel, useLocalAgentTargets } from './PickSendPanel'
import { QuestionCard } from './QuestionCard'
import { ATTENTION_BADGE } from './attentionStyles'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

const OPEN_POPUP = '[role="dialog"], [role="listbox"], [role="menu"]'
const FIRST_CONTROL = '[role="radio"], [role="checkbox"], textarea, button'

function workspaceStateLabel(d: Dict, state: WorkspaceState): string {
  return stateLabel(d, state === 'idle' ? 'none' : state)
}

function focusCard(root: HTMLElement | null, selector: string): boolean {
  for (const card of root?.querySelectorAll<HTMLElement>(selector) ?? []) {
    const control = card.querySelector<HTMLElement>(FIRST_CONTROL)
    if (!control) continue
    card.scrollIntoView({ block: 'nearest' })
    control.focus()
    return true
  }
  return false
}

export function DashboardPanel(): JSX.Element | null {
  const d = useDict()
  const open = useUIStore((s) => s.dashboardActive)
  const close = useUIStore((s) => s.showWorkspaces)
  const focusId = useQuestionsStore((s) => s.focusId)
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector(OPEN_POPUP)) return
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const root = rootRef.current
    if (!focusCard(root, '[data-question]') && !focusCard(root, '.dashboard-card')) {
      root?.querySelector<HTMLElement>('[data-dashboard-close]')?.focus()
    }
    return () => previous?.focus?.()
  }, [open])

  useEffect(() => {
    if (!open || !focusId) return
    focusCard(rootRef.current, `[data-question="${CSS.escape(focusId)}"]`)
    useQuestionsStore.getState().requestFocus(null)
  }, [open, focusId])

  if (!open) return null

  return (
    <section
      ref={rootRef}
      aria-label={d.dashboard.title}
      className="dashboard absolute inset-0 z-20 flex min-h-0 flex-col overflow-y-auto bg-bg text-fg"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 sm:px-8">
        <header className="flex items-center gap-2">
          <h2 className="flex-1 font-semibold text-ui-lg">{d.dashboard.title}</h2>
          <IconButton
            size="bar"
            icon={XIcon}
            label={d.dashboard.close}
            data-dashboard-close=""
            onClick={close}
          />
        </header>
        <NeedsYou />
        <WorkspacesList />
      </div>
    </section>
  )
}

function SectionTitle({ title, count }: { title: string; count?: number }): JSX.Element {
  return (
    <h3 className="flex items-center gap-2 border-line border-b pb-1 font-medium text-fg-muted text-ui-xs uppercase tracking-caps">
      {title}
      {count ? <span className="text-attn-fg tabular-nums">{count}</span> : null}
    </h3>
  )
}

function EmptyLine({ children }: { children: string }): JSX.Element {
  return <p className="px-1 py-2 text-fg-muted text-ui-sm">{children}</p>
}

function useWhere(): (paneId: string) => PaneWhere | null {
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const layouts = useLayoutStore((s) => s.byWorkspace)
  return useMemo(() => (paneId) => paneWhere(paneId, workspaces, layouts), [workspaces, layouts])
}

function NeedsYou(): JSX.Element {
  const d = useDict()
  const questions = useQuestionsStore((s) => s.pending)
  const sent = useQuestionsStore((s) => s.sent)
  const approvals = useApprovalsStore((s) => s.pending)
  const whereOf = useWhere()
  const items = needsYouItems(questions, sent, approvals)
  const waiting = questions.length + approvals.length
  return (
    <section aria-label={d.dashboard.needsYou} className="flex flex-col gap-2">
      <SectionTitle title={d.dashboard.needsYou} count={waiting} />
      {items.length === 0 ? (
        <EmptyLine>{d.dashboard.needsYouEmpty}</EmptyLine>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id}>
              <NeedsYouCard item={item} where={whereOf(itemPane(item))} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function itemPane(item: NeedsYouItem): string {
  return item.kind === 'question' ? item.question.paneId : item.approval.paneId
}

function NeedsYouCard({
  item,
  where,
}: { item: NeedsYouItem; where: PaneWhere | null }): JSX.Element {
  const d = useDict()
  if (item.kind === 'question') {
    return <QuestionCard question={item.question} where={where} sent={item.sent} />
  }
  return (
    <ApprovalCard
      request={item.approval}
      paneTitle={where?.pane ?? d.attention.closedPane}
      placement="list"
      lead={
        where ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-fg-muted text-ui-xs">
            <span className="truncate font-medium text-fg">{where.workspace}</span>
            <Hint label={where.path}>
              <span className="truncate font-mono">{where.shortPath}</span>
            </Hint>
            <Button
              variant="link"
              size="xs"
              className="ml-auto h-auto p-0 text-ui-xs"
              onClick={() => revealPane(item.approval.paneId)}
            >
              {d.dashboard.goToPane}
            </Button>
          </div>
        ) : null
      }
    />
  )
}

function WorkspacesList(): JSX.Element {
  const d = useDict()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const windowId = useWindowsStore((s) => s.windowId)
  const windows = useWindowsStore((s) => s.list)
  const remote = remoteWorkspacesOf(windows, windowId)
  return (
    <section aria-label={d.dashboard.workspaces} className="flex flex-col gap-1">
      <SectionTitle title={d.dashboard.workspaces} />
      {workspaces.length === 0 && remote.length === 0 ? (
        <EmptyLine>{d.dashboard.workspacesEmpty}</EmptyLine>
      ) : (
        <ul className="flex flex-col">
          {workspaces.map((workspace) => (
            <WorkspaceEntry key={workspace.id} workspace={workspace} />
          ))}
          {remote.map((workspace) => (
            <RemoteEntry key={workspace.id} workspace={workspace} />
          ))}
        </ul>
      )}
    </section>
  )
}

function StateMark({ state }: { state: WorkspaceState }): JSX.Element {
  const d = useDict()
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-fg-muted text-ui-xs">
      {state === 'idle' ? null : <span className={`dot ${state}`} aria-hidden="true" />}
      {workspaceStateLabel(d, state)}
    </span>
  )
}

function PathText({ path }: { path: string }): JSX.Element {
  return (
    <Hint label={path}>
      <span className="min-w-0 truncate font-mono text-fg-muted text-ui-xs">
        {shortenPath(path, DASHBOARD_PATH_CHARS)}
      </span>
    </Hint>
  )
}

function WorkspaceEntry({ workspace: w }: { workspace: Workspace }): JSX.Element {
  const d = useDict()
  const layout = useLayoutStore((s) => s.byWorkspace[w.id])
  const panes = layout ? allPanes(layout.root) : []
  const message = useAttentionStore((s) => latestAttentionMessage(panes, s.byPane))
  const running = useBlocksStore((s) => runningTitle(panes, layout?.activePaneId, s.running))
  const unread = useAttentionStore((s) =>
    layout ? unreadCount(s.byPane, paneIds(layout.root)) : 0,
  )
  const agents = useLocalAgentTargets(w.id)
  const [composing, setComposing] = useState(false)
  const name = w.customName ?? w.name
  const summary = message ?? running
  const open = (): void => {
    useUIStore.getState().showWorkspaces()
    useWorkspacesStore.getState().setActive(w.id)
  }
  return (
    <li
      data-workspace={w.id}
      className="flex flex-col gap-1 border-line border-b px-1 py-2 last:border-b-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Button
          variant="link"
          size="sm"
          aria-label={fmt(d.dashboard.openWorkspace, { name })}
          className="h-auto min-w-0 justify-start p-0 font-medium text-fg text-ui-base"
          onClick={open}
        >
          <span className="truncate">{name}</span>
        </Button>
        <StateMark state={w.state} />
        {unread > 0 ? (
          <Badge
            variant="outline"
            className={ATTENTION_BADGE}
            role="img"
            aria-label={fmt(d.rail.unread, { n: unread })}
          >
            {unread > 99 ? '99+' : unread}
          </Badge>
        ) : null}
        <PathText path={w.projectDir ?? w.workDir} />
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <WorkspaceChips workspaceId={w.id} />
          {unread > 0 ? (
            <Button variant="ghost" size="xs" onClick={() => markWorkspaceRead(w.id)}>
              {d.rail.markRead}
            </Button>
          ) : null}
          {agents.length > 0 ? (
            <IconButton
              icon={ChatTextIcon}
              label={d.dashboard.message}
              aria-pressed={composing}
              onClick={() => setComposing((on) => !on)}
            />
          ) : null}
        </span>
      </div>
      {summary ? (
        <p className={cn('truncate text-ui-sm', message ? 'text-fg' : 'text-fg-muted')}>
          {summary}
        </p>
      ) : null}
      {agents.length > 0 ? (
        <ul aria-label={d.dashboard.agents} className="flex flex-wrap gap-1">
          {agents.map((agent) => (
            <li key={agent.paneId}>
              <Button
                variant="outline"
                size="xs"
                aria-label={fmt(d.dashboard.goToAgent, {
                  agent: agent.title,
                  state: stateLabel(d, agent.state),
                })}
                className="max-w-64 font-normal"
                onClick={() => revealPane(agent.paneId)}
              >
                <span
                  className={`dot ${agent.state === 'none' ? '' : agent.state}`}
                  aria-hidden="true"
                />
                <span className="truncate">{agent.title}</span>
                <ArrowSquareOutIcon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {composing && agents.length > 0 ? (
        <AgentComposer id={w.id} targets={agents} onCancel={() => setComposing(false)} />
      ) : null}
    </li>
  )
}

function RemoteEntry({ workspace: w }: { workspace: RemoteWorkspace }): JSX.Element {
  const d = useDict()
  return (
    <li
      data-workspace={w.id}
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-line border-b px-1 py-2 last:border-b-0"
    >
      <Button
        variant="link"
        size="sm"
        aria-label={fmt(d.dashboard.openWorkspace, { name: w.name })}
        className="h-auto min-w-0 justify-start p-0 font-medium text-fg text-ui-base"
        onClick={() => window.pine.windows.focusWorkspace(w.id, false)}
      >
        <span className="truncate">{w.name}</span>
      </Button>
      <StateMark state={w.state} />
      <PathText path={w.workDir} />
      <span className="ml-auto flex shrink-0 items-center gap-1 text-fg-muted text-ui-xs">
        <AppWindowIcon size={12} aria-hidden />
        {d.window.inOtherWindow}
      </span>
    </li>
  )
}
