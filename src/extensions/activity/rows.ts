import { context, h, icon, type panelTranslator } from '@aurigax-ai/ostia-extension-sdk/panel'
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
import { createPatcher, type Item, type Row, setAttr, setText } from './listPatch'
import { type MarkdownNode, renderMarkdown } from './markdown'
import {
  type AgentView,
  actionCounts,
  ageOf,
  type EventView,
  groupKey,
  type NoteView,
  type PaneLabel,
  type StreamEndpoint,
  type StreamRow,
  type TurnView,
  type WorkspaceView,
} from './view'

const TOOL_ICONS: Record<ToolKind, string> = {
  edit: pencilSimple,
  command: terminalWindow,
  search: magnifyingGlass,
  read: fileText,
  subagent: usersThree,
  web: globe,
  other: wrench,
}

type Translate = ReturnType<typeof panelTranslator>

export interface RowEnv {
  t: Translate
  now: () => number
  focusAgent: (paneId: string) => void
  focusNote: (note: NoteView) => void
  isOpen: (key: string) => boolean
  setOpen: (key: string, open: boolean) => void
  paneNote: (paneId: string) => string | undefined
  noteFailure: (id: string) => string | undefined
}

export type ListContent =
  | { kind: 'message'; text: string; error: boolean; version: string }
  | { kind: 'workspace'; workspace: WorkspaceView; showActivity: boolean; version: string }

interface NotesItem {
  kind: 'notes'
  workspaceId: string
  notes: NoteView[]
}

interface StreamItem {
  kind: 'stream'
  rows: StreamRow[]
}

interface AgentItem {
  kind: 'agent'
  agent: AgentView
  showActivity: boolean
}

type WorkspaceItem = NotesItem | StreamItem | AgentItem

interface TurnItem {
  agent: AgentView
  turn: TurnView
  current: boolean
}

interface NoteRowItem {
  workspaceId: string
  note: NoteView
}

let groupSeq = 0

function toDom(node: MarkdownNode): Node | string {
  if (typeof node === 'string') return node
  const attrs: Record<string, string> = node.href
    ? { href: node.href, target: '_blank', rel: 'noopener noreferrer' }
    : {}
  return h(node.tag, attrs, ...node.children.map(toDom))
}

function markdownSlot(): { el: HTMLElement; set: (source: string | undefined) => void } {
  const el = h('div', { class: 'markdown', hidden: true })
  let shown: string | undefined
  return {
    el,
    set: (source) => {
      if (source === shown) return
      shown = source
      el.hidden = source === undefined
      el.replaceChildren(...(source === undefined ? [] : renderMarkdown(source).map(toDom)))
    },
  }
}

function ageNode(env: RowEnv): { el: HTMLElement; set: (then: number) => void } {
  const el = h('time', { class: 'age muted' })
  const set = (then: number): void => {
    if (el.dataset.t === String(then)) return
    el.dataset.t = String(then)
    el.title = new Date(then).toLocaleString(context.locale)
    el.textContent = ageText(env, then)
  }
  return { el, set }
}

export function ageText(env: Pick<RowEnv, 't' | 'now'>, then: number): string {
  const age = ageOf(then, env.now())
  return age.unit === 'now' ? env.t('time.now') : env.t(`time.${age.unit}`, { count: age.count })
}

function labelText(env: RowEnv, label: PaneLabel): string {
  const base = label.title ?? (label.agent ? env.t(`agent.${label.agent}`) : env.t('stream.pane'))
  return label.n > 1 ? `${base} ${label.n}` : base
}

function endpointText(env: RowEnv, endpoint: StreamEndpoint | undefined): string {
  if (!endpoint) return ''
  return endpoint.kind === 'pane'
    ? labelText(env, endpoint.label)
    : env.t(`stream.${endpoint.kind}`)
}

function streamText(env: RowEnv, row: StreamRow): string {
  const who = labelText(env, row.subject)
  if (row.host === 'bus') {
    return env.t(`stream.bus.${row.message ?? 'message'}`, {
      from: endpointText(env, row.from),
      to: endpointText(env, row.to),
    })
  }
  if (row.host === 'state') return env.t(`stream.state.${row.state}`, { who })
  const folder = row.folder === '.' ? env.t('stream.rootFolder') : (row.folder ?? '')
  return env.t(`stream.${row.host}`, { who, folder })
}

