import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parsePersisted, useSettingsStore } from '../stores/settingsStore'
import {
  activeFontZoom,
  attachWheelZoom,
  fontZoomPercent,
  resetFontZoom,
  resetZoom,
  zoomFont,
  zoomStep,
} from './wheelZoom'

describe('wheel zoom', () => {
  let init: ReturnType<typeof useSettingsStore.getState>
  beforeAll(() => {
    init = useSettingsStore.getState()
  })
  afterEach(() => useSettingsStore.setState(init, true))

  it('zooms in on Ctrl+scroll up and out on Ctrl+scroll down, Cmd on macOS', () => {
    expect(zoomStep({ ctrlKey: true, metaKey: false, deltaY: -40 }, false)).toBe(1)
    expect(zoomStep({ ctrlKey: true, metaKey: false, deltaY: 40 }, false)).toBe(-1)
    expect(zoomStep({ ctrlKey: false, metaKey: false, deltaY: -40 }, false)).toBe(0)
    expect(zoomStep({ ctrlKey: true, metaKey: false, deltaY: -40 }, true)).toBe(0)
    expect(zoomStep({ ctrlKey: false, metaKey: true, deltaY: -40 }, true)).toBe(1)
  })

  it('changes the surface font size within 8–32 and swallows the scroll', () => {
    useSettingsStore.getState().setBehavior({ wheelZoom: true })
    const host = document.createElement('div')
    const detach = attachWheelZoom(host, 'terminal', false)
    useSettingsStore.getState().setSurfaceFont('terminal', { size: 31 })
    const wheel = () =>
      new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, cancelable: true, bubbles: true })

    const first = wheel()
    host.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    host.dispatchEvent(wheel())
    expect(useSettingsStore.getState().appearance.terminal.size).toBe(32)

    const plain = new WheelEvent('wheel', { deltaY: -40, cancelable: true })
    host.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
    detach()
    host.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, ctrlKey: true }))
    expect(useSettingsStore.getState().appearance.terminal.size).toBe(32)
  })

  it('leaves Ctrl+scroll and Cmd+scroll to normal scrolling when wheel zoom is off', () => {
    useSettingsStore.getState().setBehavior({ wheelZoom: false })
    useSettingsStore.getState().setSurfaceFont('editor', { size: 13 })
    const host = document.createElement('div')
    const detach = attachWheelZoom(host, 'editor', true)
    const scroll = new WheelEvent('wheel', {
      deltaY: -40,
      metaKey: true,
      cancelable: true,
      bubbles: true,
    })
    host.dispatchEvent(scroll)
    expect(scroll.defaultPrevented).toBe(false)
    expect(useSettingsStore.getState().appearance.editor.size).toBe(13)
    detach()
  })

  describe('returning to the normal size', () => {
    const font = () => useSettingsStore.getState().appearance.terminal

    it('remembers the size the zoom started from and reports the scale against it', () => {
      useSettingsStore.getState().setSurfaceFont('terminal', { size: 10 })
      expect(fontZoomPercent(font())).toBeNull()

      zoomFont('terminal', 1)
      expect(font().size).toBe(11)
      expect(font().baseSize).toBe(10)
      expect(fontZoomPercent(font())).toBe(110)

      zoomFont('terminal', 1)
      expect(font().baseSize).toBe(10)
      expect(fontZoomPercent(font())).toBe(120)
    })

    it('forgets the remembered size once the zoom lands back on it', () => {
      useSettingsStore.getState().setSurfaceFont('terminal', { size: 10 })
      zoomFont('terminal', 1)
      zoomFont('terminal', -1)
      expect(font().size).toBe(10)
      expect('baseSize' in font()).toBe(false)
      expect(fontZoomPercent(font())).toBeNull()
    })

    it('treats a size picked in Settings as the new normal, not as zoom', () => {
      useSettingsStore.getState().setSurfaceFont('terminal', { size: 10 })
      zoomFont('terminal', 2)
      useSettingsStore.getState().setSurfaceFont('terminal', { size: 15 })
      expect(font().size).toBe(15)
      expect('baseSize' in font()).toBe(false)
      expect(activeFontZoom(useSettingsStore.getState().appearance)).toBeNull()
    })

    it('does not touch a custom size that was never zoomed', () => {
      useSettingsStore.getState().setSurfaceFont('terminal', { size: 17 })
      expect(activeFontZoom(useSettingsStore.getState().appearance)).toBeNull()
      resetFontZoom()
      expect(font().size).toBe(17)
    })

    it('does not remember anything when the zoom is already at the limit', () => {
      useSettingsStore.getState().setSurfaceFont('terminal', { size: 32 })
      zoomFont('terminal', 1)
      expect('baseSize' in font()).toBe(false)
    })

    it('resets the terminal and the editor together, each to its own starting size', () => {
      const store = useSettingsStore.getState()
      store.setSurfaceFont('terminal', { size: 12 })
      store.setSurfaceFont('editor', { size: 14 })
      zoomFont('terminal', 3)
      zoomFont('editor', -2)
      expect(activeFontZoom(useSettingsStore.getState().appearance)).toBe(125)

      resetFontZoom()
      const { terminal, editor } = useSettingsStore.getState().appearance
      expect([terminal.size, editor.size]).toEqual([12, 14])
      expect(activeFontZoom(useSettingsStore.getState().appearance)).toBeNull()
    })

    it('reports the editor scale when only the editor is zoomed', () => {
      useSettingsStore.getState().setSurfaceFont('editor', { size: 10 })
      zoomFont('editor', 2)
      expect(activeFontZoom(useSettingsStore.getState().appearance)).toBe(120)
    })

    it('resetZoom also puts the interface zoom back to 100%', () => {
      useSettingsStore.getState().setZoom(130)
      useSettingsStore.getState().setSurfaceFont('editor', { size: 10 })
      zoomFont('editor', 1)
      resetZoom()
      expect(useSettingsStore.getState().appearance.zoom).toBe(100)
      expect(useSettingsStore.getState().appearance.editor.size).toBe(10)
    })

    it('drops a saved baseSize that is out of range or equal to the size when settings load', () => {
      const parse = (terminal: object) => {
        const saved = { appearance: { terminal } }
        return parsePersisted(saved as never).appearance.terminal
      }
      expect(parse({ size: 12, baseSize: 10 }).baseSize).toBe(10)
      expect('baseSize' in parse({ size: 12, baseSize: 12 })).toBe(false)
      expect('baseSize' in parse({ size: 12, baseSize: 3 })).toBe(false)
      expect('baseSize' in parse({ size: 12, baseSize: 'big' })).toBe(false)
    })
  })
})
