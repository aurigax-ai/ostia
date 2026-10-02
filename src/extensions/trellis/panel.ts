import type { ExtensionResult } from '@aurigax-ai/pine-extension-sdk'
import {
  call,
  context,
  errorText,
  h,
  icon,
  onChange,
  panelTranslator,
} from '@aurigax-ai/pine-extension-sdk/panel'
import arrowClockwise from '@phosphor-icons/core/regular/arrow-clockwise.svg'
import caretDown from '@phosphor-icons/core/regular/caret-down.svg'
import lockSimple from '@phosphor-icons/core/regular/lock-simple.svg'
import plus from '@phosphor-icons/core/regular/plus.svg'
import robot from '@phosphor-icons/core/regular/robot.svg'
import userCircle from '@phosphor-icons/core/regular/user-circle.svg'
import xIcon from '@phosphor-icons/core/regular/x.svg'
import {
  type ShownColumn,
  type ThreadItem,
  actorName,
  claimState,
  findCard,
  groupEntries,
  moveCard,
  shownColumns,
  threadItems,
} from './board'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import { type RenderNode, renderMarkdown } from './markdown'
import type {
  BoardInfo,
  CardActivity,
  CardDetail,
  CardThread,
  ProjectInfo,
  TrellisBoard,
  TrellisCard,
  VaultEntry,
  VaultEntrySummary,
} from './trellis'

type View = 'board' | 'vault'

interface PanelContext {
  actor: string
  workspace: { project: string; board: string | null } | null
  canInit: boolean
  projects: ProjectInfo[]
}

interface BoardData {
  board: TrellisBoard
  boards: BoardInfo[]
}

interface CardData {
  card: CardDetail
  thread: CardThread | null
}

interface CardTask {
  ref: string
  agent: string | null
}

interface NewCardDraft {
  title: string
  body: string
  column: string
  priority: string
}

const PRIORITY_VALUES = ['urgent', 'high', 'normal', 'low']
const DEFAULT_PRIORITY = 'normal'
const SEND_KEYS = /Mac/.test(navigator.platform) ? '⌘Enter' : 'Ctrl+Enter'
const CARD_REF = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*?)-\d+$/

const t = panelTranslator({ en: en.messages, 'zh-Hant': zhHant.messages })
const p = (key: string, vars?: Record<string, string | number>): string => t(`panel.${key}`, vars)

const params = new URLSearchParams(location.search)
const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root')
const root: HTMLElement = rootEl

let view: View = params.get('view') === 'vault' ? 'vault' : 'board'
let ctx: PanelContext | null = null
let failed: ExtensionResult | null = null
let project: string | null = null
let boardSlug: string | null = null
let boardData: BoardData | null = null
let boardFailure: ExtensionResult | null = null
let openRef: string | null = params.get('card')
let cardData: CardData | null = null
let cardFailure: ExtensionResult | null = null
let cardQuery = ''
let commentDraft = ''
let newCard: NewCardDraft | null = null
let entries: VaultEntrySummary[] | null = null
let vaultFailure: ExtensionResult | null = null
let entryQuery = ''
let openSlug: string | null = null
let entryData: VaultEntry | null = null
let entryFailure: ExtensionResult | null = null
let banner: string | null = null
let notice: string | null = null
let tasks = new Map<string, CardTask>()
let agentNames: string[] | null = null
let workMenu: string | null = null
let busy = false
let requestSeq = 0

const relative = new Intl.RelativeTimeFormat(context.locale, { numeric: 'auto' })
const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

function relativeTime(ms: number): string {
  const diff = ms - Date.now()
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit)
  }
  return relative.format(Math.round(diff / 1000), 'second')
}

function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString(context.locale)
}

function timeEl(ms: number): HTMLElement {
  return h('time', { class: 'muted', title: absoluteTime(ms) }, relativeTime(ms))
}

function focusKey(el: Element | null): string | null {
  return el && el !== document.body ? el.getAttribute('data-key') : null
}

