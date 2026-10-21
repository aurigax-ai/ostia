import { h, icon } from './panel'
import { PILL_ICONS } from './pillIcons'
import { hasPublishedSelection, onSelectionPublished } from './viewer'

export const PILL_IDLE_MS = 2500

interface PillBase {
  id: string
  label: string
  chord?: string
  disabled?: boolean
}

export interface PillButton extends PillBase {
  type: 'button'
  icon: string
  onClick: () => void
}

export interface PillToggle extends PillBase {
  type: 'toggle'
  icon: string
  pressed?: boolean
  onToggle: (pressed: boolean) => void
}

export interface PillMenuItem {
  id: string
  label: string
  chord?: string
}

export interface PillMenu extends PillBase {
  type: 'menu'
  text: string
  items: PillMenuItem[][]
  checked?: string
  onPick: (id: string) => void
}

interface PillStep {
  label: string
  chord?: string
}

export interface PillPager extends PillBase {
  type: 'pager'
  page: number
  count: number
  of: (count: number) => string
  previous: PillStep
  next: PillStep
  onGo: (page: number) => void
}

export interface PillFindLabels {
  placeholder: string
  matchCase: string
  highlightAll: string
  previous: string
  next: string
  done: string
  none: string
  count: (index: number, total: number) => string
}

export interface FindOptions {
  matchCase: boolean
  highlightAll: boolean
}

export interface PillFind extends PillBase {
  type: 'find'
  icon: string
  labels: PillFindLabels
  onQuery: (query: string, options: FindOptions) => void
  onStep: (direction: 1 | -1) => void
  onClose: () => void
}

export type PillControl = PillButton | PillToggle | PillMenu | PillPager | PillFind

export interface PillOptions {
  label: string
  controls: PillControl[]
  page?: HTMLElement
  parent?: HTMLElement
}

export interface PillStatePatch {
  disabled?: boolean
  pressed?: boolean
  text?: string
  checked?: string | null
  page?: number
  count?: number
}

export interface FindHandle {
  open: () => void
  close: () => void
  isOpen: () => boolean
  setResult: (result: { index: number; total: number }) => void
}

export interface Pill {
  element: HTMLElement
  setState: (id: string, patch: PillStatePatch) => void
  setHidden: (hidden: boolean) => void
  find: FindHandle
  destroy: () => void
}

type Update = (patch: PillStatePatch) => void

interface Built {
  node: HTMLElement
  update: Update
}

function tip(label: string, chord?: string): string {
  return chord ? `${label} (${chord})` : label
}

