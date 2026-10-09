import '@testing-library/jest-dom/vitest'
import { FilesPanel } from '@/components/files/FilesPanel'
import { FILES_WIDTH, PANEL_KEY_STEP, RAIL_WIDTH, panelMaxWidth } from '@/lib/panes/panelWidth'
import { useUIStore } from '@/stores/uiStore'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installLocalStorage } from '../../../../test/mocks/memoryStorage'
import { PanelResizer } from './PanelResizer'

const RAIL_DEFAULT_WIDTH = RAIL_WIDTH.defaultWidth
const RAIL_MIN_WIDTH = RAIL_WIDTH.minWidth
const RAIL_WIDTH_KEY = RAIL_WIDTH.storageKey
const RAIL_KEY_STEP = PANEL_KEY_STEP
const railMaxWidth = (vw: number): number => panelMaxWidth(RAIL_WIDTH, vw)

function RailResizer(): JSX.Element {
  const collapsed = useUIStore((s) => s.railCollapsed)
  return (
    <PanelResizer
      spec={RAIL_WIDTH}
      label="Resize sidebar"
      controls="deck-rail"
      className="rail-resizer"
      collapsed={collapsed}
      onCollapsedChange={useUIStore.getState().setRailCollapsed}
    />
  )
}

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

describe('Files panel resizer', () => {
  const filesSeparator = (): HTMLElement => screen.getByRole('separator', { name: 'Resize Files' })
  const filesVar = (): string => document.documentElement.style.getPropertyValue('--files-w')

  beforeEach(() => {
    installLocalStorage()
    HTMLElement.prototype.setPointerCapture = () => {}
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    document.documentElement.style.removeProperty('--files-w')
    document.documentElement.removeAttribute('data-rail-resizing')
  })

  it('sits on the Files panel edge and controls the panel', async () => {
    render(<FilesPanel />)
    await act(async () => {})
    const el = filesSeparator()
    expect(el).toHaveAttribute('aria-controls', 'files-panel')
    expect(document.getElementById('files-panel')).toContainElement(el)
    expect(el).toHaveAttribute('aria-valuenow', String(FILES_WIDTH.defaultWidth))
    expect(filesVar()).toBe(`${FILES_WIDTH.defaultWidth}px`)
  })

  it('widens with a drag, stores the width apart from the rail, and never collapses', async () => {
    render(<FilesPanel />)
    await act(async () => {})
    const el = filesSeparator()
    pointer('pointerdown', el, 500)
    pointer('pointermove', el, 700)
    pointer('pointerup', el, 700)
    expect(filesVar()).toBe(`${FILES_WIDTH.defaultWidth + 200}px`)
    expect(window.localStorage.getItem(FILES_WIDTH.storageKey)).toBe(
      String(FILES_WIDTH.defaultWidth + 200),
    )
    expect(window.localStorage.getItem(RAIL_WIDTH_KEY)).toBeNull()

    pointer('pointerdown', el, 700)
    pointer('pointermove', el, 0)
    pointer('pointerup', el, 0)
    expect(filesVar()).toBe(`${FILES_WIDTH.minWidth}px`)
    expect(filesSeparator()).toBeInTheDocument()
  })
})