function actionSummary(env: RowEnv, events: readonly EventView[]): string {
  const text = actionCounts(events)
    .map(({ category, count }) =>
      env.t(`summary.${category}.${count === 1 ? 'one' : 'other'}`, { count }),
    )
    .join(env.t('summary.separator'))
  return text.charAt(0).toLocaleUpperCase(context.locale) + text.slice(1)
}

function actionRow(env: RowEnv, event: EventView): Row<EventView> {
  const tool = event.tool ?? 'other'
  const el = h(
    'li',
    { class: 'event', 'data-tool': tool },
    icon(TOOL_ICONS[tool]),
    h('span', { class: 'event-label muted' }, env.t(`event.tool.${tool}`)),
    event.text ? h('code', { class: 'event-text' }, event.text) : null,
  )
  return { el, update: () => [] }
}

function actionItems(events: readonly EventView[]): Item<EventView>[] {
  return events.map((event, index) => ({
    key: `${index}:${event.tool}:${event.text ?? ''}`,
    sig: '',
    value: event,
  }))
}

function actionGroup(
  env: RowEnv,
  key: string,
): { el: HTMLElement; update: (events: readonly EventView[]) => HTMLElement[] } {
  const id = `actions-${groupSeq++}`
  const summary = h('span', { class: 'actions-summary' })
  const body = h('ul', { class: 'action-list', id, hidden: true })
  const toggle = h(
    'button',
    { class: 'actions-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': id },
    icon(caretRight),
    summary,
  )
  const el = h('div', { class: 'actions', hidden: true }, toggle, body)
  const patch = createPatcher<EventView>(body, (event) => actionRow(env, event), env.now)
  let tools: readonly EventView[] = []
  let restore = env.isOpen(key)
  const open = (value: boolean): void => {
    toggle.setAttribute('aria-expanded', String(value))
    body.hidden = !value
    if (value) patch(actionItems(tools))
  }
  body.addEventListener('animationend', (event) => {
    if (event.target === body) body.classList.remove('motion-reveal')
  })
  toggle.addEventListener('click', () => {
    const next = toggle.getAttribute('aria-expanded') !== 'true'
    open(next)
    body.classList.toggle('motion-reveal', next)
    env.setOpen(key, next)
  })
  return {
    el,
    update: (events) => {
      tools = events.filter((event) => event.kind === 'tool')
      flag(el, 'hidden', tools.length === 0)
      const changed = setText(summary, tools.length === 0 ? '' : actionSummary(env, tools))
      if (restore && tools.length > 0) {
        restore = false
        open(true)
      } else if (!body.hidden) {
        patch(actionItems(tools))
      }
      return changed ? [summary] : []
    },
  }
}

function turnRow(env: RowEnv, key: string): Row<TurnItem> {
  const prompt = h('p', { class: 'prompt' })
  const age = ageNode(env)
  const recap = markdownSlot()
  const actions = actionGroup(env, key)
  const el = h(
    'li',
    { class: 'turn' },
    h('span', { class: 'node', 'aria-hidden': 'true' }),
    h('div', { class: 'turn-head' }, icon(chatText), prompt, age.el),
    recap.el,
    actions.el,
  )
  return {
    el,
    update: ({ agent, turn, current }) => {
      setAttr(el, 'data-state', current ? (agent.state ?? 'idle') : 'past')
      age.set(turn.start)
      recap.set(turn.recap)
      const changed = actions.update(turn.events)
      if (setText(prompt, turn.prompt ?? '')) changed.push(prompt)
      return changed
    },
  }
}

function flag(el: Element, name: string, on: boolean): void {
  setAttr(el, name, on ? '' : null)
}

function builtRow<T>(row: Row<T>, item: T): Row<T> {
  row.update(item)
  return row
}

function turnItems(agent: AgentView): Item<TurnItem>[] {
  return [
    { turn: agent.current, current: true },
    ...agent.earlier.map((turn) => ({ turn, current: false })),
  ].map(({ turn, current }) => ({
    key: groupKey(agent.paneId, turn.start),
    sig: JSON.stringify([turn, current ? (agent.state ?? 'idle') : 'past']),
    value: { agent, turn, current },
  }))
}

