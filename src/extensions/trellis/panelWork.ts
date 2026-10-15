import { call, errorText, h, icon } from '@aurigax-ai/ostia-extension-sdk/panel'
import caretDown from '@phosphor-icons/core/regular/caret-down.svg'
import robot from '@phosphor-icons/core/regular/robot.svg'
import { refresh } from './panelData'
import { p } from './panelDom'
import { type CardTask, hooks, state } from './panelState'

function taskText(task: CardTask): string {
  return task.agent ? p('task.started', { agent: task.agent }) : p('task.sent')
}

export function taskButton(ref: string, key: string): HTMLElement | null {
  const task = state.tasks.get(ref)
  if (!task) return null
  return h(
    'button',
    {
      class: 'task',
      'data-key': key,
      'data-task': ref,
      title: p('task.show'),
      'aria-label': `${taskText(task)}. ${p('task.show')}`,
      onclick: () => void focusTask(ref),
    },
    icon(robot),
    taskText(task),
  )
}

async function focusTask(ref: string): Promise<void> {
  const res = await call('focus', { ref })
  state.banner = res.ok ? null : errorText(res)
  state.notice = null
  if (!res.ok) await refresh()
}

async function toggleWorkMenu(ref: string): Promise<void> {
  state.workMenu = state.workMenu === ref ? null : ref
  hooks.render()
  if (!state.workMenu || state.agentNames) return
  const res = await call('agents')
  state.agentNames = res.ok ? (res.data as { agents: string[] }).agents : []
  hooks.render()
}

async function handOff(command: 'offer' | 'start', ref: string, agent?: string): Promise<void> {
  state.workMenu = null
  hooks.render()
  const res = await call(command, {
    ref,
    board: state.boardData?.board.slug || undefined,
    ...(agent ? { agent } : {}),
  })
  state.banner = res.ok ? null : errorText(res)
  state.notice =
    res.ok && (res.data as { sent?: boolean }).sent === false ? p('work.notSent') : null
  await refresh()
}

function workMenuView(ref: string): HTMLElement {
  const names = state.agentNames
  return h(
    'div',
    { class: 'work-menu', role: 'menu', 'aria-label': p('work.menu') },
    h(
      'button',
      {
        role: 'menuitem',
        'data-key': 'work-send',
        onclick: () => void handOff('offer', ref),
      },
      p('work.send'),
    ),
    h('p', { class: 'work-heading muted' }, p('work.start')),
    names === null
      ? h('p', { class: 'muted note' }, p('loading'))
      : names.length === 0
        ? h('p', { class: 'muted note' }, p('work.noAgents'))
        : null,
    ...(names ?? []).map((agent) =>
      h(
        'button',
        {
          role: 'menuitem',
          'data-key': `work-start-${agent}`,
          'data-agent': agent,
          onclick: () => void handOff('start', ref, agent),
        },
        p('work.startAgent', { agent }),
      ),
    ),
  )
}

export function workRow(ref: string): HTMLElement {
  const open = state.workMenu === ref
  return h(
    'div',
    { class: 'work-row' },
    h(
      'div',
      { class: 'work' },
      h(
        'button',
        {
          class: 'with-icon primary',
          'data-key': 'work',
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          onclick: () => void toggleWorkMenu(ref),
        },
        p('work.button'),
        icon(caretDown),
      ),
      open ? workMenuView(ref) : null,
    ),
    taskButton(ref, 'task-detail'),
  )
}
