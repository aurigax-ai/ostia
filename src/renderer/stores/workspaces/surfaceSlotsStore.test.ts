import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  focusSurface,
  focusSurfaceWhenReady,
  mountSurface,
  parkSurface,
  releaseSurfaces,
  setFocusTarget,
  surfaceHost,
} from './surfaceSlotsStore'

const div = () => document.createElement('div')

describe('surfaceSlotsStore', () => {
  afterEach(() => releaseSurfaces(new Set()))

  it('returns the same host element for a pane on every call', () => {
    expect(surfaceHost('pane-1')).toBe(surfaceHost('pane-1'))
    expect(surfaceHost('pane-1')).not.toBe(surfaceHost('pane-2'))
  })

  it('mountSurface re-parents the same host into each new slot', () => {
    const host = surfaceHost('pane-1')
    const a = div()
    const b = div()
    mountSurface('pane-1', a)
    expect(host.parentNode).toBe(a)
    mountSurface('pane-1', b)
    expect(host.parentNode).toBe(b)
    expect(a.childNodes).toHaveLength(0)
  })

  it('parkSurface moves the host out of its slot into a detached holder', () => {
    const slot = div()
    mountSurface('pane-1', slot)
    parkSurface('pane-1', slot)
    const host = surfaceHost('pane-1')
    expect(host.parentNode).not.toBe(slot)
    expect(host.parentNode).not.toBeNull()
    expect(host.isConnected).toBe(false)
  })

  it('parkSurface from a stale slot does not steal the host from its newer slot', () => {
    const old = div()
    const next = div()
    mountSurface('pane-1', old)
    mountSurface('pane-1', next)
    parkSurface('pane-1', old)
    expect(surfaceHost('pane-1').parentNode).toBe(next)
  })

  it('fades a new host in once, so later moves between slots do not replay it', () => {
    const host = surfaceHost('pane-1')
    expect(host).toHaveClass('surface-enter')
    const child = div()
    host.appendChild(child)
    child.dispatchEvent(new Event('animationend', { bubbles: true }))
    expect(host).toHaveClass('surface-enter')
    host.dispatchEvent(new Event('animationend'))
    expect(host).not.toHaveClass('surface-enter')
    mountSurface('pane-1', div())
    expect(host).not.toHaveClass('surface-enter')
  })

  it('releaseSurfaces removes hosts of dead panes and keeps live ones', () => {
    const slot = div()
    const live = surfaceHost('pane-live')
    const dead = surfaceHost('pane-dead')
    mountSurface('pane-dead', slot)
    releaseSurfaces(new Set(['pane-live']))
    expect(slot.childNodes).toHaveLength(0)
    expect(surfaceHost('pane-live')).toBe(live)
    expect(surfaceHost('pane-dead')).not.toBe(dead)
  })

  it('focusSurface focuses the target the surface registered, and nothing once it left', () => {
    const slot = div()
    document.body.appendChild(slot)
    mountSurface('pane-1', slot)
    const input = document.createElement('textarea')
    surfaceHost('pane-1').appendChild(input)
    const other = document.createElement('textarea')
    surfaceHost('pane-1').appendChild(other)
    const unregister = setFocusTarget('pane-1', () => other)
    focusSurface('pane-1')
    expect(document.activeElement).toBe(other)
    other.blur()
    unregister()
    focusSurface('pane-1')
    expect(document.activeElement).not.toBe(other)
    expect(document.activeElement).not.toBe(input)
    slot.remove()
  })

  describe('focusSurfaceWhenReady', () => {
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve))
    const unregisters: (() => void)[] = []

    afterEach(() => {
      for (const unregister of unregisters.splice(0)) unregister()
      document.body.innerHTML = ''
    })

    function registeredInput(paneId: string): HTMLTextAreaElement {
      const input = document.createElement('textarea')
      surfaceHost(paneId).appendChild(input)
      unregisters.push(setFocusTarget(paneId, () => input))
      return input
    }

    function shownSlot(...paneIds: string[]): HTMLElement {
      const slot = div()
      document.body.appendChild(slot)
      for (const paneId of paneIds) mountSurface(paneId, slot)
      return slot
    }

    it('waits until the surface sits in a shown slot, then focuses it once', async () => {
      const input = registeredInput('pane-1')
      const layer = div()
      layer.setAttribute('data-hidden', '')
      const slot = div()
      layer.appendChild(slot)
      document.body.appendChild(layer)

      focusSurfaceWhenReady('pane-1', () => true)
      await settle()
      expect(document.activeElement).not.toBe(input)

      mountSurface('pane-1', slot)
      await settle()
      expect(document.activeElement).not.toBe(input)

      layer.removeAttribute('data-hidden')
      await settle()
      expect(document.activeElement).toBe(input)

      input.blur()
      layer.setAttribute('data-hidden', '')
      layer.removeAttribute('data-hidden')
      await settle()
      expect(document.activeElement).not.toBe(input)
    })

    it('waits for a surface that has not registered yet', async () => {
      shownSlot('pane-1')
      focusSurfaceWhenReady('pane-1', () => true)
      await settle()
      const input = registeredInput('pane-1')
      await settle()
      expect(document.activeElement).toBe(input)
    })

    it('ends at once for a surface that takes no keyboard', async () => {
      shownSlot('pane-1')
      unregisters.push(setFocusTarget('pane-1', null))
      focusSurfaceWhenReady('pane-1', () => true)

      const late = registeredInput('pane-1')
      surfaceHost('pane-1').appendChild(div())
      await settle()

      expect(document.activeElement).not.toBe(late)
    })

    it('waits while a dialog holds the keyboard, through focus moving inside it', async () => {
      shownSlot('pane-1')
      const input = registeredInput('pane-1')
      const dialog = div()
      dialog.setAttribute('role', 'dialog')
      const field = document.createElement('input')
      const button = document.createElement('button')
      dialog.append(field, button)
      document.body.appendChild(dialog)
      field.focus()

      focusSurfaceWhenReady('pane-1', () => true)
      button.focus()
      await settle()
      expect(document.activeElement).toBe(button)

      dialog.remove()
      await settle()
      expect(document.activeElement).toBe(input)
    })

    it('gives up when the keyboard moves elsewhere before the surface is ready', async () => {
      const slot = shownSlot('pane-1')
      slot.setAttribute('data-hidden', '')
      const input = registeredInput('pane-1')
      const elsewhere = document.createElement('input')
      document.body.appendChild(elsewhere)

      focusSurfaceWhenReady('pane-1', () => true)
      elsewhere.focus()
      slot.removeAttribute('data-hidden')
      await settle()

      expect(document.activeElement).toBe(elsewhere)
      expect(document.activeElement).not.toBe(input)
    })

    it('gives up on a key the human presses, never on one a script sends', async () => {
      const keyListeners: EventListener[] = []
      const addListener = window.addEventListener.bind(window)
      const spy = vi
        .spyOn(window, 'addEventListener')
        .mockImplementation((type, listener, options) => {
          if (type === 'keydown' && typeof listener === 'function') keyListeners.push(listener)
          addListener(type, listener, options)
        })
      const slot = shownSlot('pane-1')
      slot.setAttribute('data-hidden', '')
      const input = registeredInput('pane-1')

      focusSurfaceWhenReady('pane-1', () => true)
      const press = (isTrusted: boolean) => {
        keyListeners.at(-1)?.({ type: 'keydown', isTrusted } as unknown as Event)
      }
      press(false)
      slot.removeAttribute('data-hidden')
      await settle()
      expect(document.activeElement).toBe(input)

      input.blur()
      slot.setAttribute('data-hidden', '')
      focusSurfaceWhenReady('pane-1', () => true)
      press(true)
      slot.removeAttribute('data-hidden')
      await settle()
      spy.mockRestore()
      expect(document.activeElement).not.toBe(input)
    })

    it('gives up on a pointer press, a newer request or once the pane is no longer wanted', async () => {
      shownSlot('pane-1', 'pane-2')
      let wanted = true

      focusSurfaceWhenReady('pane-1', () => true)
      window.dispatchEvent(new Event('pointerdown'))
      const pressed = registeredInput('pane-1')
      await settle()
      expect(document.activeElement).not.toBe(pressed)
      for (const unregister of unregisters.splice(0)) unregister()

      focusSurfaceWhenReady('pane-1', () => true)
      const newer = registeredInput('pane-2')
      focusSurfaceWhenReady('pane-2', () => true)
      expect(document.activeElement).toBe(newer)
      const older = registeredInput('pane-1')
      await settle()
      expect(document.activeElement).toBe(newer)
      expect(document.activeElement).not.toBe(older)
      for (const unregister of unregisters.splice(0)) unregister()
      newer.blur()

      focusSurfaceWhenReady('pane-2', () => wanted)
      wanted = false
      const unwanted = registeredInput('pane-2')
      await settle()
      expect(document.activeElement).not.toBe(unwanted)
    })
  })
})
