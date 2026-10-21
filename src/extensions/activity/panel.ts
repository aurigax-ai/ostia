import {
  call,
  errorText,
  h,
  onChange,
  onPanelToolbar,
  panelTranslator,
  setPanelToolbar,
} from '@aurigax-ai/ostia-extension-sdk/panel'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import { createParkedView } from './parkedRows'
import type { ParkedView } from './parkedView'
import type { RememberState } from './rememberItem'
import { createRememberView } from './rememberRows'
import type { RememberView } from './rememberView'
import { ageText, createListView, type ListContent, type RowEnv } from './rows'
import type { PanelSnapshot } from './snapshot'
import { liveKeys, type NoteView, type PanelModel, widen } from './view'

const AGE_REFRESH_MS = 30_000
const TITLE_POLL_MS = 2000
const MORE_MARGIN_PX = 200

const t = panelTranslator({ en: en.messages, 'zh-Hant': zhHant.messages })

type Tab = 'activity' | 'parked' | 'remember'

const root = document.getElementById('root') as HTMLElement
const list = h('div', { class: 'list' })
const rememberList = h('div', { class: 'list' })
const viewSwitch = h('div', { class: 'filters', role: 'group', 'aria-label': t('view.label') })
const activityPage = h('main', { class: 'tab-page' }, viewSwitch, list)
const rememberPage = h('main', { class: 'tab-page', hidden: true }, rememberList)
const parkedList = h('div', { class: 'list' })
const parkedPage = h('main', { class: 'tab-page', hidden: true }, parkedList)
const parkedLines = new Map<string, { text: string; error: boolean }>()
let tab: Tab = new URLSearchParams(location.search).get('tab') === 'parked' ? 'parked' : 'activity'
let rememberFilter: RememberState = 'open'
const paneNotes = new Map<string, string>()
const noteFailures = new Map<string, string>()
const openGroups = new Set<string>()
const limits = new Map<string, number>()
let model: (PanelModel & { rev: string; remember: RememberView; parked: ParkedView[] }) | null =
  null
let loadError: string | null = null
let localVersion = 0
let refreshing = false
let refreshAgain = false

const env: RowEnv = {
  t,
  now: Date.now,
  focusAgent: (paneId) => void focusPane(paneId, paneNotes, paneId),
  focusNote: (note: NoteView) => void focusPane(note.pane, noteFailures, note.id),
  markDone: (workspaceId, id) => void markDone(workspaceId, id),
  isOpen: (key) => openGroups.has(key),
  setOpen: (key, open) => {
    if (open) openGroups.add(key)
    else openGroups.delete(key)
  },
  paneNote: (paneId) => paneNotes.get(paneId),
  noteFailure: (id) => noteFailures.get(id),
  watchMore: (el) => {
    moreObserver.unobserve(el)
    moreObserver.observe(el)
  },
  loadMore,
}

function loadMore(el: HTMLElement): void {
  const key = el.dataset.more
  if (key === undefined) return
  if (widen(limits, key, Number(el.dataset.loaded))) void refresh()
}

const moreObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) if (entry.isIntersecting) loadMore(entry.target as HTMLElement)
  },
  { root: list, rootMargin: `0px 0px ${MORE_MARGIN_PX}px 0px` },
)

const show = createListView(list, env)
const showParked = createParkedView(parkedList, {
  t,
  now: Date.now,
  resume: (id) => void parkedAct(id, 'parkedResume'),
  forget: (id) => void parkedAct(id, 'parkedForget'),
  line: (id) => parkedLines.get(id),
})
const showRemember = createRememberView(rememberList, {
  t,
  now: Date.now,
  setState: (id, state) => void setRememberState(id, state),
  focusPane: (paneId) => void focusPane(paneId, paneNotes, paneId),
  setFilter: (filter) => {
    rememberFilter = filter
    render()
  },
})

for (const [value, label] of [
  [false, 'view.recap'],
  [true, 'view.timeline'],
] as const) {
  viewSwitch.append(
    h(
      'button',
      {
        class: 'quiet',
        type: 'button',
        'data-timeline': String(value),
        onClick: () => void setShowActivity(value),
      },
      t(label),
    ),
  )
}

function refreshAges(): void {
  for (const el of list.querySelectorAll<HTMLElement>('time[data-t]')) {
    const text = ageText(env, Number(el.dataset.t))
    if (el.textContent !== text) el.textContent = text
  }
}

function remember(map: Map<string, string>, key: string, value: string | null): void {
  if (map.get(key) === (value ?? undefined)) return
  if (value === null) map.delete(key)
  else map.set(key, value)
  localVersion++
}

