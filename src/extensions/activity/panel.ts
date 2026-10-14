import chatText from '@phosphor-icons/core/regular/chat-text.svg'
import checkCircle from '@phosphor-icons/core/regular/check-circle.svg'
import fileText from '@phosphor-icons/core/regular/file-text.svg'
import globe from '@phosphor-icons/core/regular/globe.svg'
import magnifyingGlass from '@phosphor-icons/core/regular/magnifying-glass.svg'
import pencilSimple from '@phosphor-icons/core/regular/pencil-simple.svg'
import robot from '@phosphor-icons/core/regular/robot.svg'
import terminalWindow from '@phosphor-icons/core/regular/terminal-window.svg'
import usersThree from '@phosphor-icons/core/regular/users-three.svg'
import wrench from '@phosphor-icons/core/regular/wrench.svg'
import { call, errorText, h, icon, onChange, panelTranslator } from '../sdk/panel'
import type { ToolKind } from './hookEvent'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import {
  type AgentView,
  type EventView,
  type PanelModel,
  type TurnView,
  type WorkspaceView,
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
const expanded = new Set<string>()
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
  return h('time', { class: 'age muted', 'data-t': String(then) }, ageText(then))
}

function refreshAges(): void {
  for (const el of list.querySelectorAll<HTMLElement>('time[data-t]')) {
    el.textContent = ageText(Number(el.dataset.t))
  }
}

function eventRow(event: EventView): HTMLElement {
  if (event.kind === 'prompt') {
    return h(
      'li',
      { class: 'event', 'data-kind': 'prompt' },
      icon(chatText),
      h('span', { class: 'event-label muted' }, t('event.prompt')),
      event.text ? h('span', { class: 'event-text' }, event.text) : null,
    )
  }
  if (event.kind === 'stop') {
    return h(
      'li',
      { class: 'event', 'data-kind': 'stop' },
      icon(checkCircle),
      h('span', { class: 'event-label muted' }, t('event.stop')),
    )
  }
  const tool = event.tool ?? 'other'
  return h(
    'li',
    { class: 'event', 'data-kind': 'tool', 'data-tool': tool },
    icon(TOOL_ICONS[tool]),
    h('span', { class: 'event-label muted' }, t(`event.tool.${tool}`)),
    event.text ? h('code', { class: 'event-text' }, event.text) : null,
  )
}

function turnEvents(turn: TurnView): HTMLElement {
  return h('ul', { class: 'events' }, ...turn.events.map(eventRow))
}

function earlierTurn(turn: TurnView): HTMLElement {
  return h(
    'div',
    { class: 'turn' },
    turnEvents(turn),
    turn.recap ? h('p', { class: 'recap muted' }, turn.recap) : null,
  )
}

function earlierTurns(agent: AgentView): HTMLElement | null {
  if (agent.earlier.length === 0) return null
  const details = h(
    'details',
    { class: 'earlier', open: expanded.has(agent.paneId) },
    h('summary', { class: 'muted' }, t('earlier', { count: agent.earlier.length })),
    ...agent.earlier.map(earlierTurn),
  ) as HTMLDetailsElement
  details.addEventListener('toggle', () => {
    if (details.open) expanded.add(agent.paneId)
    else expanded.delete(agent.paneId)
  })
  return details
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
    agent.recap ? h('p', { class: 'recap' }, agent.recap) : null,
    note ? h('p', { class: 'note muted', role: 'status' }, note) : null,
    showActivity ? turnEvents(agent.current) : null,
    showActivity ? earlierTurns(agent) : null,
  )
}

function workspaceSection(workspace: WorkspaceView, showActivity: boolean): HTMLElement {
  return h(
    'section',
    { class: 'workspace', 'data-workspace': workspace.workspaceId },
    h('h2', { class: 'workspace-name muted' }, workspace.name),
    ...workspace.agents.map((agent) => agentCard(agent, showActivity)),
  )
}

function render(): void {
  if (!model) return
  recapButton.setAttribute('aria-pressed', String(!model.showActivity))
  activityButton.setAttribute('aria-pressed', String(model.showActivity))
  const showActivity = model.showActivity
  if (model.workspaces.length === 0) {
    list.replaceChildren(h('p', { class: 'center muted' }, t('empty')))
    return
  }
  list.replaceChildren(...model.workspaces.map((w) => workspaceSection(w, showActivity)))
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