function show(node: Node): void {
  const active = document.activeElement
  const key = focusKey(active)
  const caret =
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? [active.selectionStart, active.selectionEnd]
      : null
  const scrolls = new Map<string, [number, number]>()
  for (const el of root.querySelectorAll<HTMLElement>('[data-scroll]')) {
    scrolls.set(el.dataset.scroll ?? '', [el.scrollTop, el.scrollLeft])
  }
  root.replaceChildren(node)
  for (const el of root.querySelectorAll<HTMLElement>('[data-scroll]')) {
    const saved = scrolls.get(el.dataset.scroll ?? '')
    if (saved) {
      el.scrollTop = saved[0]
      el.scrollLeft = saved[1]
    }
  }
  if (!key) return
  const target = [...root.querySelectorAll<HTMLElement>('[data-key]')].find(
    (el) => el.dataset.key === key,
  )
  target?.focus({ preventScroll: true })
  if (caret && (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) {
    try {
      target.setSelectionRange(caret[0], caret[1])
    } catch {}
  }
}

function toDom(nodes: RenderNode[]): Node[] {
  return nodes.map((node) => {
    if (typeof node === 'string') return document.createTextNode(node)
    const el = document.createElement(node.tag)
    for (const [name, value] of Object.entries(node.attrs ?? {})) el.setAttribute(name, value)
    el.append(...toDom(node.children))
    return el
  })
}

function markdown(source: string): HTMLElement {
  const el = h('div', { class: 'markdown' })
  el.append(...toDom(renderMarkdown(source)))
  return el
}

function iconButton(
  label: string,
  svg: string,
  onclick: () => void,
  extra: Record<string, string> = {},
): HTMLElement {
  return h(
    'button',
    { class: 'icon', 'aria-label': label, title: label, onclick, ...extra },
    icon(svg),
  )
}

function emptyState(
  title: string,
  hint?: string,
  tone: 'muted' | 'error' = 'muted',
  action?: HTMLElement,
): HTMLElement {
  return h(
    'div',
    { class: `empty ${tone}`, role: tone === 'error' ? 'alert' : 'status' },
    h('p', { class: 'empty-title' }, title),
    hint ? h('p', { class: 'empty-hint' }, hint) : null,
    action ?? null,
  )
}

function failureState(res: ExtensionResult): HTMLElement {
  if (res.ok) return emptyState('')
  return emptyState(p('unavailable'), res.message ?? res.error, 'error')
}

function actorLabel(actor: string): string {
  return ctx && actor === ctx.actor ? p('you') : actorName(actor)
}

function priorityLabel(value: string): string {
  return PRIORITY_VALUES.includes(value) ? p(`priority.${value}`) : value
}

function select(
  key: string,
  label: string,
  options: { value: string; text: string }[],
  value: string,
  onPick: (value: string) => void,
): HTMLElement {
  const el = h(
    'select',
    {
      'data-key': key,
      'aria-label': label,
      onchange: (e) => onPick((e.target as HTMLSelectElement).value),
    },
    ...options.map((o) => {
      const option = h('option', { value: o.value }, o.text)
      if (o.value === value) option.setAttribute('selected', '')
      return option
    }),
  ) as HTMLSelectElement
  el.value = value
  return el
}

function setView(next: View): void {
  view = next
  banner = null
  void refresh()
}

function setProject(next: string): void {
  project = next
  boardSlug = ctx?.workspace?.project === next ? (ctx.workspace.board ?? null) : null
  boardData = null
  entries = null
  openRef = null
  cardData = null
  openSlug = null
  entryData = null
  newCard = null
  banner = null
  void refresh()
}

function toolbar(): HTMLElement {
  const views: View[] = ['board', 'vault']
  const projects = ctx?.projects ?? []
  const boards = boardData?.boards ?? []
  return h(
    'nav',
    { class: 'toolbar' },
    h(
      'div',
      { class: 'tabs', role: 'tablist' },
      ...views.map((v) =>
        h(
          'button',
          {
            class: 'tab',
            role: 'tab',
            'data-key': `tab-${v}`,
            'aria-selected': v === view ? 'true' : 'false',
            onclick: () => setView(v),
          },
          p(`tab.${v}`),
        ),
      ),
    ),
    projects.length > 0 && project
      ? select(
          'project',
          p('project'),
          projects.map((x) => ({ value: x.key, text: x.key })),
          project,
          setProject,
        )
      : projects.length > 0
        ? select(
            'project',
            p('project'),
            [
              { value: '', text: p('project') },
              ...projects.map((x) => ({ value: x.key, text: x.key })),
            ],
            '',
            (value) => value && setProject(value),
          )
        : null,
    view === 'board' && boards.length > 1 && boardData
      ? select(
          'board',
          p('board'),
          boards.map((b) => ({ value: b.slug, text: b.name })),
          boardData.board.slug,
          (slug) => {
            boardSlug = slug
            void refresh()
          },
        )
      : null,
    h('span', { class: 'spacer' }),
    view === 'board' && boardData
      ? h(
          'button',
          { class: 'with-icon', 'data-key': 'new-card', onclick: openNewCard },
          icon(plus),
          p('newCard'),
        )
      : null,
    iconButton(p('refresh'), arrowClockwise, () => void refresh(), { 'data-key': 'refresh' }),
  )
}

function bannerView(): HTMLElement | null {
  if (banner) return h('div', { class: 'banner error', role: 'alert' }, banner)
  return notice ? h('div', { class: 'banner', role: 'status' }, notice) : null
}

function taskText(task: CardTask): string {
  return task.agent ? p('task.started', { agent: task.agent }) : p('task.sent')
}

function taskButton(ref: string, key: string): HTMLElement | null {
  const task = tasks.get(ref)
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
  banner = res.ok ? null : errorText(res)
  notice = null
  if (!res.ok) await refresh()
}

async function toggleWorkMenu(ref: string): Promise<void> {
  workMenu = workMenu === ref ? null : ref
  render()
  if (!workMenu || agentNames) return
  const res = await call('agents')
  agentNames = res.ok ? (res.data as { agents: string[] }).agents : []
  render()
}

async function handOff(command: 'offer' | 'start', ref: string, agent?: string): Promise<void> {
  workMenu = null
  render()
  const res = await call(command, {
    ref,
    board: boardData?.board.slug || undefined,
    ...(agent ? { agent } : {}),
  })
  banner = res.ok ? null : errorText(res)
  notice = res.ok && (res.data as { sent?: boolean }).sent === false ? p('work.notSent') : null
  await refresh()
}

function workMenuView(ref: string): HTMLElement {
  const names = agentNames
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

function workRow(ref: string): HTMLElement {
  const open = workMenu === ref
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

function claimLine(card: TrellisCard): HTMLElement | null {
  const state = claimState(card, ctx?.actor ?? '', Date.now())
  if (state === 'none') return null
  const text =
    state === 'mine'
      ? p('claim.mine')
      : p('claim.other', { actor: actorName(card.claimedBy ?? '') })
  return h('span', { class: `claim claim-${state}` }, icon(userCircle), text)
}

function labelChips(card: TrellisCard): HTMLElement | null {
  const chips: HTMLElement[] = []
  if (card.priority !== DEFAULT_PRIORITY) {
    chips.push(
      h('span', { class: `chip priority priority-${card.priority}` }, priorityLabel(card.priority)),
    )
  }
  for (const label of card.labels) chips.push(h('span', { class: 'chip' }, label))
  return chips.length > 0 ? h('span', { class: 'chips' }, ...chips) : null
}

function cardTile(card: TrellisCard): HTMLElement {
  return h(
    'li',
    { class: tasks.has(card.ref) ? 'has-task' : '' },
    h(
      'button',
      {
        class: 'card',
        'data-key': `card-${card.ref}`,
        'data-ref': card.ref,
        'aria-current': card.ref === openRef ? 'true' : 'false',
        onclick: () => openCard(card.ref),
      },
      h('span', { class: 'card-ref' }, card.ref),
      h('span', { class: 'card-title' }, card.title),
      labelChips(card),
      claimLine(card),
    ),
    taskButton(card.ref, `task-${card.ref}`),
  )
}

function columnView(column: ShownColumn): HTMLElement {
  return h(
    'section',
    { class: 'column', 'aria-label': column.name, 'data-column': column.name },
    h(
      'h2',
      {},
      h('span', { class: 'column-name' }, column.name),
      column.done ? h('span', { class: 'muted' }, p('card.doneMark')) : null,
      h(
        'span',
        { class: 'count', 'aria-label': p('column.count', { count: column.total }) },
        String(column.total),
      ),
    ),
    h(
      'ul',
      { class: 'cards', 'data-scroll': `column-${column.name}` },
      ...column.cards.map(cardTile),
      column.cards.length === 0
        ? h('li', { class: 'column-empty muted' }, p(cardQuery ? 'column.noMatch' : 'column.empty'))
        : null,
      column.hidden > 0
        ? h('li', { class: 'column-empty muted' }, p('column.more', { count: column.hidden }))
        : null,
    ),
  )
}

function openNewCard(): void {
  newCard = {
    title: '',
    body: '',
    column: boardData?.board.columns[0]?.name ?? '',
    priority: DEFAULT_PRIORITY,
  }
  render()
  root.querySelector<HTMLElement>('[data-key="new-title"]')?.focus()
}

async function createCard(): Promise<void> {
  if (!newCard || !project || busy || !newCard.title.trim()) return
  busy = true
  const res = await call('create', {
    project,
    board: boardData?.board.slug || undefined,
    title: newCard.title,
    body: newCard.body,
    column: newCard.column || undefined,
    priority: newCard.priority,
  })
  busy = false
  if (res.ok) {
    newCard = null
    banner = null
    const created = (res.data as { card: TrellisCard }).card
    openRef = created.ref
    cardData = null
  } else {
    banner = errorText(res)
  }
  await refresh()
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control)
}

function newCardForm(board: TrellisBoard, draft: NewCardDraft): HTMLElement {
  const title = h('input', {
    type: 'text',
    'data-key': 'new-title',
    maxlength: '300',
    oninput: (e) => {
      draft.title = (e.target as HTMLInputElement).value
    },
  }) as HTMLInputElement
  title.value = draft.title
  const body = h('textarea', {
    'data-key': 'new-body',
    rows: '5',
    oninput: (e) => {
      draft.body = (e.target as HTMLTextAreaElement).value
    },
  }) as HTMLTextAreaElement
  body.value = draft.body
  return h(
    'form',
    {
      class: 'new-card',
      'aria-label': p('new.heading'),
      onsubmit: (e) => {
        e.preventDefault()
        void createCard()
      },
      onkeydown: (e) => {
        const key = e as KeyboardEvent
        if (key.key === 'Escape') {
          newCard = null
          render()
        } else if (key.key === 'Enter' && (key.ctrlKey || key.metaKey)) {
          key.preventDefault()
          void createCard()
        }
      },
    },
    field(p('new.title'), title),
    field(p('new.body'), body),
    h(
      'div',
      { class: 'field-row' },
      field(
        p('new.column'),
        select(
          'new-column',
          p('new.column'),
          board.columns.map((c) => ({ value: c.name, text: c.name })),
          draft.column,
          (value) => {
            draft.column = value
          },
        ),
      ),
      field(
        p('new.priority'),
        select(
          'new-priority',
          p('new.priority'),
          PRIORITY_VALUES.map((v) => ({ value: v, text: priorityLabel(v) })),
          draft.priority,
          (value) => {
            draft.priority = value
          },
        ),
      ),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          type: 'button',
          'data-key': 'new-cancel',
          onclick: () => {
            newCard = null
            render()
          },
        },
        p('new.cancel'),
      ),
      h('button', { type: 'submit', class: 'primary', 'data-key': 'new-create' }, p('new.create')),
    ),
  )
}

