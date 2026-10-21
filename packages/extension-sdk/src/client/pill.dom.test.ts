import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import {
  createPill,
  type FindOptions,
  PILL_IDLE_MS,
  type Pill,
  type PillControl,
  type PillFind,
} from './pill'
import { clearSelection, publishSelection } from './viewer'

Object.assign(globalThis, {
  EventSource: class {
    addEventListener(): void {}
    close(): void {}
  },
})

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0"/></svg>'

const FIND_LABELS = {
  placeholder: 'Find in document',
  matchCase: 'Match case',
  highlightAll: 'Highlight all',
  previous: 'Previous match',
  next: 'Next match',
  done: 'Done',
  none: 'No matches',
  count: (index: number, total: number) => `${index} of ${total}`,
}

interface Spies {
  click: Mock<() => void>
  toggle: Mock<(pressed: boolean) => void>
  pick: Mock<(id: string) => void>
  go: Mock<(page: number) => void>
  query: Mock<(query: string, options: FindOptions) => void>
  step: Mock<(direction: 1 | -1) => void>
  closed: Mock<() => void>
}

function build(extra: PillControl[] = []): { pill: Pill; spies: Spies } {
  const spies: Spies = {
    click: vi.fn(),
    toggle: vi.fn(),
    pick: vi.fn(),
    go: vi.fn(),
    query: vi.fn(),
    step: vi.fn(),
    closed: vi.fn(),
  }
  const find: PillFind = {
    type: 'find',
    id: 'find',
    label: 'Find',
    chord: 'Ctrl+F',
    icon: SVG,
    labels: FIND_LABELS,
    onQuery: spies.query,
    onStep: spies.step,
    onClose: spies.closed,
  }
  const pill = createPill({
    label: 'Viewer tools',
    controls: [
      { type: 'button', id: 'fit', label: 'Fit', chord: 'Ctrl+9', icon: SVG, onClick: spies.click },
      { type: 'toggle', id: 'crop', label: 'Crop', icon: SVG, onToggle: spies.toggle },
      {
        type: 'menu',
        id: 'zoom',
        label: 'Zoom',
        text: '100%',
        checked: 'fit-width',
        items: [
          [
            { id: 'fit-width', label: 'Fit width', chord: 'Ctrl+8' },
            { id: 'actual', label: 'Actual size' },
          ],
          [{ id: '50', label: '50%' }],
        ],
        onPick: spies.pick,
      },
      {
        type: 'pager',
        id: 'pages',
        label: 'Page',
        page: 2,
        count: 12,
        of: (count) => `of ${count}`,
        previous: { label: 'Previous page' },
        next: { label: 'Next page' },
        onGo: spies.go,
      },
      find,
      ...extra,
    ],
  })
  return { pill, spies }
}

function button(pill: Pill, label: string): HTMLButtonElement {
  const found = pill.element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!found) throw new Error(`no button ${label}`)
  return found
}

