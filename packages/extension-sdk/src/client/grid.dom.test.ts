import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Grid, type GridSelectEvent, grid } from './grid'

const hostClears = vi.hoisted(() => new Set<() => void>())

vi.mock('./viewer', () => ({
  onSelectionCleared: (listener: () => void) => {
    hostClears.add(listener)
    return () => hostClears.delete(listener)
  },
}))

const ROWS = 20
const COLUMNS = 6
const SCROLL_BOX = { width: 800, height: 240 }

let mounted: Grid | null = null

function stubLayout(): void {
  const is = (el: HTMLElement, name: string): boolean => el.classList.contains(name)
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (is(this, 'ostia-grid-probe')) return 80
      return is(this, 'ostia-grid-scroll') ? SCROLL_BOX.width : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (is(this, 'ostia-grid-probe')) return 24
      return is(this, 'ostia-grid-scroll') ? SCROLL_BOX.height : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return is(this, 'ostia-grid-scroll') ? SCROLL_BOX.width : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return is(this, 'ostia-grid-scroll') ? SCROLL_BOX.height : 0
    },
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const scroll = is(this, 'ostia-grid-scroll')
    return {
      x: scroll ? 10 : 0,
      y: scroll ? 20 : 0,
      left: scroll ? 10 : 0,
      top: scroll ? 20 : 0,
      width: scroll ? SCROLL_BOX.width : 0,
      height: scroll ? SCROLL_BOX.height : 0,
      right: 0,
      bottom: 0,
      toJSON: () => ({}),
    }
  })
}

async function mount(extra: Partial<Parameters<typeof grid>[0]> = {}): Promise<{
  view: Grid
  onSelect: ReturnType<typeof vi.fn<(event: GridSelectEvent | null) => void>>
}> {
  const onSelect = vi.fn<(event: GridSelectEvent | null) => void>()
  const view = grid({
    label: 'Sheet',
    columns: ['A', 'B', 'C', 'D', 'E', 'F'],
    rowCount: ROWS,
    cell: (row, column) => `r${row}c${column}`,
    rowLabels: true,
    onSelect,
    ...extra,
  })
  mounted = view
  document.body.append(view.element)
  await Promise.resolve()
  await Promise.resolve()
  return { view, onSelect }
}

const cell = (row: number, column: number): HTMLElement => {
  const el = document.querySelector<HTMLElement>(
    `[data-part="cell"][data-row="${row}"][data-column="${column}"]`,
  )
  if (!el) throw new Error(`cell ${row},${column} is not rendered`)
  return el
}

const header = (part: 'column' | 'row' | 'corner', index = 0): HTMLElement => {
  const selector =
    part === 'corner' ? '[data-part="corner"]' : `[data-part="${part}"][data-${part}="${index}"]`
  const el = document.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`${part} ${index} is not rendered`)
  return el
}

function press(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init })
  el.dispatchEvent(event)
  return event
}

function hover(el: Element): void {
  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 }))
}

function lift(): void {
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}

function click(el: Element, init: MouseEventInit = {}): void {
  press(el, init)
  lift()
}

function key(el: Element, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  el.dispatchEvent(event)
  return event
}

function rangeOf(onSelect: { mock: { lastCall?: [GridSelectEvent | null] } }) {
  return onSelect.mock.lastCall?.[0]?.range ?? null
}

function selectedCells(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-part="cell"][aria-selected="true"]'),
  ].map((el) => `${el.dataset.row},${el.dataset.column}`)
}

beforeEach(stubLayout)

afterEach(() => {
  mounted?.destroy()
  mounted = null
  vi.restoreAllMocks()
  for (const name of ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight']) {
    Reflect.deleteProperty(HTMLElement.prototype, name)
  }
})