function openCard(ref: string): void {
  if (openRef !== ref) {
    cardData = null
    cardFailure = null
    commentDraft = ''
  }
  openRef = ref
  const key = CARD_REF.exec(ref)?.[1]
  if (key && key !== project && ctx?.projects.some((x) => x.key === key)) {
    project = key
    boardSlug = null
    boardData = null
  }
  view = 'board'
  render()
  void refresh()
}

function closeCard(): void {
  const ref = openRef
  openRef = null
  cardData = null
  cardFailure = null
  render()
  if (ref) root.querySelector<HTMLElement>(`[data-key="card-${ref}"]`)?.focus()
}

async function act(command: string, args: Record<string, unknown>): Promise<boolean> {
  if (busy) return false
  busy = true
  const res = await call(command, args)
  busy = false
  banner = res.ok ? null : errorText(res)
  await refresh()
  return res.ok
}

async function moveTo(ref: string, column: string): Promise<void> {
  if (boardData) boardData = { ...boardData, board: moveCard(boardData.board, ref, column) }
  render()
  await act('move', { ref, column })
}

async function sendComment(): Promise<void> {
  if (!openRef || !commentDraft.trim()) return
  const body = commentDraft
  if (await act('comment', { ref: openRef, body })) {
    commentDraft = ''
    render()
  }
}

