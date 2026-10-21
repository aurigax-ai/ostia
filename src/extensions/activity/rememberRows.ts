import { emptyState, h, icon } from '@aurigax-ai/ostia-extension-sdk/panel'
import archiveBox from '@phosphor-icons/core/regular/archive.svg'
import arrowCounterClockwise from '@phosphor-icons/core/regular/arrow-counter-clockwise.svg'
import check from '@phosphor-icons/core/regular/check.svg'
import listChecks from '@phosphor-icons/core/regular/list-checks.svg'
import robot from '@phosphor-icons/core/regular/robot.svg'
import { createPatcher, type Item, type Row, setAttr, setText } from './listPatch'
import type { RememberState } from './rememberItem'
import {
  daysLeft,
  fadeOf,
  type RememberGroup,
  type RememberRow,
  type RememberView,
} from './rememberView'
import { ageText, type RowEnv } from './rows'

const STATES: readonly RememberState[] = ['open', 'done', 'archived']

export type RememberEnv = Pick<RowEnv, 't' | 'now'> & {
  setState: (id: string, state: RememberState) => void
  focusPane: (paneId: string) => void
  setFilter: (filter: RememberState) => void
}

interface FiltersItem {
  kind: 'filters'
  filter: RememberState
  counts: Record<RememberState, number>
}

interface GroupItem {
  kind: 'group'
  filter: RememberState
  group: RememberGroup
  days: number
}

interface EmptyItem {
  kind: 'empty'
  filter: RememberState
  days: number
}

type ViewItem = FiltersItem | GroupItem | EmptyItem

function filtersRow(env: RememberEnv): Row<ViewItem> {
  const buttons = new Map<RememberState, { el: HTMLElement; count: HTMLElement }>()
  const el = h('div', { class: 'filters', role: 'group', 'aria-label': env.t('remember.filter') })
  for (const state of STATES) {
    const count = h('span', { class: 'n' })
    const button = h(
      'button',
      { class: 'quiet', type: 'button', onClick: () => env.setFilter(state) },
      env.t(`remember.filter.${state}`),
      count,
    )
    buttons.set(state, { el: button, count })
    el.append(button)
  }
  return {
    el,
    update: (item) => {
      if (item.kind !== 'filters') return []
      for (const [state, button] of buttons) {
        setAttr(button.el, 'aria-pressed', String(state === item.filter))
        setText(button.count, String(item.counts[state]))
      }
      return []
    },
  }
}

function iconButton(svg: string, label: string, onClick: () => void, strong: boolean): HTMLElement {
  return h(
    'button',
    {
      class: strong ? 'quiet icon strong' : 'quiet icon',
      type: 'button',
      title: label,
      'aria-label': label,
      onClick,
    },
    icon(svg),
  )
}

function itemRow(env: RememberEnv, filter: RememberState, days: number): Row<RememberRow> {
  const text = h('p', { class: 'note-text' })
  const age = h('time', { class: 'age muted' })
  const actions = h('span', { class: 'item-actions' })
  const expiry = h('span', { class: 'grow expiry' })
  const meta = h(
    'div',
    { class: 'item-meta', hidden: true },
    expiry,
    h('span', { class: 'item-actions' }),
  )
  const body = h(
    'div',
    { class: 'item-body' },
    h('div', { class: 'item-line' }, text, age, actions),
    meta,
  )
  const el = h('li', { class: 'note-row item' }, icon(listChecks), body)
  let current: RememberRow | null = null
  const button = (state: RememberState, label: string, svg: string, strong: boolean): HTMLElement =>
    iconButton(svg, label, () => current && env.setState(current.id, state), strong)
  const metaActions = meta.lastElementChild as HTMLElement
  return {
    el,
    update: (row) => {
      current = row
      const changed: HTMLElement[] = []
      if (setText(text, row.text)) changed.push(text)
      age.dataset.t = String(row.start)
      const now = env.now()
      setText(age, ageText(env, row.start))
      const fade = filter === 'open' ? fadeOf(row.start, now, days) : 'old'
      setAttr(el, 'data-age', filter === 'open' ? fade : null)
      const left = daysLeft(row.start, now, days)
      const expiring = filter === 'open' && fade === 'old'
      meta.hidden = !expiring
      setText(expiry, expiring ? env.t('remember.expiresIn', { count: left }) : '')
      const buttons =
        filter === 'open'
          ? [
              button('done', env.t('remember.done'), check, true),
              button('archived', env.t('remember.archive'), archiveBox, false),
            ]
          : [button('open', env.t('remember.restore'), arrowCounterClockwise, true)]
      const target = expiring ? metaActions : actions
      const other = expiring ? actions : metaActions
      other.replaceChildren()
      target.replaceChildren(...buttons)
      return changed
    },
  }
}

