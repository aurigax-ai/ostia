import { h } from './panel'
import { buildFindRow, type FindRow } from './pillFind'
import { buildMenu, type MenuHandle } from './pillMenu'
import { buildButton, buildPager, iconButton } from './pillParts'
import type { FindHandle, Pill, PillOptions, Update } from './pillTypes'
import { hasPublishedSelection, onSelectionPublished } from './viewer'

export type {
  FindHandle,
  FindOptions,
  Pill,
  PillButton,
  PillControl,
  PillFind,
  PillFindLabels,
  PillMenu,
  PillMenuItem,
  PillOptions,
  PillPager,
  PillStatePatch,
  PillToggle,
} from './pillTypes'

export const PILL_IDLE_MS = 2500

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
