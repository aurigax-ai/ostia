import {
  call,
  context,
  errorText,
  h,
  icon,
  onChange,
  panelTranslator,
} from '@aurigax-ai/ostia-extension-sdk/panel'
import caretRight from '@phosphor-icons/core/regular/caret-right.svg'
import chatText from '@phosphor-icons/core/regular/chat-text.svg'
import fileText from '@phosphor-icons/core/regular/file-text.svg'
import globe from '@phosphor-icons/core/regular/globe.svg'
import magnifyingGlass from '@phosphor-icons/core/regular/magnifying-glass.svg'
import noteIcon from '@phosphor-icons/core/regular/note.svg'
import pencilSimple from '@phosphor-icons/core/regular/pencil-simple.svg'
import robot from '@phosphor-icons/core/regular/robot.svg'
import terminalWindow from '@phosphor-icons/core/regular/terminal-window.svg'
import usersThree from '@phosphor-icons/core/regular/users-three.svg'
import warningCircle from '@phosphor-icons/core/regular/warning-circle.svg'
import wrench from '@phosphor-icons/core/regular/wrench.svg'
import type { ToolKind } from './hookEvent'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import { type MarkdownNode, renderMarkdown } from './markdown'
import {
  type AgentView,
  type EventView,
  type NoteView,
  type PaneLabel,
  type PanelModel,
  type StreamEndpoint,
  type StreamRow,
  type TurnView,
  type WorkspaceView,
  actionCounts,
  ageOf,
} from './view'

const AGE_REFRESH_MS = 30_000

const TOOL_ICONS: Record<ToolKind, string> = {
  edit: pencilSimple,
  command: terminalWindow,
  search: magnifyingGlass,
  read: fileText,
  subagent: usersThree,
  web: globe,
  other: wrench,
}

const t = panelTranslator({ en: en.messages, 'zh-Hant': zhHant.messages })

const root = document.getElementById('root') as HTMLElement
const list = h('main', { class: 'list' })
const recapButton = viewButton(false)
const activityButton = viewButton(true)
const notes = new Map<string, string>()
const doneFailures = new Map<string, string>()
const openGroups = new Set<string>()
let groupSeq = 0
let model: PanelModel | null = null

function viewButton(showActivity: boolean): HTMLElement {
  return h(
    'button',
    {
      class: 'tab',
      type: 'button',
      'data-view': showActivity ? 'activity' : 'recap',
      onClick: () => void setShowActivity(showActivity),
    },
    t(showActivity ? 'view.activity' : 'view.recap'),
  )
}

function ageText(then: number): string {
  const age = ageOf(then, Date.now())
  return age.unit === 'now' ? t('time.now') : t(`time.${age.unit}`, { count: age.count })
}

function age(then: number): HTMLElement {
  return h(
    'time',
    {
      class: 'age muted',
      'data-t': String(then),
      title: new Date(then).toLocaleString(context.locale),
    },
    ageText(then),
  )
}

function refreshAges(): void {
  for (const el of list.querySelectorAll<HTMLElement>('time[data-t]')) {
    el.textContent = ageText(Number(el.dataset.t))
  }
}

function toDom(node: MarkdownNode): Node | string {
  if (typeof node === 'string') return node
  const attrs: Record<string, string> = node.href
    ? { href: node.href, target: '_blank', rel: 'noopener noreferrer' }
    : {}
  return h(node.tag, attrs, ...node.children.map(toDom))
}

function markdown(source: string): HTMLElement {
  return h('div', { class: 'markdown' }, ...renderMarkdown(source).map(toDom))
}

function actionSummary(events: readonly EventView[]): string {
  const text = actionCounts(events)
    .map(({ category, count }) =>
      t(`summary.${category}.${count === 1 ? 'one' : 'other'}`, { count }),
    )
    .join(t('summary.separator'))
  return text.charAt(0).toLocaleUpperCase(context.locale) + text.slice(1)
}

function actionRow(event: EventView): HTMLElement {
  const tool = event.tool ?? 'other'
  return h(
    'li',
    { class: 'event', 'data-tool': tool },
    icon(TOOL_ICONS[tool]),
    h('span', { class: 'event-label muted' }, t(`event.tool.${tool}`)),
    event.text ? h('code', { class: 'event-text' }, event.text) : null,
  )
}

