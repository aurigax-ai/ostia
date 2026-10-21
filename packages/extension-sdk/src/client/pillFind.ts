import { h, icon } from './panel'
import { PILL_ICONS } from './pillIcons'
import { iconButton } from './pillParts'
import type { FindHandle, FindOptions, PillFind } from './pillTypes'

export interface FindRow {
  node: HTMLElement
  handle: FindHandle
}

export function buildFindRow(control: PillFind, onToggle: (open: boolean) => void): FindRow {
  const { labels } = control
  const field = h('input', {
    type: 'text',
    class: 'ostia-pill-find-field',
    placeholder: labels.placeholder,
    'aria-label': labels.placeholder,
    spellcheck: 'false',
  }) as HTMLInputElement
  const count = h('span', { class: 'ostia-pill-find-count', 'aria-live': 'polite' })
  const matchCase = iconButton(
    labels.matchCase,
    undefined,
    h('span', { class: 'ostia-pill-case', 'aria-hidden': 'true' }, 'Aa'),
  )
  matchCase.setAttribute('aria-pressed', 'false')
  const highlightAll = iconButton(labels.highlightAll, undefined, PILL_ICONS.highlight)
  highlightAll.setAttribute('aria-pressed', 'false')
  const previous = iconButton(labels.previous, 'Shift+Enter', PILL_ICONS.caretUp)
  const next = iconButton(labels.next, 'Enter', PILL_ICONS.caretDown)
  const done = iconButton(labels.done, 'Esc', PILL_ICONS.close)
  const node = h(
    'div',
    { class: 'ostia-pill-find', role: 'search' },
    h('div', { class: 'ostia-pill-field' }, icon(PILL_ICONS.search), field, count),
    matchCase,
    highlightAll,
    previous,
    next,
    done,
  )
  node.hidden = true
  let opened = false
  const options = (): FindOptions => ({
    matchCase: matchCase.getAttribute('aria-pressed') === 'true',
    highlightAll: highlightAll.getAttribute('aria-pressed') === 'true',
  })
  const query = (): void => {
    count.textContent = ''
    control.onQuery(field.value, options())
  }
  const toggle = (button: HTMLButtonElement): void => {
    button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'))
    query()
  }
  const close = (): void => {
    if (!opened) return
    opened = false
    node.hidden = true
    onToggle(false)
    control.onClose()
  }
  const open = (): void => {
    if (!opened) {
      opened = true
      node.hidden = false
      onToggle(true)
    }
    field.focus()
    field.select()
  }
  field.addEventListener('input', query)
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    control.onStep(event.shiftKey ? -1 : 1)
  })
  matchCase.addEventListener('click', () => toggle(matchCase))
  highlightAll.addEventListener('click', () => toggle(highlightAll))
  previous.addEventListener('click', () => control.onStep(-1))
  next.addEventListener('click', () => control.onStep(1))
  done.addEventListener('click', close)
  return {
    node,
    handle: {
      open,
      close,
      isOpen: () => opened,
      setResult: ({ index, total }) => {
        if (field.value === '') count.textContent = ''
        else count.textContent = total > 0 ? labels.count(index, total) : labels.none
      },
    },
  }
}