describe('the cell grid', () => {
  it('draws flat grid cells with their positions and one tab stop', async () => {
    const { view } = await mount()
    const scroller = view.element.querySelector('[role="grid"]')
    expect(scroller?.getAttribute('aria-multiselectable')).toBe('true')
    expect(cell(0, 0).getAttribute('role')).toBe('gridcell')
    expect(cell(3, 2).getAttribute('aria-rowindex')).toBe('5')
    expect(cell(3, 2).getAttribute('aria-colindex')).toBe('3')
    expect(cell(3, 2).getAttribute('aria-selected')).toBe('false')
    const stops = [...document.querySelectorAll('[tabindex="0"]')]
    expect(stops).toEqual([cell(0, 0)])
  })
})

describe('mouse selection', () => {
  it('selects a cell on click and reports once the button is released', async () => {
    const { onSelect } = await mount()
    press(cell(1, 2))
    expect(onSelect).not.toHaveBeenCalled()
    lift()
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(rangeOf(onSelect)).toEqual({ r1: 1, c1: 2, r2: 1, c2: 2 })
    expect(selectedCells()).toEqual(['1,2'])
    expect(document.activeElement).toBe(cell(1, 2))
    expect(cell(1, 2).tabIndex).toBe(0)
    expect(cell(0, 0).tabIndex).toBe(-1)
  })

  it('extends the range while dragging and draws its border and tint', async () => {
    const { onSelect } = await mount()
    press(cell(0, 0))
    hover(cell(1, 1))
    hover(cell(2, 2))
    expect(onSelect).not.toHaveBeenCalled()
    lift()
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 })
    expect(selectedCells()).toHaveLength(9)
    expect(cell(0, 0).classList.contains('ostia-grid-edge-top')).toBe(true)
    expect(cell(0, 0).classList.contains('ostia-grid-edge-left')).toBe(true)
    expect(cell(0, 0).classList.contains('ostia-grid-edge-right')).toBe(false)
    expect(cell(1, 1).classList.contains('ostia-grid-selected')).toBe(true)
    expect(cell(1, 1).classList.contains('ostia-grid-edged')).toBe(false)
    expect(cell(2, 2).classList.contains('ostia-grid-edge-bottom')).toBe(true)
    expect(cell(2, 2).classList.contains('ostia-grid-edge-right')).toBe(true)
    expect(cell(3, 3).classList.contains('ostia-grid-selected')).toBe(false)
    expect(header('column', 1).classList.contains('ostia-grid-selected')).toBe(true)
    expect(header('column', 3).classList.contains('ostia-grid-selected')).toBe(false)
    expect(header('row', 2).classList.contains('ostia-grid-selected')).toBe(true)
  })

  it('drags in any direction', async () => {
    const { onSelect } = await mount()
    press(cell(3, 3))
    hover(cell(1, 0))
    lift()
    expect(rangeOf(onSelect)).toEqual({ r1: 1, c1: 0, r2: 3, c2: 3 })
  })

  it('stops following the pointer once the button is no longer down', async () => {
    const { onSelect } = await mount()
    press(cell(0, 0))
    cell(2, 2).dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 0 }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    hover(cell(3, 3))
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 })
  })

  it('extends from the anchor with Shift+click', async () => {
    const { onSelect } = await mount()
    click(cell(1, 1))
    click(cell(3, 2), { shiftKey: true })
    expect(rangeOf(onSelect)).toEqual({ r1: 1, c1: 1, r2: 3, c2: 2 })
    click(cell(0, 0), { shiftKey: true })
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 })
  })

  it('ignores other buttons and leaves the native selection off the cells', async () => {
    const { onSelect } = await mount()
    press(cell(1, 1), { button: 2 })
    lift()
    expect(onSelect).not.toHaveBeenCalled()
    expect(press(cell(1, 1)).defaultPrevented).toBe(true)
  })

  it('selects a whole column or row from its header, and extends them with Shift', async () => {
    const { onSelect } = await mount()
    click(header('column', 2))
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 2, r2: ROWS - 1, c2: 2 })
    expect(header('column', 2).classList.contains('ostia-grid-selected')).toBe(true)
    click(header('column', 4), { shiftKey: true })
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 2, r2: ROWS - 1, c2: 4 })
    click(header('row', 3))
    expect(rangeOf(onSelect)).toEqual({ r1: 3, c1: 0, r2: 3, c2: COLUMNS - 1 })
    click(header('row', 5), { shiftKey: true })
    expect(rangeOf(onSelect)).toEqual({ r1: 3, c1: 0, r2: 5, c2: COLUMNS - 1 })
  })

  it('selects everything from the corner', async () => {
    const { onSelect } = await mount()
    click(header('corner'))
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 0, r2: ROWS - 1, c2: COLUMNS - 1 })
  })

  it('clears the selection when the human presses anywhere outside the grid', async () => {
    const { onSelect, view } = await mount()
    click(cell(1, 1))
    const outside = document.createElement('button')
    document.body.append(outside)
    press(outside)
    expect(onSelect).toHaveBeenLastCalledWith(null)
    expect(view.selection()).toBeNull()
    expect(selectedCells()).toEqual([])
    outside.remove()
  })
})

