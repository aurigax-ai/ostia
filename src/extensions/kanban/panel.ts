import { call, errorText, h, onChange, pickLocale } from '../sdk/panel'
import type { KanbanBoard, KanbanCard, KanbanColumn } from './board'

const t = pickLocale({
  en: {
    loading: 'Loading…',
    noCards: 'No cards',
    addPlaceholder: 'Add a card…',
    add: 'Add card',
    remove: 'Remove card',
    moveTo: 'Move to',
  },
  'zh-Hant': {
    loading: '載入中…',
    noCards: '沒有卡片',
    addPlaceholder: '新增卡片…',
    add: '新增卡片',
    remove: '移除卡片',
    moveTo: '移至',
  },
})

const root = document.getElementById('root') as HTMLElement

function show(node: Node): void {
  root.replaceChildren(node)
}

async function mutate(command: string, args: Record<string, string>): Promise<void> {
  const res = await call(command, args)
  if (!res.ok) show(h('div', { class: 'center error', role: 'alert' }, errorText(res)))
  else await refresh()
}

function cardView(card: KanbanCard, columns: KanbanColumn[]): HTMLElement {
  return h(
    'article',
    { class: 'card', 'data-card-id': card.id },
    h(
      'button',
      {
        class: 'card-remove',
        'aria-label': `${t.remove}: ${card.title}`,
        title: t.remove,
        onclick: () => void mutate('rm', { cardId: card.id }),
      },
      '×',
    ),
    h('div', { class: 'card-title' }, card.title),
    card.assignee ? h('div', { class: 'muted' }, card.assignee) : null,
    h(
      'div',
      { class: 'card-moves' },
      ...columns
        .filter((c) => c.id !== card.column)
        .map((c) =>
          h(
            'button',
            {
              'aria-label': `${t.moveTo} ${c.name}`,
              onclick: () => void mutate('move', { cardId: card.id, column: c.id }),
            },
            `→ ${c.name}`,
          ),
        ),
    ),
  )
}

function columnView(column: KanbanColumn, board: KanbanBoard): HTMLElement {
  const cards = board.cards.filter((c) => c.column === column.id)
  const input = h('input', {
    placeholder: t.addPlaceholder,
    'aria-label': `${t.addPlaceholder} ${column.name}`,
  }) as HTMLInputElement
  const add = (): void => {
    const title = input.value.trim()
    if (!title) return
    input.value = ''
    void mutate('add', { title, column: column.id })
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add()
  })
  return h(
    'section',
    { class: 'column', 'aria-label': column.name },
    h(
      'header',
      { class: 'column-head' },
      column.name,
      h('span', { class: 'muted' }, ` (${cards.length})`),
    ),
    h(
      'div',
      { class: 'column-cards' },
      ...(cards.length === 0
        ? [h('div', { class: 'muted empty' }, t.noCards)]
        : cards.map((card) => cardView(card, board.columns))),
    ),
    h(
      'footer',
      { class: 'column-add' },
      input,
      h('button', { 'aria-label': t.add, onclick: add }, '+'),
    ),
  )
}

async function refresh(): Promise<void> {
  const res = await call('get')
  if (!res.ok) {
    show(h('div', { class: 'center error', role: 'alert' }, errorText(res)))
    return
  }
  const board = res.data as KanbanBoard
  const focused = document.activeElement?.getAttribute('aria-label')
  show(h('main', { class: 'board' }, ...board.columns.map((col) => columnView(col, board))))
  if (focused) root.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focused)}"]`)?.focus()
}

show(h('div', { class: 'center muted' }, t.loading))
onChange(() => void refresh())
void refresh()