function key(target: EventTarget, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

let pill: Pill

beforeEach(() => {
  vi.useFakeTimers()
  document.body.replaceChildren()
})

afterEach(async () => {
  pill?.destroy()
  vi.stubGlobal('fetch', async () => ({ ok: true }))
  await clearSelection()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const state = (): string | undefined => pill.element.dataset.state

describe('pill controls', () => {
  it('labels every control and puts the chord in its tooltip', () => {
    pill = build().pill
    expect(pill.element.getAttribute('role')).toBe('toolbar')
    expect(pill.element.getAttribute('aria-label')).toBe('Viewer tools')
    expect(button(pill, 'Fit').title).toBe('Fit (Ctrl+9)')
    expect(button(pill, 'Crop').title).toBe('Crop')
    expect(button(pill, 'Zoom').title).toBe('Zoom')
    expect(button(pill, 'Find').title).toBe('Find (Ctrl+F)')
  })

  it('runs a button and flips a toggle through aria-pressed', () => {
    const built = build()
    pill = built.pill
    button(pill, 'Fit').click()
    expect(built.spies.click).toHaveBeenCalledTimes(1)
    const crop = button(pill, 'Crop')
    expect(crop.getAttribute('aria-pressed')).toBe('false')
    crop.click()
    expect(crop.getAttribute('aria-pressed')).toBe('true')
    expect(built.spies.toggle).toHaveBeenLastCalledWith(true)
    crop.click()
    expect(built.spies.toggle).toHaveBeenLastCalledWith(false)
    pill.setState('crop', { pressed: true, disabled: true })
    expect(crop.getAttribute('aria-pressed')).toBe('true')
    expect(crop.disabled).toBe(true)
    pill.setState('missing', { disabled: true })
  })

  it('opens a menu with its checked item, picks with the keyboard and closes on Esc', () => {
    const built = build()
    pill = built.pill
    const zoom = button(pill, 'Zoom')
    zoom.click()
    const menu = pill.element.querySelector<HTMLElement>('[role="menu"]')
    expect(menu?.hidden).toBe(false)
    expect(zoom.getAttribute('aria-expanded')).toBe('true')
    const items = [...pill.element.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ])
    expect(document.activeElement).toBe(items[0])
    key(items[0], 'ArrowDown')
    expect(document.activeElement).toBe(items[1])
    key(items[1], 'ArrowUp')
    key(items[0], 'ArrowUp')
    expect(document.activeElement).toBe(items[2])
    key(items[2], 'Escape')
    expect(menu?.hidden).toBe(true)
    expect(document.activeElement).toBe(zoom)
    zoom.click()
    items[1].click()
    expect(built.spies.pick).toHaveBeenCalledWith('actual')
    expect(menu?.hidden).toBe(true)
    pill.setState('zoom', { text: '120%', checked: 'actual' })
    expect(zoom.textContent).toContain('120%')
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ])
  })

  it('closes a menu when the pointer goes down outside it', () => {
    pill = build().pill
    button(pill, 'Zoom').click()
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(pill.element.querySelector<HTMLElement>('[role="menu"]')?.hidden).toBe(true)
  })

  it('goes to a typed page, clamps it, and disables the ends of the pager', () => {
    const built = build()
    pill = built.pill
    const box = pill.element.querySelector<HTMLInputElement>('.ostia-pill-page')
    if (!box) throw new Error('no page box')
    expect(box.value).toBe('2')
    expect(pill.element.querySelector('.ostia-pill-of')?.textContent).toBe('of 12')
    box.value = '99'
    key(box, 'Enter')
    expect(built.spies.go).toHaveBeenLastCalledWith(12)
    box.value = 'x'
    key(box, 'Enter')
    expect(box.value).toBe('2')
    button(pill, 'Previous page').click()
    expect(built.spies.go).toHaveBeenLastCalledWith(1)
    pill.setState('pages', { page: 1 })
    expect(button(pill, 'Previous page').disabled).toBe(true)
    pill.setState('pages', { page: 12, count: 12 })
    expect(button(pill, 'Next page').disabled).toBe(true)
    built.spies.go.mockClear()
    button(pill, 'Next page').click()
    expect(built.spies.go).not.toHaveBeenCalled()
  })
})

