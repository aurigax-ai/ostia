import { call, errorText, h, icon } from '@aurigax-ai/ostia-extension-sdk/panel'
import userCircle from '@phosphor-icons/core/regular/user-circle.svg'
import xIcon from '@phosphor-icons/core/regular/x.svg'
import { actorName, claimState, moveCard, type ThreadItem, threadItems } from './board'
import { refresh } from './panelData'
import {
  actorLabel,
  DEFAULT_PRIORITY,
  emptyState,
  failureState,
  field,
  iconButton,
  markdown,
  p,
  priorityLabel,
  relativeTime,
  select,
  timeEl,
} from './panelDom'
import { CARD_REF, hooks, root, state } from './panelState'
import { workRow } from './panelWork'
import type { CardActivity, CardDetail, CardThread, TrellisCard } from './trellis'

const SEND_KEYS = /Mac/.test(navigator.platform) ? '⌘Enter' : 'Ctrl+Enter'

export function claimLine(card: TrellisCard): HTMLElement | null {
  const claim = claimState(card, state.ctx?.actor ?? '', Date.now())
  if (claim === 'none') return null
  const text =
    claim === 'mine'
      ? p('claim.mine')
      : p('claim.other', { actor: actorName(card.claimedBy ?? '') })
  return h('span', { class: `claim claim-${claim}` }, icon(userCircle), text)
}

export function labelChips(card: TrellisCard): HTMLElement | null {
  const chips: HTMLElement[] = []
  if (card.priority !== DEFAULT_PRIORITY) {
    chips.push(
      h('span', { class: `chip priority priority-${card.priority}` }, priorityLabel(card.priority)),
    )
  }
  for (const label of card.labels) chips.push(h('span', { class: 'chip' }, label))
  return chips.length > 0 ? h('span', { class: 'chips' }, ...chips) : null
}

export function openCard(ref: string): void {
  if (state.openRef !== ref) {
    state.cardData = null
    state.cardFailure = null
    state.commentDraft = ''
  }
  state.openRef = ref
  const key = CARD_REF.exec(ref)?.[1]
  if (key && key !== state.project && state.ctx?.projects.some((x) => x.key === key)) {
    state.project = key
    state.boardSlug = null
    state.boardData = null
  }
  state.view = 'board'
  hooks.render()
  void refresh()
}

export function closeCard(): void {
  const ref = state.openRef
  state.openRef = null
  state.cardData = null
  state.cardFailure = null
  hooks.render()
  if (ref) root.querySelector<HTMLElement>(`[data-key="card-${ref}"]`)?.focus()
}

async function act(command: string, args: Record<string, unknown>): Promise<boolean> {
  if (state.busy) return false
  state.busy = true
  const res = await call(command, args)
  state.busy = false
  state.banner = res.ok ? null : errorText(res)
  await refresh()
  return res.ok
}

async function moveTo(ref: string, column: string): Promise<void> {
  if (state.boardData)
    state.boardData = { ...state.boardData, board: moveCard(state.boardData.board, ref, column) }
  hooks.render()
  await act('move', { ref, column })
}

async function sendComment(): Promise<void> {
  if (!state.openRef || !state.commentDraft.trim()) return
  const body = state.commentDraft
  if (await act('comment', { ref: state.openRef, body })) {
    state.commentDraft = ''
    hooks.render()
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
      state.commentDraft = (e.target as HTMLTextAreaElement).value
    },
    onkeydown: (e) => {
      const key = e as KeyboardEvent
      if (key.key === 'Enter' && (key.ctrlKey || key.metaKey)) {
        key.preventDefault()
        void sendComment()
      }
    },
  }) as HTMLTextAreaElement
  box.value = state.commentDraft
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
      h('span', { class: 'ostia-spacer' }),
      h(
        'button',
        { type: 'submit', class: 'primary', 'data-key': 'comment-send' },
        p('comment.send'),
      ),
    ),
  )
}

function claimControls(card: CardDetail): HTMLElement {
  const claim = claimState(card, state.ctx?.actor ?? '', Date.now())
  const until =
    claim !== 'none' && card.claimUntil
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
    claim === 'none'
      ? h('span', { class: 'muted' }, p('claim.none'))
      : h(
          'span',
          { class: `claim claim-${claim}` },
          icon(userCircle),
          claim === 'mine'
            ? p('claim.mine')
            : p('claim.other', { actor: actorName(card.claimedBy ?? '') }),
        ),
    until,
    h('span', { class: 'ostia-spacer' }),
    claim === 'none' ? button('claim', 'claim') : null,
    claim === 'mine' ? button('renew', 'renew') : null,
    claim === 'mine' ? button('release', 'release') : null,
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

export function detailView(ref: string): HTMLElement {
  const head = h(
    'header',
    { class: 'detail-head' },
    h('span', { class: 'card-ref' }, ref),
    h('span', { class: 'ostia-spacer' }),
    iconButton(p('card.close'), xIcon, closeCard, { 'data-key': 'card-close' }),
  )
  const attrs = { class: 'detail', 'aria-label': ref, 'data-scroll': 'detail' }
  if (state.cardFailure) return h('aside', attrs, head, failureState(state.cardFailure))
  if (!state.cardData || state.cardData.card.ref !== ref) {
    return h('aside', attrs, head, emptyState(p('loading')))
  }
  const card = state.cardData.card
  const columns = state.boardData?.board.columns.map((c) => c.name) ?? []
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
      h('span', { class: 'ostia-spacer' }),
      h('span', { class: 'muted' }, p('card.updated', { time: relativeTime(card.updatedAt) })),
    ),
    claimControls(card),
    workRow(card.ref),
    relationsView(card),
    card.body.trim() ? markdown(card.body) : h('p', { class: 'muted note' }, p('card.noBody')),
    threadView(state.cardData.thread),
    commentForm(),
  )
}