function activityText(a: CardActivity): string {
  const actor = actorLabel(a.actor)
  const known = ['created', 'moved', 'claimed', 'released', 'renewed', 'edited']
  if (!known.includes(a.action)) return p('activity.other', { actor, action: a.action })
  return p(`activity.${a.action}`, { actor, old: a.old ?? '', new: a.new ?? '' })
}

function threadItem(item: ThreadItem): HTMLElement {
  if (item.kind === 'activity') {
    return h(
      'li',
      { class: 'activity muted' },
      h('span', {}, activityText(item.activity)),
      timeEl(item.at),
    )
  }
  return h(
    'li',
    { class: 'comment' },
    h(
      'div',
      { class: 'comment-head' },
      h('span', { class: 'comment-actor' }, actorLabel(item.comment.actor)),
      timeEl(item.at),
    ),
    markdown(item.comment.body),
  )
}

function threadView(thread: CardThread | null): HTMLElement {
  const items = thread ? threadItems(thread) : []
  return h(
    'section',
    { class: 'thread', 'aria-label': p('thread.title') },
    h('h3', {}, p('thread.title')),
    !thread
      ? h('p', { class: 'muted note' }, p('thread.unavailable'))
      : items.length === 0
        ? h('p', { class: 'muted note' }, p('thread.none'))
        : h('ol', { class: 'thread-items' }, ...items.map(threadItem)),
  )
}