describe('pill visibility', () => {
  it('shows at first, hides when idle and shows again on pointer movement', () => {
    pill = build().pill
    expect(state()).toBe('visible')
    vi.advanceTimersByTime(PILL_IDLE_MS + 1)
    expect(state()).toBe('hidden')
    expect(pill.element.hasAttribute('inert')).toBe(true)
    document.dispatchEvent(new MouseEvent('pointermove'))
    expect(state()).toBe('visible')
    expect(pill.element.hasAttribute('inert')).toBe(false)
    vi.advanceTimersByTime(PILL_IDLE_MS - 100)
    document.dispatchEvent(new MouseEvent('pointermove'))
    vi.advanceTimersByTime(PILL_IDLE_MS - 100)
    expect(state()).toBe('visible')
    vi.advanceTimersByTime(200)
    expect(state()).toBe('hidden')
  })

  it('stays while the pointer is on it or focus is inside it, then goes idle', () => {
    pill = build().pill
    pill.element.dispatchEvent(new MouseEvent('pointerenter'))
    vi.advanceTimersByTime(PILL_IDLE_MS * 3)
    expect(state()).toBe('visible')
    pill.element.dispatchEvent(new MouseEvent('pointerleave'))
    vi.advanceTimersByTime(PILL_IDLE_MS + 1)
    expect(state()).toBe('hidden')
    document.dispatchEvent(new MouseEvent('pointermove'))
    button(pill, 'Fit').focus()
    vi.advanceTimersByTime(PILL_IDLE_MS * 3)
    expect(state()).toBe('visible')
  })

  it('stays while a menu is open', () => {
    pill = build().pill
    button(pill, 'Zoom').click()
    vi.advanceTimersByTime(PILL_IDLE_MS * 3)
    expect(state()).toBe('visible')
  })

  it('focuses its first button on the first Tab in the page and keeps it visible', () => {
    pill = build().pill
    vi.advanceTimersByTime(PILL_IDLE_MS + 1)
    expect(state()).toBe('hidden')
    const tab = key(document.body, 'Tab')
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(button(pill, 'Fit'))
    expect(state()).toBe('visible')
    vi.advanceTimersByTime(PILL_IDLE_MS * 3)
    expect(state()).toBe('visible')
    expect(key(button(pill, 'Fit'), 'Tab').defaultPrevented).toBe(false)
  })

  it('leaves Tab to the page when something else has focus or Shift is held', () => {
    pill = build().pill
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    expect(key(field, 'Tab').defaultPrevented).toBe(false)
    field.blur()
    expect(key(document.body, 'Tab', { shiftKey: true }).defaultPrevented).toBe(false)
    expect(key(document.body, 'Tab', { ctrlKey: true }).defaultPrevented).toBe(false)
  })

  it('returns focus to the page on Esc', () => {
    pill = build().pill
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    )
    expect(pill.element.contains(document.activeElement)).toBe(true)
    key(document.activeElement ?? document.body, 'Escape')
    expect(pill.element.contains(document.activeElement)).toBe(false)
    expect(document.activeElement).toBe(document.body)
    vi.advanceTimersByTime(PILL_IDLE_MS + 1)
    expect(state()).toBe('hidden')
  })

  it('hides while the guest has a published selection and when the host hides it', async () => {
    pill = build().pill
    vi.stubGlobal('fetch', async () => ({ ok: true }))
    await publishSelection({
      capture: { kind: 'pdf-text', firstPage: 1, lastPage: 1 },
      rect: { x: 0, y: 0, width: 1, height: 1 },
      text: 'x',
    })
    expect(state()).toBe('hidden')
    document.dispatchEvent(new MouseEvent('pointermove'))
    expect(state()).toBe('hidden')
    await clearSelection()
    expect(state()).toBe('visible')
    pill.setHidden(true)
    expect(state()).toBe('hidden')
    pill.setHidden(false)
    expect(state()).toBe('visible')
  })

  it('does not slide for reduced motion', () => {
    const css = readFileSync(join(__dirname, 'panel.css'), 'utf8')
    const block = /@media \(prefers-reduced-motion: reduce\) \{([^@]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(block).toContain('.ostia-pill')
    expect(block).toContain('transform: none')
    expect(block).toContain('transition: none')
  })
})

describe('pill find keys', () => {
  it('claims the find keys from the host when it has a find control, and only then', () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      fetched.push(`${init.method} ${url}`)
      return { ok: true }
    })
    pill = build().pill
    expect(fetched).toEqual(['POST /~find-keys'])
    pill.destroy()
    pill = createPill({
      label: 'Tools',
      controls: [{ type: 'button', id: 'fit', label: 'Fit', icon: SVG, onClick: () => {} }],
    })
    expect(fetched).toHaveLength(1)
  })
})