function actionGroup(key: string, events: readonly EventView[]): HTMLElement | null {
  const tools = events.filter((event) => event.kind === 'tool')
  if (tools.length === 0) return null
  const id = `actions-${groupSeq++}`
  const open = openGroups.has(key)
  const body = h('ul', { class: 'action-list', id, hidden: !open }, ...tools.map(actionRow))
  const toggle = h(
    'button',
    {
      class: 'actions-toggle',
      type: 'button',
      'aria-expanded': String(open),
      'aria-controls': id,
      onClick: () => {
        const next = toggle.getAttribute('aria-expanded') !== 'true'
        toggle.setAttribute('aria-expanded', String(next))
        body.hidden = !next
        body.classList.toggle('motion-reveal', next)
        if (next) openGroups.add(key)
        else openGroups.delete(key)
      },
    },
    icon(caretRight),
    h('span', { class: 'actions-summary' }, actionSummary(tools)),
  )
  return h('div', { class: 'actions' }, toggle, body)
}

function turnNode(agent: AgentView, turn: TurnView, current: boolean): HTMLElement {
  return h(
    'li',
    { class: 'turn', 'data-state': current ? (agent.state ?? 'idle') : 'past' },
    h('span', { class: 'node', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'turn-head' },
      icon(chatText),
      h('p', { class: 'prompt' }, turn.prompt ?? ''),
      age(turn.start),
    ),
    turn.recap ? markdown(turn.recap) : null,
    actionGroup(`${agent.paneId}:${turn.start}`, turn.events),
  )
}

function timeline(agent: AgentView): HTMLElement {
  return h(
    'ol',
    { class: 'timeline', 'aria-label': t('timeline') },
    turnNode(agent, agent.current, true),
    ...agent.earlier.map((turn) => turnNode(agent, turn, false)),
  )
}

function labelText(label: PaneLabel): string {
  const base = label.agent ? t(`agent.${label.agent}`) : t('stream.pane')
  return label.n > 1 ? `${base} ${label.n}` : base
}

function endpointText(endpoint: StreamEndpoint | undefined): string {
  if (!endpoint) return ''
  return endpoint.kind === 'pane' ? labelText(endpoint.label) : t(`stream.${endpoint.kind}`)
}

function streamText(row: StreamRow): string {
  const who = labelText(row.subject)
  if (row.host === 'bus') {
    return t(`stream.bus.${row.message ?? 'message'}`, {
      from: endpointText(row.from),
      to: endpointText(row.to),
    })
  }
  if (row.host === 'state') return t(`stream.state.${row.state}`, { who })
  const folder = row.folder === '.' ? t('stream.rootFolder') : (row.folder ?? '')
  return t(`stream.${row.host}`, { who, folder })
}

function streamRow(row: StreamRow): HTMLElement {
  return h(
    'li',
    {
      class: 'turn stream-row',
      'data-host': row.host,
      'data-state': row.host === 'state' && row.state ? row.state : 'past',
    },
    h('span', { class: 'node', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'turn-head' },
      h('p', { class: 'stream-text' }, streamText(row)),
      row.host === 'bus' && row.state
        ? h('span', { class: 'phase muted' }, t(`stream.phase.${row.state}`))
        : null,
      age(row.t),
    ),
  )
}

function stream(workspace: WorkspaceView): HTMLElement | null {
  if (workspace.stream.length === 0) return null
  return h(
    'section',
    { class: 'stream' },
    h('h2', { class: 'stream-title muted' }, t('stream')),
    h('ol', { class: 'timeline', 'aria-label': t('stream') }, ...workspace.stream.map(streamRow)),
  )
}

