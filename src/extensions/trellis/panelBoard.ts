import { call, errorText, h } from '@aurigax-ai/ostia-extension-sdk/panel'
import { type ShownColumn, shownColumns } from './board'
import { claimLine, detailView, labelChips, openCard } from './panelCard'
import { refresh } from './panelData'
import {
  DEFAULT_PRIORITY,
  emptyState,
  failureState,
  field,
  PRIORITY_VALUES,
  p,
  priorityLabel,
  select,
} from './panelDom'
import { hooks, type NewCardDraft, root, state } from './panelState'
import { taskButton } from './panelWork'
import type { TrellisBoard, TrellisCard } from './trellis'

function cardTile(card: TrellisCard): HTMLElement {
  return h(
    'li',
    { class: state.tasks.has(card.ref) ? 'has-task' : '' },
    h(
      'button',
      {
        class: 'card',
        'data-key': `card-${card.ref}`,
        'data-ref': card.ref,
        'aria-current': card.ref === state.openRef ? 'true' : 'false',
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
        ? h(
            'li',
            { class: 'column-empty muted' },
            p(state.cardQuery ? 'column.noMatch' : 'column.empty'),
          )
        : null,
      column.hidden > 0
        ? h('li', { class: 'column-empty muted' }, p('column.more', { count: column.hidden }))
        : null,
    ),
  )
}

export function openNewCard(): void {
  state.newCard = {
    title: '',
    body: '',
    column: state.boardData?.board.columns[0]?.name ?? '',
    priority: DEFAULT_PRIORITY,
  }
  hooks.render()
  root.querySelector<HTMLElement>('[data-key="new-title"]')?.focus()
}

async function createCard(): Promise<void> {
  if (!state.newCard || !state.project || state.busy || !state.newCard.title.trim()) return
  state.busy = true
  const res = await call('create', {
    project: state.project,
    board: state.boardData?.board.slug || undefined,
    title: state.newCard.title,
    body: state.newCard.body,
    column: state.newCard.column || undefined,
    priority: state.newCard.priority,
  })
  state.busy = false
  if (res.ok) {
    state.newCard = null
    state.banner = null
    const created = (res.data as { card: TrellisCard }).card
    state.openRef = created.ref
    state.cardData = null
  } else {
    state.banner = errorText(res)
  }
  await refresh()
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
          state.newCard = null
          hooks.render()
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
      h('span', { class: 'ostia-spacer' }),
      h(
        'button',
        {
          type: 'button',
          'data-key': 'new-cancel',
          onclick: () => {
            state.newCard = null
            hooks.render()
          },
        },
        p('new.cancel'),
      ),
      h('button', { type: 'submit', class: 'primary', 'data-key': 'new-create' }, p('new.create')),
    ),
  )
}

export function boardView(): HTMLElement {
  if (state.boardFailure) return failureState(state.boardFailure)
  if (!state.boardData) return emptyState(p('loading'))
  const filter = h('input', {
    type: 'search',
    class: 'filter',
    'data-key': 'card-filter',
    'aria-label': p('filterCards'),
    placeholder: p('filterCards'),
    oninput: (e) => {
      state.cardQuery = (e.target as HTMLInputElement).value
      hooks.render()
    },
  }) as HTMLInputElement
  filter.value = state.cardQuery
  return h(
    'div',
    { class: `board-layout${state.openRef ? ' has-detail' : ''}` },
    h(
      'div',
      { class: 'board-main' },
      state.newCard ? newCardForm(state.boardData.board, state.newCard) : null,
      h('div', { class: 'filter-row' }, filter),
      h(
        'div',
        { class: 'columns', 'data-scroll': 'columns' },
        ...shownColumns(state.boardData.board, state.cardQuery).map(columnView),
      ),
    ),
    state.openRef ? detailView(state.openRef) : null,
  )
}
