import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installLocalStorage } from '../../../test/mocks/memoryStorage'
import {
  RAIL_DEFAULT_WIDTH,
  RAIL_KEY_STEP,
  RAIL_MIN_WIDTH,
  RAIL_WIDTH_KEY,
  railMaxWidth,
} from '../lib/railWidth'
import { useUIStore } from '../stores/uiStore'
import { RailResizer } from './RailResizer'

const separator = (): HTMLElement => screen.getByRole('separator', { name: 'Resize sidebar' })
const railVar = (): string => document.documentElement.style.getPropertyValue('--rail-w')

function pointer(type: string, el: HTMLElement, clientX: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  fireEvent(el, event)
}

describe('RailResizer', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    uiInit = useUIStore.getState()
  })

  beforeEach(() => {
    installLocalStorage()
    HTMLElement.prototype.setPointerCapture = () => {}
  })

  afterEach(() => {
    cleanup()
    useUIStore.setState(uiInit, true)
    window.localStorage.clear()
    document.documentElement.style.removeProperty('--rail-w')
    document.documentElement.removeAttribute('data-rail-resizing')
  })

  it('is a focusable vertical separator that reports the width and its range', () => {
    render(<RailResizer />)
    const el = separator()
    expect(el).toHaveAttribute('aria-orientation', 'vertical')
    expect(el).toHaveAttribute('aria-valuenow', String(RAIL_DEFAULT_WIDTH))
    expect(el).toHaveAttribute('aria-valuemin', String(RAIL_MIN_WIDTH))
    expect(el).toHaveAttribute('aria-valuemax', String(railMaxWidth(window.innerWidth)))
    expect(el).toHaveAttribute('aria-controls', 'deck-rail')
    expect(el.tabIndex).toBe(0)
    expect(railVar()).toBe(`${RAIL_DEFAULT_WIDTH}px`)
  })

  it('starts at the width stored by an earlier run', () => {
    window.localStorage.setItem(RAIL_WIDTH_KEY, '300')
    render(<RailResizer />)
    expect(separator()).toHaveAttribute('aria-valuenow', '300')
    expect(railVar()).toBe('300px')
  })

  it('widens and narrows by one step with the arrow keys and stores the width', () => {
    render(<RailResizer />)
    fireEvent.keyDown(separator(), { key: 'ArrowRight' })
    expect(separator()).toHaveAttribute('aria-valuenow', String(RAIL_DEFAULT_WIDTH + RAIL_KEY_STEP))
    expect(window.localStorage.getItem(RAIL_WIDTH_KEY)).toBe(
      String(RAIL_DEFAULT_WIDTH + RAIL_KEY_STEP),
    )
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' })
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' })
    expect(separator()).toHaveAttribute('aria-valuenow', String(RAIL_DEFAULT_WIDTH - RAIL_KEY_STEP))
  })

  it('jumps to the ends with Home and End', () => {
    render(<RailResizer />)
    fireEvent.keyDown(separator(), { key: 'End' })
    expect(separator()).toHaveAttribute('aria-valuenow', String(railMaxWidth(window.innerWidth)))
    fireEvent.keyDown(separator(), { key: 'Home' })
    expect(separator()).toHaveAttribute('aria-valuenow', String(RAIL_MIN_WIDTH))
    expect(railVar()).toBe(`${RAIL_MIN_WIDTH}px`)
  })

  it('resets to the default width on double-click', () => {
    window.localStorage.setItem(RAIL_WIDTH_KEY, '320')
    render(<RailResizer />)
    fireEvent.doubleClick(separator())
    expect(separator()).toHaveAttribute('aria-valuenow', String(RAIL_DEFAULT_WIDTH))
    expect(window.localStorage.getItem(RAIL_WIDTH_KEY)).toBe(String(RAIL_DEFAULT_WIDTH))
  })

  it('follows a drag, blocks selection while dragging, and stores the width on release', () => {
    render(<RailResizer />)
    const el = separator()
    pointer('pointerdown', el, 240)
    expect(document.documentElement).toHaveAttribute('data-rail-resizing')
    pointer('pointermove', el, 300)
    expect(railVar()).toBe('300px')
    expect(window.localStorage.getItem(RAIL_WIDTH_KEY)).toBeNull()
    pointer('pointerup', el, 300)
    expect(document.documentElement).not.toHaveAttribute('data-rail-resizing')
    expect(window.localStorage.getItem(RAIL_WIDTH_KEY)).toBe('300')
  })

  it('collapses the rail when dragged far below the minimum, and expands it when dragged back', () => {
    render(<RailResizer />)
    const el = separator()
    pointer('pointerdown', el, 240)
    pointer('pointermove', el, 40)
    expect(useUIStore.getState().railCollapsed).toBe(true)
    pointer('pointermove', el, 200)
    expect(useUIStore.getState().railCollapsed).toBe(false)
    expect(railVar()).toBe('200px')
    pointer('pointermove', el, 30)
    pointer('pointerup', el, 30)
    expect(useUIStore.getState().railCollapsed).toBe(true)
    expect(window.localStorage.getItem(RAIL_WIDTH_KEY)).toBe(String(RAIL_DEFAULT_WIDTH))
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('is hidden while the rail is collapsed', () => {
    useUIStore.setState({ railCollapsed: true })
    render(<RailResizer />)
    expect(screen.queryByRole('separator')).toBeNull()
  })
})