describe('keyboard selection', () => {
  it('selects the cell it moves to with the arrow keys and keeps focus on it', async () => {
    const { onSelect } = await mount()
    cell(0, 0).focus()
    expect(key(cell(0, 0), 'ArrowDown').defaultPrevented).toBe(true)
    expect(rangeOf(onSelect)).toEqual({ r1: 1, c1: 0, r2: 1, c2: 0 })
    expect(document.activeElement).toBe(cell(1, 0))
    key(cell(1, 0), 'ArrowRight')
    expect(rangeOf(onSelect)).toEqual({ r1: 1, c1: 1, r2: 1, c2: 1 })
    key(cell(1, 1), 'ArrowUp')
    key(cell(0, 1), 'ArrowUp')
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 1, r2: 0, c2: 1 })
  })

  it('extends the range with Shift+arrows from the anchor', async () => {
    const { onSelect } = await mount()
    click(cell(1, 1))
    key(cell(1, 1), 'ArrowDown', { shiftKey: true })
    key(cell(2, 1), 'ArrowRight', { shiftKey: true })
    expect(rangeOf(onSelect)).toEqual({ r1: 1, c1: 1, r2: 2, c2: 2 })
    key(cell(2, 2), 'ArrowUp', { shiftKey: true })
    key(cell(1, 2), 'ArrowUp', { shiftKey: true })
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 1, r2: 1, c2: 2 })
  })

  it('starts a range from the focused cell when nothing is selected yet', async () => {
    const { onSelect } = await mount()
    cell(0, 0).focus()
    key(cell(0, 0), 'ArrowRight', { shiftKey: true })
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 0, r2: 0, c2: 1 })
  })

  it('goes to the row ends with Home and End and to the corners with Ctrl', async () => {
    const { onSelect } = await mount()
    click(cell(2, 2))
    key(cell(2, 2), 'End')
    expect(rangeOf(onSelect)).toEqual({ r1: 2, c1: COLUMNS - 1, r2: 2, c2: COLUMNS - 1 })
    key(cell(2, COLUMNS - 1), 'Home', { ctrlKey: true })
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 })
    key(cell(0, 0), 'End', { ctrlKey: true, shiftKey: true })
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 0, r2: ROWS - 1, c2: COLUMNS - 1 })
  })

  it('selects the focused cell with Space', async () => {
    const { onSelect } = await mount()
    cell(0, 0).focus()
    key(cell(0, 0), ' ')
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 })
  })

  it('selects everything with Ctrl+A and clears with Escape', async () => {
    const { onSelect, view } = await mount()
    click(cell(1, 1))
    expect(key(cell(1, 1), 'a', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(rangeOf(onSelect)).toEqual({ r1: 0, c1: 0, r2: ROWS - 1, c2: COLUMNS - 1 })
    expect(key(cell(1, 1), 'Escape').defaultPrevented).toBe(true)
    expect(onSelect).toHaveBeenLastCalledWith(null)
    expect(view.selection()).toBeNull()
    expect(selectedCells()).toEqual([])
    const calls = onSelect.mock.calls.length
    expect(key(cell(1, 1), 'Escape').defaultPrevented).toBe(false)
    expect(onSelect).toHaveBeenCalledTimes(calls)
  })

  it('keeps the focus ring cell as the one tab stop after a clear', async () => {
    await mount()
    click(cell(2, 3))
    key(cell(2, 3), 'Escape')
    expect(document.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
    expect(cell(2, 3).tabIndex).toBe(0)
  })
})

describe('what the page reports and says', () => {
  it('gives the page rectangle of the range in the event', async () => {
    const { onSelect } = await mount()
    press(cell(0, 0))
    hover(cell(2, 1))
    lift()
    const rect = onSelect.mock.lastCall?.[0]?.rect
    expect(rect?.x).toBe(10 + 40)
    expect(rect?.y).toBe(20 + 24)
    expect(rect?.height).toBe(72)
    expect(rect?.width).toBeGreaterThan(0)
  })

  it('announces the range in a status region', async () => {
    const { view } = await mount({
      describe: (range) => `rows ${range.r1}-${range.r2}`,
    })
    click(cell(0, 0))
    click(cell(2, 2), { shiftKey: true })
    expect(view.element.querySelector('.sr-only')?.textContent).toBe('rows 0-2')
    key(cell(2, 2), 'Escape')
    expect(view.element.querySelector('.sr-only')?.textContent).toBe('')
  })

  it('shows one status line on request and hides it again', async () => {
    const { view } = await mount()
    const status = view.element.querySelector<HTMLElement>('.ostia-grid-note[role="status"]')
    expect(status?.hidden).toBe(true)
    view.setStatus('Selection too large to copy.')
    expect(status?.hidden).toBe(false)
    expect(status?.textContent).toBe('Selection too large to copy.')
    view.setStatus(null)
    expect(status?.hidden).toBe(true)
  })

  it('keeps the page from copying anything else while a range is selected', async () => {
    await mount()
    const copy = (): boolean => {
      const event = new Event('copy', { bubbles: true, cancelable: true })
      cell(0, 0).dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(copy()).toBe(false)
    click(cell(0, 0))
    expect(copy()).toBe(true)
  })

  it('clears from the page and does nothing on an empty grid', async () => {
    const { view, onSelect } = await mount()
    click(cell(0, 0))
    view.clearSelection()
    expect(onSelect).toHaveBeenLastCalledWith(null)
    mounted?.destroy()
    const empty = await mount({ rowCount: 0 })
    empty.view.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
    expect(empty.onSelect).not.toHaveBeenCalled()
  })
})

describe('a selection the host cleared', () => {
  it('is dropped from the grid, and the page is told it is gone', async () => {
    const { onSelect } = await mount()
    click(cell(1, 1))
    for (const clear of hostClears) clear()
    expect(selectedCells()).toEqual([])
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })

  it('stops listening once the grid is destroyed', async () => {
    await mount()
    expect(hostClears.size).toBe(1)
    mounted?.destroy()
    expect(hostClears.size).toBe(0)
  })
})

describe('rows added to the end', () => {
  it('keeps the drawn range, tells the page nothing and shows the new rows', async () => {
    const { view, onSelect } = await mount()
    click(cell(1, 1))
    press(cell(1, 1))
    hover(cell(3, 2))
    lift()
    const before = selectedCells()
    const reports = onSelect.mock.calls.length
    view.setRows(ROWS + 5, (row, column) => `r${row}c${column}`)
    expect(selectedCells()).toEqual(before)
    expect(onSelect.mock.calls).toHaveLength(reports)
    expect(cell(0, 0).textContent).toBe('r0c0')
    expect(view.element.querySelector('[role="grid"]')?.getAttribute('aria-rowcount')).toBe(
      String(ROWS + 6),
    )
  })

  it('freezes a whole-column selection so it does not grow with the rows', async () => {
    const { view } = await mount()
    click(header('column', 1))
    expect(view.selection()).toMatchObject({ r1: 0, r2: ROWS - 1, c1: 1, c2: 1 })
    view.setRows(ROWS + 5, () => '')
    expect(view.selection()).toMatchObject({ r1: 0, r2: ROWS - 1, c1: 1, c2: 1 })
  })
})