function retain(
  collection: { keys: () => Iterable<string>; delete: (key: string) => unknown },
  live: ReadonlySet<string>,
): void {
  for (const key of [...collection.keys()]) if (!live.has(key)) collection.delete(key)
}

function content(): ListContent | null {
  if (!model) {
    return loadError === null
      ? null
      : { kind: 'message', text: loadError, error: true, version: loadError }
  }
  const { rev, showActivity, workspace } = model
  if (!workspace) return { kind: 'message', text: t('empty'), error: false, version: rev }
  return {
    kind: 'workspace',
    workspace,
    showActivity,
    version: `${rev}|${showActivity}|${localVersion}`,
  }
}

function render(): void {
  if (model) {
    const { counts } = model.remember
    setPanelToolbar({
      tab,
      badges: {
        ...(model.parked.length > 0 ? { parked: model.parked.length } : {}),
        ...(counts.open > 0 ? { remember: counts.open } : {}),
      },
    })
    for (const button of viewSwitch.children) {
      setAttribute(button, model.showActivity)
    }
    showRemember(model.remember, rememberFilter)
    showParked(model.parked)
  }
  activityPage.hidden = tab !== 'activity'
  parkedPage.hidden = tab !== 'parked'
  rememberPage.hidden = tab !== 'remember'
  const next = content()
  if (next) show(next)
}

function setAttribute(button: Element, timeline: boolean): void {
  button.setAttribute(
    'aria-pressed',
    String((button as HTMLElement).dataset.timeline === String(timeline)),
  )
}

async function load(): Promise<void> {
  const res = await call('snapshot', { rev: model?.rev, limits: Object.fromEntries(limits) })
  if (!res.ok) {
    if (!model) {
      loadError = t('loadFailed', { reason: errorText(res) })
      render()
    }
    return
  }
  const snapshot = res.data as PanelSnapshot
  if ('unchanged' in snapshot) return
  model = snapshot
  loadError = null
  const live = liveKeys(model.workspace)
  retain(paneNotes, live.panes)
  retain(noteFailures, live.notes)
  retain(openGroups, live.groups)
  retain(limits, live.limits)
  render()
}

async function refresh(): Promise<void> {
  if (refreshing) {
    refreshAgain = true
    return
  }
  refreshing = true
  try {
    do {
      refreshAgain = false
      await load()
    } while (refreshAgain)
  } finally {
    refreshing = false
  }
}

async function markDone(workspaceId: string, id: string): Promise<void> {
  const res = await call('done', { workspaceId, id })
  remember(noteFailures, id, res.ok ? null : t('doneFailed', { reason: errorText(res) }))
  if (res.ok) await refresh()
  else render()
}

function parkedFailure(res: { error: string; message?: string }): string {
  if (res.error === 'folder-gone') return t('parked.folderGone', { path: res.message ?? '' })
  if (res.error === 'running-elsewhere') {
    return t('parked.runningElsewhere', { tab: res.message ?? '' })
  }
  if (res.error === 'workspace-closed') return t('parked.workspaceClosed')
  if (res.error === 'unknown-parked') return t('parked.gone')
  return t('parked.failed', { reason: errorText({ ok: false, ...res }) })
}

async function parkedAct(id: string, command: 'parkedResume' | 'parkedForget'): Promise<void> {
  const res = await call(command, { id })
  if (res.ok) {
    if (command === 'parkedResume')
      parkedLines.set(id, { text: t('parked.resuming'), error: false })
    else parkedLines.delete(id)
  } else {
    parkedLines.set(id, { text: parkedFailure(res), error: true })
  }
  await refresh()
  render()
}

async function setRememberState(id: string, state: RememberState): Promise<void> {
  await call('rememberState', { id, state })
  await refresh()
}

async function setShowActivity(value: boolean): Promise<void> {
  if (!model || model.showActivity === value) return
  model = { ...model, showActivity: value, rev: '' }
  render()
  await call('setShowActivity', { value })
  await refresh()
}

async function focusPane(
  paneId: string,
  failures: Map<string, string>,
  key: string,
): Promise<void> {
  const res = await call('focus', { paneId })
  remember(
    failures,
    key,
    res.ok ? null : t(res.error === 'not-reached' ? 'notReached' : 'paneClosed'),
  )
  render()
}

root.replaceChildren(h('div', { class: 'ostia-page' }, activityPage, parkedPage, rememberPage))

onPanelToolbar((event) => {
  if (event.kind !== 'tab') return
  if (event.id === 'activity' || event.id === 'parked' || event.id === 'remember') {
    tab = event.id
    render()
  }
})
onChange(() => void refresh())
setInterval(refreshAges, AGE_REFRESH_MS)
setInterval(() => void refresh(), TITLE_POLL_MS)
void refresh()
