import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { attachWheelZoom, zoomStep } from './wheelZoom'

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
})