function iconButton(
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

function buildButton(control: PillButton | PillToggle): Built {
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

function buildPager(control: PillPager): Built {
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

interface MenuHandle extends Built {
  button: HTMLButtonElement
  isOpen: () => boolean
  close: (restoreFocus: boolean) => void
}

function buildMenu(control: PillMenu, onOpenChange: () => void): MenuHandle {
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

interface FindRow {
  node: HTMLElement
  handle: FindHandle
}

function buildFindRow(control: PillFind, onToggle: (open: boolean) => void): FindRow {
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

export function createPill(options: PillOptions): Pill {
  const updates = new Map<string, Update>()
  const menus: MenuHandle[] = []
  const state = {
    hostHidden: false,
    selection: hasPublishedSelection(),
    awake: false,
    hover: false,
    menuOpen: false,
    findOpen: false,
  }
  const controls = h('div', { class: 'ostia-pill-controls' })
  const element = h(
    'div',
    { class: 'ostia-pill', role: 'toolbar', 'aria-label': options.label, 'data-state': 'hidden' },
    controls,
  )
  let idle: ReturnType<typeof setTimeout> | null = null

  const held = (): boolean =>
    state.hover || state.menuOpen || state.findOpen || element.contains(document.activeElement)
  const shown = (): boolean => !state.hostHidden && !state.selection && (state.awake || held())
  const render = (): void => {
    const visible = shown()
    element.dataset.state = visible ? 'visible' : 'hidden'
    if (visible) element.removeAttribute('inert')
    else element.setAttribute('inert', '')
  }
  const wake = (): void => {
    state.awake = true
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => {
      state.awake = false
      render()
    }, PILL_IDLE_MS)
    render()
  }
  const syncMenuOpen = (): void => {
    state.menuOpen = menus.some((menu) => menu.isOpen())
    if (state.menuOpen) wake()
    else render()
  }
  const focusPage = (): void => {
    const page = options.page ?? document.body
    if (!page.hasAttribute('tabindex')) page.tabIndex = -1
    page.focus({ preventScroll: true })
  }

  let findRow: FindRow | null = null
  const noFind: FindHandle = {
    open: () => {},
    close: () => {},
    isOpen: () => false,
    setResult: () => {},
  }

  for (const control of options.controls) {
    if (control.type === 'button' || control.type === 'toggle') {
      const built = buildButton(control)
      updates.set(control.id, built.update)
      controls.append(built.node)
    } else if (control.type === 'pager') {
      const built = buildPager(control)
      updates.set(control.id, built.update)
      controls.append(built.node)
    } else if (control.type === 'menu') {
      const built = buildMenu(control, syncMenuOpen)
      menus.push(built)
      updates.set(control.id, built.update)
      controls.append(built.node)
    } else {
      findRow = buildFindRow(control, (open) => {
        state.findOpen = open
        controls.hidden = open
        if (findRow) findRow.node.hidden = !open
        if (open) wake()
        else render()
      })
      const trigger = iconButton(control.label, control.chord, control.icon)
      trigger.disabled = control.disabled === true
      trigger.addEventListener('click', () => findRow?.handle.open())
      updates.set(control.id, (patch) => {
        if (patch.disabled !== undefined) trigger.disabled = patch.disabled
      })
      controls.append(trigger)
    }
  }
  if (findRow) element.append(findRow.node)

  element.addEventListener('pointerenter', () => {
    state.hover = true
    render()
  })
  element.addEventListener('pointerleave', () => {
    state.hover = false
    wake()
  })
  element.addEventListener('focusin', render)
  element.addEventListener('focusout', () => {
    queueMicrotask(wake)
  })
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    const open = menus.find((menu) => menu.isOpen())
    event.stopPropagation()
    if (open) open.close(true)
    else if (findRow?.handle.isOpen()) {
      findRow.handle.close()
      focusPage()
    } else focusPage()
  })

  const onDocumentPointer = (event: Event): void => {
    const target = event.target as Node | null
    for (const menu of menus) if (menu.isOpen() && !menu.node.contains(target)) menu.close(false)
    wake()
  }
  const onDocumentKey = (event: KeyboardEvent): void => {
    const focusOnPage = !element.contains(document.activeElement)
    const firstTab =
      event.key === 'Tab' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.defaultPrevented &&
      focusOnPage &&
      (document.activeElement === document.body || document.activeElement === null) &&
      !state.hostHidden &&
      !state.selection &&
      !state.findOpen
    if (firstTab) {
      const first = controls.querySelector<HTMLButtonElement>('button:not(:disabled)')
      if (first) {
        event.preventDefault()
        wake()
        first.focus()
        return
      }
    }
    if (event.key !== 'Escape') wake()
  }
  document.addEventListener('pointermove', wake)
  document.addEventListener('pointerdown', onDocumentPointer)
  document.addEventListener('keydown', onDocumentKey, true)
  const stopSelection = onSelectionPublished((published) => {
    state.selection = published
    render()
  })

  ;(options.parent ?? document.body).append(element)
  wake()

  return {
    element,
    setState: (id, patch) => updates.get(id)?.(patch),
    setHidden: (hidden) => {
      state.hostHidden = hidden
      render()
    },
    find: findRow?.handle ?? noFind,
    destroy: () => {
      if (idle) clearTimeout(idle)
      document.removeEventListener('pointermove', wake)
      document.removeEventListener('pointerdown', onDocumentPointer)
      document.removeEventListener('keydown', onDocumentKey, true)
      stopSelection()
      element.remove()
    },
  }
}