function commentForm(): HTMLElement {
  const box = h('textarea', {
    'data-key': 'comment',
    'aria-label': p('comment.placeholder'),
    placeholder: p('comment.placeholder'),
    rows: '3',
    oninput: (e) => {
      commentDraft = (e.target as HTMLTextAreaElement).value
    },
    onkeydown: (e) => {
      const key = e as KeyboardEvent
      if (key.key === 'Enter' && (key.ctrlKey || key.metaKey)) {
        key.preventDefault()
        void sendComment()
      }
    },
  }) as HTMLTextAreaElement
  box.value = commentDraft
  return h(
    'form',
    {
      class: 'comment-form',
      onsubmit: (e) => {
        e.preventDefault()
        void sendComment()
      },
    },
    box,
    h(
      'div',
      { class: 'field-row' },
      h('span', { class: 'muted hint' }, p('comment.hint', { keys: SEND_KEYS })),
      h('span', { class: 'spacer' }),
      h(
        'button',
        { type: 'submit', class: 'primary', 'data-key': 'comment-send' },
        p('comment.send'),
      ),
    ),
  )
}

function claimControls(card: CardDetail): HTMLElement {
  const state = claimState(card, ctx?.actor ?? '', Date.now())
  const until =
    state !== 'none' && card.claimUntil
      ? h('span', { class: 'muted' }, p('claim.until', { time: relativeTime(card.claimUntil) }))
      : null
  const button = (key: string, command: string): HTMLElement =>
    h(
      'button',
      { 'data-key': `claim-${command}`, onclick: () => void act(command, { ref: card.ref }) },
      p(`action.${key}`),
    )
  return h(
    'div',
    { class: 'claim-row' },
    state === 'none'
      ? h('span', { class: 'muted' }, p('claim.none'))
      : h(
          'span',
          { class: `claim claim-${state}` },
          icon(userCircle),
          state === 'mine'
            ? p('claim.mine')
            : p('claim.other', { actor: actorName(card.claimedBy ?? '') }),
        ),
    until,
    h('span', { class: 'spacer' }),
    state === 'none' ? button('claim', 'claim') : null,
    state === 'mine' ? button('renew', 'renew') : null,
    state === 'mine' ? button('release', 'release') : null,
  )
}