describe('pill find row', () => {
  function open(): { built: ReturnType<typeof build>; field: HTMLInputElement } {
    const built = build()
    pill = built.pill
    button(pill, 'Find').click()
    const field = pill.element.querySelector<HTMLInputElement>('.ostia-pill-find-field')
    if (!field) throw new Error('no field')
    return { built, field }
  }

  it('turns the pill into the find row with the field focused', () => {
    const { field } = open()
    expect(pill.find.isOpen()).toBe(true)
    expect(pill.element.querySelector<HTMLElement>('.ostia-pill-controls')?.hidden).toBe(true)
    expect(pill.element.querySelector<HTMLElement>('.ostia-pill-find')?.hidden).toBe(false)
    expect(document.activeElement).toBe(field)
    vi.advanceTimersByTime(PILL_IDLE_MS * 3)
    expect(state()).toBe('visible')
  })

  it('queries as you type with its toggles, and steps with Enter and Shift+Enter', () => {
    const { built, field } = open()
    field.value = 'desk'
    field.dispatchEvent(new Event('input'))
    expect(built.spies.query).toHaveBeenLastCalledWith('desk', {
      matchCase: false,
      highlightAll: false,
    })
    button(pill, 'Match case').click()
    expect(button(pill, 'Match case').getAttribute('aria-pressed')).toBe('true')
    expect(built.spies.query).toHaveBeenLastCalledWith('desk', {
      matchCase: true,
      highlightAll: false,
    })
    button(pill, 'Highlight all').click()
    expect(built.spies.query).toHaveBeenLastCalledWith('desk', {
      matchCase: true,
      highlightAll: true,
    })
    expect(key(field, 'Enter').defaultPrevented).toBe(true)
    expect(built.spies.step).toHaveBeenLastCalledWith(1)
    key(field, 'Enter', { shiftKey: true })
    expect(built.spies.step).toHaveBeenLastCalledWith(-1)
    button(pill, 'Next match').click()
    expect(built.spies.step).toHaveBeenLastCalledWith(1)
    button(pill, 'Previous match').click()
    expect(built.spies.step).toHaveBeenLastCalledWith(-1)
  })

  it('shows n of N, no matches, and nothing for an empty query', () => {
    const { field } = open()
    const count = pill.element.querySelector('.ostia-pill-find-count')
    pill.find.setResult({ index: 2, total: 5 })
    expect(count?.textContent).toBe('')
    field.value = 'desk'
    field.dispatchEvent(new Event('input'))
    pill.find.setResult({ index: 2, total: 5 })
    expect(count?.textContent).toBe('2 of 5')
    pill.find.setResult({ index: 0, total: 0 })
    expect(count?.textContent).toBe('No matches')
  })

  it('closes on Esc and on Done, bringing the controls back', () => {
    const { built, field } = open()
    key(field, 'Escape')
    expect(pill.find.isOpen()).toBe(false)
    expect(built.spies.closed).toHaveBeenCalledTimes(1)
    expect(pill.element.querySelector<HTMLElement>('.ostia-pill-controls')?.hidden).toBe(false)
    expect(pill.element.querySelector<HTMLElement>('.ostia-pill-find')?.hidden).toBe(true)
    expect(document.activeElement).toBe(document.body)
    pill.find.open()
    button(pill, 'Done').click()
    expect(built.spies.closed).toHaveBeenCalledTimes(2)
    pill.find.close()
    expect(built.spies.closed).toHaveBeenCalledTimes(2)
  })

  it('opens from code and has a no-op find handle when no find control exists', () => {
    pill = createPill({ label: 'Tools', controls: [] })
    pill.find.open()
    expect(pill.find.isOpen()).toBe(false)
    pill.find.setResult({ index: 1, total: 1 })
  })
})
