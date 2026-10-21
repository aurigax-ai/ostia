import { h, icon } from './panel'
import { PILL_ICONS } from './pillIcons'
import type { Built, PillButton, PillPager, PillToggle } from './pillTypes'

export function tip(label: string, chord?: string): string {
  return chord ? `${label} (${chord})` : label
}

export function iconButton(
  label: string,
  chord: string | undefined,
  glyph: string | Node,
): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', class: 'ostia-pill-button', title: tip(label, chord), 'aria-label': label },
    typeof glyph === 'string' ? icon(glyph) : glyph,
  ) as HTMLButtonElement
}

export function buildButton(control: PillButton | PillToggle): Built {
  const button = iconButton(control.label, control.chord, control.icon)
  button.disabled = control.disabled === true
  const setPressed = (pressed: boolean): void => {
    button.setAttribute('aria-pressed', String(pressed))
  }
  if (control.type === 'toggle') {
    setPressed(control.pressed === true)
    button.addEventListener('click', () => {
      const next = button.getAttribute('aria-pressed') !== 'true'
      setPressed(next)
      control.onToggle(next)
    })
  } else {
    button.addEventListener('click', () => control.onClick())
  }
  return {
    node: button,
    update: (patch) => {
      if (patch.disabled !== undefined) button.disabled = patch.disabled
      if (patch.pressed !== undefined && control.type === 'toggle') setPressed(patch.pressed)
    },
  }
}

export function buildPager(control: PillPager): Built {
  let page = control.page
  let count = control.count
  const previous = iconButton(control.previous.label, control.previous.chord, PILL_ICONS.caretLeft)
  const next = iconButton(control.next.label, control.next.chord, PILL_ICONS.caretRight)
  const box = h('input', {
    type: 'text',
    class: 'ostia-pill-page',
    inputmode: 'numeric',
    'aria-label': control.label,
    title: tip(control.label, control.chord),
  }) as HTMLInputElement
  const of = h('span', { class: 'ostia-pill-of' })
  const render = (): void => {
    box.value = String(page)
    box.style.setProperty('--digits', String(String(count).length))
    of.textContent = control.of(count)
    previous.disabled = control.disabled === true || page <= 1
    next.disabled = control.disabled === true || page >= count
    box.disabled = control.disabled === true || count < 1
  }
  const go = (target: number): void => {
    if (target >= 1 && target <= count) control.onGo(target)
  }
  previous.addEventListener('click', () => go(page - 1))
  next.addEventListener('click', () => go(page + 1))
  box.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    const typed = Number.parseInt(box.value, 10)
    if (Number.isNaN(typed)) render()
    else go(Math.min(Math.max(typed, 1), count))
  })
  box.addEventListener('blur', render)
  box.addEventListener('focus', () => box.select())
  render()
  const node = h('div', { class: 'ostia-pill-pager' }, previous, box, of, next)
  return {
    node,
    update: (patch) => {
      if (patch.page !== undefined) page = patch.page
      if (patch.count !== undefined) count = patch.count
      if (patch.disabled !== undefined) control.disabled = patch.disabled
      render()
    },
  }
}
