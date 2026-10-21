import { h, icon } from '@aurigax-ai/ostia-extension-sdk/panel'
import caretDown from '@phosphor-icons/core/regular/caret-down.svg'
import check from '@phosphor-icons/core/regular/check.svg'
import { rateLabel } from './mediaTime'

export interface SpeedMenuOptions {
  label: string
  rates: readonly number[]
  current: number
  onPick: (rate: number) => void
  onOpenChange: () => void
}

export interface SpeedMenu {
  element: HTMLElement
  isOpen: () => boolean
  setRate: (rate: number) => void
}

export function createSpeedMenu(options: SpeedMenuOptions): SpeedMenu {
  const text = h('span', { class: 'ostia-pill-menu-text' }, rateLabel(options.current))
  const button = h(
    'button',
    {
      type: 'button',
      class: 'ostia-pill-button ostia-pill-menu-button',
      title: options.label,
      'aria-label': options.label,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    },
    text,
    icon(caretDown),
  ) as HTMLButtonElement
  const list = h('div', { class: 'ostia-pill-menu', role: 'menu', 'aria-label': options.label })
  list.hidden = true
  const rows = new Map<number, HTMLButtonElement>()
  for (const rate of options.rates) {
    const row = h(
      'button',
      { type: 'button', class: 'ostia-pill-menu-item', role: 'menuitemradio', tabindex: '-1' },
      h('span', { class: 'ostia-pill-menu-check' }, icon(check)),
      h('span', { class: 'ostia-pill-menu-label' }, rateLabel(rate)),
    ) as HTMLButtonElement
    row.addEventListener('click', () => {
      close(true)
      options.onPick(rate)
    })
    rows.set(rate, row)
    list.append(row)
  }
  let current = options.current
  const mark = (): void => {
    for (const [rate, row] of rows) row.setAttribute('aria-checked', String(rate === current))
    text.textContent = rateLabel(current)
  }
  const items = (): HTMLButtonElement[] => [...rows.values()]
  const open = (): void => {
    list.hidden = false
    button.setAttribute('aria-expanded', 'true')
    options.onOpenChange()
    rows.get(current)?.focus()
  }
  function close(restoreFocus: boolean): void {
    if (list.hidden) return
    list.hidden = true
    button.setAttribute('aria-expanded', 'false')
    options.onOpenChange()
    if (restoreFocus) button.focus()
  }
  button.addEventListener('click', () => (list.hidden ? open() : close(true)))
  list.addEventListener('keydown', (event) => {
    const all = items()
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    const move: Record<string, number> = {
      ArrowDown: (at + 1) % all.length,
      ArrowUp: (at - 1 + all.length) % all.length,
      Home: 0,
      End: all.length - 1,
    }
    if (event.key in move) {
      event.preventDefault()
      event.stopPropagation()
      all[move[event.key]]?.focus()
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      close(true)
    } else if (event.key === 'Tab') close(false)
  })
  const element = h('div', { class: 'ostia-pill-menu-anchor' }, button, list)
  document.addEventListener('pointerdown', (event) => {
    if (!element.contains(event.target as Node | null)) close(false)
  })
  mark()
  return {
    element,
    isOpen: () => !list.hidden,
    setRate: (rate) => {
      current = rate
      mark()
    },
  }
}