const WHERE_KEYS = {
  open: 'remember.where.open',
  parked: 'remember.where.parked',
  closed: 'remember.where.closed',
}

function groupRow(env: RememberEnv, first: GroupItem): Row<ViewItem> {
  const name = h('span', { class: 'agent-name' })
  const count = h('span', { class: 'count' })
  const where = h('button', { class: 'quiet', type: 'button' }) as HTMLButtonElement
  const head = h(
    'div',
    { class: 'agent-head' },
    icon(robot),
    name,
    count,
    h('span', { class: 'ostia-spacer' }),
    where,
  )
  const list = h('ul', { class: 'notes' })
  const el = h('article', { class: 'agent compact', 'data-session': first.group.key }, head, list)
  const patch = createPatcher<RememberRow>(
    list,
    (row) => {
      const built = itemRow(env, first.filter, first.days)
      built.update(row)
      return built
    },
    env.now,
  )
  let paneId = first.group.paneId
  where.addEventListener('click', () => {
    if (where.dataset.where === 'open') env.focusPane(paneId)
  })
  return {
    el,
    update: (item) => {
      if (item.kind !== 'group') return []
      const { group } = item
      paneId = group.paneId
      const base = group.label.agent ? env.t(`agent.${group.label.agent}`) : env.t('stream.pane')
      setText(name, group.label.title ? `${base} · ${group.label.title}` : base)
      setText(count, String(group.rows.length))
      setText(where, env.t(WHERE_KEYS[group.where]))
      where.dataset.where = group.where
      where.disabled = group.where !== 'open'
      patch(
        group.rows.map((row) => ({
          key: row.id,
          sig: JSON.stringify([
            row,
            item.filter,
            fadeOf(row.start, env.now(), item.days),
            daysLeft(row.start, env.now(), item.days),
          ]),
          value: row,
        })),
      )
      return []
    },
  }
}

function emptyRow(env: RememberEnv): Row<ViewItem> {
  const el = h('div')
  return {
    el,
    update: (item) => {
      if (item.kind !== 'empty') return []
      el.replaceChildren(emptyState(env.t(`remember.empty.${item.filter}`, { count: item.days })))
      return []
    },
  }
}

function viewItems(view: RememberView, filter: RememberState, now: number): Item<ViewItem>[] {
  const items: Item<ViewItem>[] = [
    {
      key: 'filters',
      sig: JSON.stringify([filter, view.counts]),
      value: { kind: 'filters', filter, counts: view.counts },
    },
  ]
  const groups = view.groups[filter]
  if (groups.length === 0) {
    items.push({
      key: `empty:${filter}`,
      sig: String(view.days),
      value: { kind: 'empty', filter, days: view.days },
    })
  }
  for (const group of groups) {
    items.push({
      key: `${filter}:${group.key}`,
      sig: JSON.stringify([
        group,
        view.days,
        group.rows.map((row) => [
          fadeOf(row.start, now, view.days),
          daysLeft(row.start, now, view.days),
        ]),
      ]),
      value: { kind: 'group', filter, group, days: view.days },
    })
  }
  return items
}

export function createRememberView(
  container: HTMLElement,
  env: RememberEnv,
): (view: RememberView, filter: RememberState) => void {
  const patch = createPatcher<ViewItem>(
    container,
    (item) => {
      const row =
        item.kind === 'filters'
          ? filtersRow(env)
          : item.kind === 'group'
            ? groupRow(env, item)
            : emptyRow(env)
      row.update(item)
      return row
    },
    env.now,
  )
  return (view, filter) => patch(viewItems(view, filter, env.now()))
}