function agentRow(env: RowEnv, paneId: string): Row<AgentItem> {
  const name = h('span', { class: 'agent-name' })
  const state = h('span', { class: 'state', hidden: true })
  const age = ageNode(env)
  const head = h(
    'button',
    { class: 'agent-head', type: 'button', onClick: () => env.focusAgent(paneId) },
    icon(robot),
    name,
    state,
    h('span', { class: 'ostia-spacer' }),
    age.el,
  )
  const note = h('p', { class: 'note muted', role: 'status', hidden: true })
  const recap = markdownSlot()
  const timeline = h('ol', { class: 'timeline', 'aria-label': env.t('timeline'), hidden: true })
  const patchTurns = createPatcher<TurnItem>(
    timeline,
    (item) => builtRow(turnRow(env, groupKey(paneId, item.turn.start)), item),
    env.now,
  )
  const el = h('article', { class: 'agent', 'data-pane': paneId }, head, note, recap.el, timeline)
  return {
    el,
    update: ({ agent, showActivity }) => {
      const label = labelText(env, agent.label)
      const changed: HTMLElement[] = []
      if (setText(name, label)) changed.push(name)
      setAttr(head, 'title', env.t('show', { agent: label }))
      const stateText = agent.state ? env.t(`state.${agent.state}`) : ''
      flag(state, 'hidden', !agent.state)
      setAttr(state, 'data-state', agent.state ?? null)
      if (setText(state, stateText)) changed.push(state)
      age.set(agent.last)
      const paneNote = env.paneNote(paneId)
      flag(note, 'hidden', paneNote === undefined)
      setText(note, paneNote ?? '')
      recap.set(showActivity ? undefined : agent.recap)
      flag(timeline, 'hidden', !showActivity)
      patchTurns(showActivity ? turnItems(agent) : [])
      return changed
    },
  }
}

function noteRow(env: RowEnv, note: NoteView): Row<NoteRowItem> {
  let current = note
  const status = h('span', { class: 'needs-you', hidden: true })
  const text = h('p', { class: 'note-text' })
  const link = h('code', { class: 'note-link muted', hidden: true })
  const pane = h('button', {
    class: 'note-pane',
    type: 'button',
    onClick: () => env.focusNote(current),
  })
  const failure = h('p', { class: 'note muted', role: 'status', hidden: true })
  const age = ageNode(env)
  const el = h(
    'li',
    { class: 'note-row', 'data-note': note.id, 'data-needs-you': String(note.needsYou) },
    icon(note.needsYou ? warningCircle : noteIcon),
    h('div', { class: 'note-body' }, status, text, link, pane, failure),
    age.el,
  )
  return {
    el,
    update: (item) => {
      current = item.note
      const changed: HTMLElement[] = []
      setAttr(el, 'data-done', String(current.done))
      flag(status, 'hidden', !current.needsYou)
      if (setText(status, env.t(current.done ? 'noteDone' : 'needsYou'))) changed.push(status)
      if (setText(text, current.text)) changed.push(text)
      flag(link, 'hidden', current.link === undefined)
      setText(link, current.link ?? '')
      const label = labelText(env, current.label)
      setText(pane, label)
      setAttr(pane, 'title', env.t('show', { agent: label }))
      flag(pane, 'disabled', !current.open)
      const failed = env.noteFailure(current.id)
      flag(failure, 'hidden', failed === undefined)
      setText(failure, failed ?? '')
      age.set(current.t)
      return changed
    },
  }
}

function notesRow(env: RowEnv): Row<NotesItem> {
  const el = h('ul', { class: 'notes', 'aria-label': env.t('notes') })
  const patch = createPatcher<NoteRowItem>(
    el,
    (item) => builtRow(noteRow(env, item.note), item),
    env.now,
  )
  return {
    el,
    update: ({ workspaceId, notes }) => {
      patch(
        notes.map((note) => ({
          key: `note:${note.id}`,
          sig: JSON.stringify([note, env.noteFailure(note.id)]),
          value: { workspaceId, note },
        })),
      )
      return []
    },
  }
}