function agentCard(agent: AgentView, showActivity: boolean): HTMLElement {
  const name = t(`agent.${agent.agent}`)
  const note = notes.get(agent.paneId)
  return h(
    'article',
    { class: 'agent', 'data-pane': agent.paneId },
    h(
      'button',
      {
        class: 'agent-head',
        type: 'button',
        title: t('show', { agent: name }),
        onClick: () => void focusPane(agent.paneId),
      },
      icon(robot),
      h('span', { class: 'agent-name' }, name),
      agent.state
        ? h('span', { class: 'state', 'data-state': agent.state }, t(`state.${agent.state}`))
        : null,
      h('span', { class: 'spacer' }),
      age(agent.last),
    ),
    note ? h('p', { class: 'note muted', role: 'status' }, note) : null,
    showActivity ? timeline(agent) : agent.recap ? markdown(agent.recap) : null,
  )
}

function noteRow(workspaceId: string, note: NoteView): HTMLElement {
  const open = note.needsYou && !note.done
  const failed = doneFailures.get(note.id)
  return h(
    'li',
    {
      class: 'note-row',
      'data-note': note.id,
      'data-needs-you': String(note.needsYou),
      'data-done': String(note.done),
    },
    icon(note.needsYou ? warningCircle : noteIcon),
    h(
      'div',
      { class: 'note-body' },
      note.needsYou
        ? h('span', { class: 'needs-you' }, t(note.done ? 'noteDone' : 'needsYou'))
        : null,
      h('p', { class: 'note-text' }, note.text),
      note.link ? h('code', { class: 'note-link muted' }, note.link) : null,
      failed ? h('p', { class: 'note muted', role: 'status' }, failed) : null,
    ),
    age(note.t),
    open
      ? h(
          'button',
          {
            class: 'done-button',
            type: 'button',
            onClick: () => void markDone(workspaceId, note.id),
          },
          t('markDone'),
        )
      : null,
  )
}

function notesList(workspace: WorkspaceView): HTMLElement | null {
  if (workspace.notes.length === 0) return null
  return h(
    'ul',
    { class: 'notes', 'aria-label': t('notes') },
    ...workspace.notes.map((note) => noteRow(workspace.workspaceId, note)),
  )
}

function workspaceSection(workspace: WorkspaceView, showActivity: boolean): HTMLElement {
  return h(
    'section',
    { class: 'workspace', 'data-workspace': workspace.workspaceId },
    notesList(workspace),
    showActivity ? stream(workspace) : null,
    ...workspace.agents.map((agent) => agentCard(agent, showActivity)),
  )
}

async function markDone(workspaceId: string, id: string): Promise<void> {
  const res = await call('done', { workspaceId, id })
  if (res.ok) doneFailures.delete(id)
  else doneFailures.set(id, t('doneFailed', { reason: errorText(res) }))
  await refresh()
}

function render(): void {
  if (!model) return
  recapButton.setAttribute('aria-pressed', String(!model.showActivity))
  activityButton.setAttribute('aria-pressed', String(model.showActivity))
  const showActivity = model.showActivity
  if (!model.workspace) {
    list.replaceChildren(h('p', { class: 'center muted' }, t('empty')))
    return
  }
  list.replaceChildren(workspaceSection(model.workspace, showActivity))
}

async function refresh(): Promise<void> {
  const res = await call('snapshot')
  if (!res.ok) {
    if (!model) {
      list.replaceChildren(
        h('p', { class: 'center error' }, t('loadFailed', { reason: errorText(res) })),
      )
    }
    return
  }
  model = res.data as PanelModel
  render()
}

async function setShowActivity(value: boolean): Promise<void> {
  if (!model || model.showActivity === value) return
  model = { ...model, showActivity: value }
  render()
  await call('setShowActivity', { value })
  await refresh()
}

async function focusPane(paneId: string): Promise<void> {
  const res = await call('focus', { paneId })
  if (res.ok) notes.delete(paneId)
  else notes.set(paneId, t(res.error === 'not-reached' ? 'notReached' : 'paneClosed'))
  render()
}

root.replaceChildren(
  h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'toolbar' },
      h('h1', { class: 'title' }, t('title')),
      h('span', { class: 'spacer' }),
      h(
        'div',
        { class: 'tabs', role: 'group', 'aria-label': t('view.label') },
        recapButton,
        activityButton,
      ),
    ),
    list,
  ),
)

onChange(() => void refresh())
setInterval(refreshAges, AGE_REFRESH_MS)
void refresh()
