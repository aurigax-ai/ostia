import { h, icon } from './panel'
import { PILL_ICONS } from './pillIcons'
import { tip } from './pillParts'
import type { Built, PillMenu } from './pillTypes'

export interface MenuHandle extends Built {
  button: HTMLButtonElement
  isOpen: () => boolean
  close: (restoreFocus: boolean) => void
}

export function buildMenu(control: PillMenu, onOpenChange: () => void): MenuHandle {
  let checked = control.checked ?? null
  const text = h('span', { class: 'ostia-pill-menu-text' }, control.text)
  const button = h(
    'button',
    {
      type: 'button',
      class: 'ostia-pill-button ostia-pill-menu-button',
      title: tip(control.label, control.chord),
      'aria-label': control.label,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    },
    text,
    icon(PILL_ICONS.caretDown),
  ) as HTMLButtonElement
  button.disabled = control.disabled === true
  const list = h('div', { class: 'ostia-pill-menu', role: 'menu', 'aria-label': control.label })
  list.hidden = true
  const itemButtons = new Map<string, HTMLButtonElement>()
  control.items.forEach((group, index) => {
    if (index > 0) list.append(h('div', { class: 'ostia-pill-menu-separator', role: 'separator' }))
    for (const item of group) {
      const row = h(
        'button',
        { type: 'button', class: 'ostia-pill-menu-item', role: 'menuitemradio', tabindex: '-1' },
        h('span', { class: 'ostia-pill-menu-check' }, icon(PILL_ICONS.check)),
        h('span', { class: 'ostia-pill-menu-label' }, item.label),
        item.chord ? h('span', { class: 'ostia-pill-menu-chord' }, item.chord) : null,
      ) as HTMLButtonElement
      row.addEventListener('click', () => {
        close(true)
        control.onPick(item.id)
      })
      itemButtons.set(item.id, row)
      list.append(row)
    }
  })
  const markChecked = (): void => {
    for (const [id, row] of itemButtons) row.setAttribute('aria-checked', String(id === checked))
  }
  const rows = (): HTMLButtonElement[] => [...itemButtons.values()]
  const open = (): void => {
    list.hidden = false
    button.setAttribute('aria-expanded', 'true')
    onOpenChange()
    const first = (checked ? itemButtons.get(checked) : null) ?? rows()[0]
    first?.focus()
  }
  function close(restoreFocus: boolean): void {
    if (list.hidden) return
    list.hidden = true
    button.setAttribute('aria-expanded', 'false')
    onOpenChange()
    if (restoreFocus) button.focus()
  }
  button.addEventListener('click', () => (list.hidden ? open() : close(true)))
  list.addEventListener('keydown', (event) => {
    const all = rows()
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    const move: Record<string, number> = {
      ArrowDown: (at + 1) % all.length,
      ArrowUp: (at - 1 + all.length) % all.length,
      Home: 0,
      End: all.length - 1,
    }
    if (event.key in move) {
      event.preventDefault()
      all[move[event.key]]?.focus()
    } else if (event.key === 'Tab') close(false)
  })
  markChecked()
  const node = h('div', { class: 'ostia-pill-menu-anchor' }, button, list)
  return {
    node,
    button,
    isOpen: () => !list.hidden,
    close,
    update: (patch) => {
      if (patch.text !== undefined) text.textContent = patch.text
      if (patch.disabled !== undefined) button.disabled = patch.disabled
      if (patch.checked !== undefined) {
        checked = patch.checked
        markChecked()
      }
    },
  }
}