function streamRowNode(env: RowEnv): Row<StreamRow> {
  const text = h('p', { class: 'stream-text' })
  const phase = h('span', { class: 'phase muted', hidden: true })
  const age = ageNode(env)
  const el = h(
    'li',
    { class: 'turn stream-row' },
    h('span', { class: 'node', 'aria-hidden': 'true' }),
    h('div', { class: 'turn-head' }, text, phase, age.el),
  )
  return {
    el,
    update: (next) => {
      setAttr(el, 'data-host', next.host)
      setAttr(el, 'data-state', next.host === 'state' && next.state ? next.state : 'past')
      const changed: HTMLElement[] = []
      if (setText(text, streamText(env, next))) changed.push(text)
      const phaseText = next.host === 'bus' && next.state ? env.t(`stream.phase.${next.state}`) : ''
      flag(phase, 'hidden', phaseText === '')
      if (setText(phase, phaseText)) changed.push(phase)
      age.set(next.t)
      return changed
    },
  }
}

function streamRow(env: RowEnv): Row<StreamItem> {
  const list = h('ol', { class: 'timeline', 'aria-label': env.t('stream') })
  const el = h(
    'section',
    { class: 'stream' },
    h('h2', { class: 'stream-title muted' }, env.t('stream')),
    list,
  )
  const patch = createPatcher<StreamRow>(list, (row) => builtRow(streamRowNode(env), row), env.now)
  return {
    el,
    update: ({ rows }) => {
      patch(rows.map((row) => ({ key: `host:${row.id}`, sig: JSON.stringify(row), value: row })))
      return []
    },
  }
}

function workspaceItems(
  env: RowEnv,
  workspace: WorkspaceView,
  showActivity: boolean,
): Item<WorkspaceItem>[] {
  const items: Item<WorkspaceItem>[] = []
  if (workspace.notes.length > 0) {
    items.push({
      key: 'notes',
      sig: JSON.stringify([workspace.notes, workspace.notes.map((n) => env.noteFailure(n.id))]),
      value: { kind: 'notes', workspaceId: workspace.workspaceId, notes: workspace.notes },
    })
  }
  if (showActivity && workspace.stream.length > 0) {
    items.push({
      key: 'stream',
      sig: JSON.stringify(workspace.stream),
      value: { kind: 'stream', rows: workspace.stream },
    })
  }
  for (const agent of workspace.agents) {
    items.push({
      key: `agent:${agent.paneId}`,
      sig: JSON.stringify([agent, showActivity, env.paneNote(agent.paneId)]),
      value: { kind: 'agent', agent, showActivity },
    })
  }
  return items
}

function workspaceChild(env: RowEnv, item: WorkspaceItem): Row<WorkspaceItem> {
  const build = (): Row<WorkspaceItem> => {
    if (item.kind === 'notes') return narrow(notesRow(env), 'notes')
    if (item.kind === 'stream') return narrow(streamRow(env), 'stream')
    return narrow(agentRow(env, item.agent.paneId), 'agent')
  }
  return builtRow(build(), item)
}

function narrow<K extends WorkspaceItem['kind']>(
  row: Row<Extract<WorkspaceItem, { kind: K }>>,
  kind: K,
): Row<WorkspaceItem> {
  return {
    el: row.el,
    update: (item) =>
      item.kind === kind ? row.update(item as Extract<WorkspaceItem, { kind: K }>) : [],
  }
}

function workspaceRow(
  env: RowEnv,
  content: Extract<ListContent, { kind: 'workspace' }>,
): Row<ListContent> {
  const el = h('section', { class: 'workspace', 'data-workspace': content.workspace.workspaceId })
  const patch = createPatcher<WorkspaceItem>(el, (item) => workspaceChild(env, item), env.now)
  return {
    el,
    update: (next) => {
      if (next.kind === 'workspace') {
        patch(workspaceItems(env, next.workspace, next.showActivity))
      }
      return []
    },
  }
}

function messageRow(): Row<ListContent> {
  const el = h('p', { class: 'center muted' })
  return {
    el,
    update: (next) => {
      if (next.kind !== 'message') return []
      el.classList.toggle('error', next.error)
      el.classList.toggle('muted', !next.error)
      return setText(el, next.text) ? [el] : []
    },
  }
}

export function createListView(
  container: HTMLElement,
  env: RowEnv,
): (content: ListContent) => void {
  const patch = createPatcher<ListContent>(
    container,
    (content) =>
      builtRow(content.kind === 'workspace' ? workspaceRow(env, content) : messageRow(), content),
    env.now,
  )
  return (content) => {
    patch([{ key: content.kind, sig: content.version, value: content }])
  }
}