function relationsView(card: CardDetail): HTMLElement | null {
  if (card.relations.length === 0) return null
  const known = [
    'blocked_by',
    'blocks',
    'resolved_by',
    'resolves',
    'duplicate_of',
    'duplicated_by',
    'relates_to',
  ]
  return h(
    'section',
    { class: 'relations', 'aria-label': p('card.relations') },
    h('h3', {}, p('card.relations')),
    h(
      'ul',
      {},
      ...card.relations.map((r) =>
        h(
          'li',
          {},
          h('span', { class: 'muted' }, known.includes(r.rel) ? p(`rel.${r.rel}`) : r.rel),
          h(
            'button',
            { class: 'link', 'data-key': `rel-${r.rel}-${r.ref}`, onclick: () => openCard(r.ref) },
            h('span', { class: 'card-ref' }, r.ref),
            r.title,
          ),
          r.done ? h('span', { class: 'muted' }, p('card.doneMark')) : null,
        ),
      ),
    ),
  )
}

function detailView(ref: string): HTMLElement {
  const head = h(
    'header',
    { class: 'detail-head' },
    h('span', { class: 'card-ref' }, ref),
    h('span', { class: 'spacer' }),
    iconButton(p('card.close'), xIcon, closeCard, { 'data-key': 'card-close' }),
  )
  const attrs = { class: 'detail', 'aria-label': ref, 'data-scroll': 'detail' }
  if (cardFailure) return h('aside', attrs, head, failureState(cardFailure))
  if (!cardData || cardData.card.ref !== ref) {
    return h('aside', attrs, head, h('div', { class: 'empty muted', role: 'status' }, p('loading')))
  }
  const card = cardData.card
  const columns = boardData?.board.columns.map((c) => c.name) ?? []
  const options = columns.includes(card.column) ? columns : [card.column, ...columns]
  return h(
    'aside',
    attrs,
    head,
    h('h1', { class: 'detail-title' }, card.title),
    h(
      'div',
      { class: 'meta' },
      field(
        p('card.column'),
        select(
          'move',
          p('card.column'),
          options.map((name) => ({ value: name, text: name })),
          card.column,
          (column) => void moveTo(card.ref, column),
        ),
      ),
      labelChips(card),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, p('card.updated', { time: relativeTime(card.updatedAt) })),
    ),
    claimControls(card),
    workRow(card.ref),
    relationsView(card),
    card.body.trim() ? markdown(card.body) : h('p', { class: 'muted note' }, p('card.noBody')),
    threadView(cardData.thread),
    commentForm(),
  )
}

function boardView(): HTMLElement {
  if (boardFailure) return failureState(boardFailure)
  if (!boardData) return h('div', { class: 'empty muted', role: 'status' }, p('loading'))
  const filter = h('input', {
    type: 'search',
    class: 'filter',
    'data-key': 'card-filter',
    'aria-label': p('filterCards'),
    placeholder: p('filterCards'),
    oninput: (e) => {
      cardQuery = (e.target as HTMLInputElement).value
      render()
    },
  }) as HTMLInputElement
  filter.value = cardQuery
  return h(
    'div',
    { class: `board-layout${openRef ? ' has-detail' : ''}` },
    h(
      'div',
      { class: 'board-main' },
      newCard ? newCardForm(boardData.board, newCard) : null,
      h('div', { class: 'filter-row' }, filter),
      h(
        'div',
        { class: 'columns', 'data-scroll': 'columns' },
        ...shownColumns(boardData.board, cardQuery).map(columnView),
      ),
    ),
    openRef ? detailView(openRef) : null,
  )
}

