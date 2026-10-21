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
import { ageText, createListView, type ListContent, type RowEnv } from './rows'
import { liveKeys, type NoteView, type PanelModel, type PanelSnapshot, widen } from './view'

const AGE_REFRESH_MS = 30_000
const TITLE_POLL_MS = 2000
const MORE_MARGIN_PX = 200

const t = panelTranslator({ en: en.messages, 'zh-Hant': zhHant.messages })

const root = document.getElementById('root') as HTMLElement
const list = h('main', { class: 'list' })
const paneNotes = new Map<string, string>()
const noteFailures = new Map<string, string>()
const openGroups = new Set<string>()
const limits = new Map<string, number>()
let model: (PanelModel & { rev: string }) | null = null
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
  if (model) setPanelToolbar({ tab: model.showActivity ? 'activity' : 'recap' })
  const next = content()
  if (next) show(next)
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

root.replaceChildren(h('div', { class: 'ostia-page' }, list))

onPanelToolbar((event) => {
  if (event.kind === 'tab') void setShowActivity(event.id === 'activity')
})
onChange(() => void refresh())
setInterval(refreshAges, AGE_REFRESH_MS)
setInterval(() => void refresh(), TITLE_POLL_MS)
void refresh()