function openEntry(slug: string): void {
  if (openSlug !== slug) {
    entryData = null
    entryFailure = null
  }
  openSlug = slug
  render()
  void refresh()
}

function entryRow(entry: VaultEntrySummary): HTMLElement {
  return h(
    'li',
    {},
    h(
      'button',
      {
        class: 'entry',
        'data-key': `entry-${entry.slug}`,
        'data-slug': entry.slug,
        'aria-current': entry.slug === openSlug ? 'true' : 'false',
        onclick: () => openEntry(entry.slug),
      },
      h(
        'span',
        { class: 'entry-title' },
        entry.private ? icon(lockSimple) : null,
        entry.title,
        entry.template ? h('span', { class: 'chip' }, entry.template) : null,
      ),
      entry.summary ? h('span', { class: 'entry-summary muted' }, entry.summary) : null,
    ),
  )
}

function entryView(slug: string): HTMLElement {
  const head = h(
    'header',
    { class: 'detail-head' },
    h('span', { class: 'card-ref' }, slug),
    h('span', { class: 'spacer' }),
    iconButton(
      p('vault.close'),
      xIcon,
      () => {
        openSlug = null
        entryData = null
        render()
        root.querySelector<HTMLElement>(`[data-key="entry-${slug}"]`)?.focus()
      },
      { 'data-key': 'entry-close' },
    ),
  )
  const attrs = { class: 'detail entry-detail', 'aria-label': slug, 'data-scroll': 'entry' }
  if (entryFailure) return h('article', attrs, head, failureState(entryFailure))
  if (!entryData || entryData.slug !== slug) {
    return h(
      'article',
      attrs,
      head,
      h('div', { class: 'empty muted', role: 'status' }, p('loading')),
    )
  }
  const entry = entryData
  return h(
    'article',
    attrs,
    head,
    h('h1', { class: 'detail-title' }, entry.title),
    h(
      'div',
      { class: 'meta' },
      entry.template ? h('span', { class: 'chip' }, entry.template) : null,
      entry.private ? h('span', { class: 'chip' }, icon(lockSimple), p('vault.private')) : null,
      ...entry.tags.map((tag) => h('span', { class: 'chip' }, tag)),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, p('card.updated', { time: relativeTime(entry.updatedAt) })),
    ),
    entry.summary ? h('p', { class: 'summary' }, entry.summary) : null,
    markdown(entry.body),
    entry.sources.length > 0
      ? h(
          'section',
          { class: 'relations', 'aria-label': p('vault.sources') },
          h('h3', {}, p('vault.sources')),
          h('ul', {}, ...entry.sources.map((s) => h('li', { class: 'source' }, s))),
        )
      : null,
  )
}

function vaultView(): HTMLElement {
  if (vaultFailure) return failureState(vaultFailure)
  if (!entries) return h('div', { class: 'empty muted', role: 'status' }, p('loading'))
  if (entries.length === 0) return emptyState(p('vault.empty'))
  const filter = h('input', {
    type: 'search',
    class: 'filter',
    'data-key': 'entry-filter',
    'aria-label': p('filterEntries'),
    placeholder: p('filterEntries'),
    oninput: (e) => {
      entryQuery = (e.target as HTMLInputElement).value
      render()
    },
  }) as HTMLInputElement
  filter.value = entryQuery
  const groups = groupEntries(entries, entryQuery)
  return h(
    'div',
    { class: `vault-layout${openSlug ? ' has-detail' : ''}` },
    h(
      'div',
      { class: 'vault-list', 'data-scroll': 'vault-list' },
      h('div', { class: 'filter-row' }, filter),
      groups.length === 0 ? h('p', { class: 'muted note' }, p('vault.noMatch')) : null,
      ...groups.map((group) =>
        h(
          'section',
          { 'aria-label': group.dir || p('vault.top') },
          h('h2', { class: 'group-name' }, group.dir || p('vault.top')),
          h('ul', { class: 'entries' }, ...group.entries.map(entryRow)),
        ),
      ),
    ),
    openSlug ? entryView(openSlug) : h('div', { class: 'vault-hint' }, emptyState(p('vault.pick'))),
  )
}

async function initProject(): Promise<void> {
  const res = await call('init')
  banner = res.ok || res.error === 'cancelled' ? null : errorText(res)
  ctx = null
  await refresh()
}

function body(): HTMLElement {
  if (failed) return failureState(failed)
  if (!ctx) return h('div', { class: 'empty muted', role: 'status' }, p('loading'))
  if (!project) {
    const init = ctx.canInit
      ? h('button', { 'data-key': 'init', onclick: () => void initProject() }, p('empty.init'))
      : undefined
    return ctx.projects.length === 0 && !ctx.canInit
      ? emptyState(p('empty.noProjects'))
      : emptyState(p('empty.noProject'), p('empty.noProjectHint'), 'muted', init)
  }
  return view === 'vault' ? vaultView() : boardView()
}

function render(): void {
  show(h('main', { class: 'page' }, toolbar(), bannerView(), body()))
}

async function loadContext(): Promise<void> {
  const res = await call('context')
  if (!res.ok) {
    failed = res
    return
  }
  failed = null
  ctx = res.data as PanelContext
  if (project) return
  const fromCard = openRef ? CARD_REF.exec(openRef)?.[1] : null
  project = fromCard ?? ctx.workspace?.project ?? null
  boardSlug = project === ctx.workspace?.project ? (ctx.workspace?.board ?? null) : null
}

async function loadBoard(seq: number): Promise<void> {
  const [res, working] = await Promise.all([
    call('board', { project, board: boardSlug ?? undefined }),
    call('tasks'),
  ])
  if (seq !== requestSeq) return
  boardFailure = res.ok ? null : res
  if (res.ok) boardData = res.data as BoardData
  if (working.ok) {
    const list = (working.data as { tasks: CardTask[] }).tasks
    tasks = new Map(list.map((task) => [task.ref, task]))
  }
}

async function loadCard(seq: number, ref: string): Promise<void> {
  const res = await call('card', { ref, board: boardData?.board.slug || undefined })
  if (seq !== requestSeq || openRef !== ref) return
  cardFailure = res.ok ? null : res
  if (res.ok) cardData = res.data as CardData
}

async function loadVault(seq: number): Promise<void> {
  const res = await call('vault', { project })
  if (seq !== requestSeq) return
  vaultFailure = res.ok ? null : res
  if (res.ok) entries = (res.data as { entries: VaultEntrySummary[] }).entries
  const slug = openSlug
  if (!slug) return
  const shown = await call('entry', { project, slug })
  if (seq !== requestSeq || openSlug !== slug) return
  entryFailure = shown.ok ? null : shown
  if (shown.ok) entryData = (shown.data as { entry: VaultEntry }).entry
}

async function refresh(): Promise<void> {
  const seq = ++requestSeq
  if (!ctx || failed) await loadContext()
  if (seq !== requestSeq) return
  if (ctx && project) {
    if (view === 'vault') await loadVault(seq)
    else {
      await loadBoard(seq)
      if (seq === requestSeq && openRef) {
        if (boardData && !findCard(boardData.board, openRef) && cardData?.card.ref !== openRef) {
          cardData = null
        }
        await loadCard(seq, openRef)
      }
    }
  }
  if (seq === requestSeq) render()
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  const target = e.target as HTMLElement | null
  if (target?.closest('.new-card')) return
  if (workMenu) {
    workMenu = null
    render()
    return
  }
  if (view === 'board' && openRef) closeCard()
})

document.addEventListener('pointerdown', (e) => {
  if (!workMenu || (e.target as HTMLElement | null)?.closest('.work')) return
  workMenu = null
  render()
})

render()
onChange(() => void refresh())
void refresh()
