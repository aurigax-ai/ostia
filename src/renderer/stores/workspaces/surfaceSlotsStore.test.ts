import { afterEach, describe, expect, it } from 'vitest'
import {
  focusSurface,
  focusSurfaceWhenReady,
  mountSurface,
  parkSurface,
  releaseSurfaces,
  surfaceHost,
} from './surfaceSlotsStore'

const div = () => document.createElement('div')

describe('surfaceSlotsStore', () => {
  afterEach(() => releaseSurfaces(new Set()))

  it('focusSurface focuses the input of a Ghostty terminal', () => {
    const slot = div()
    document.body.appendChild(slot)
    mountSurface('pane-1', slot)
    const ghostty = div()
    ghostty.className = 'ghostty-host'
    const input = document.createElement('textarea')
    ghostty.appendChild(input)
    surfaceHost('pane-1').appendChild(ghostty)
    focusSurface('pane-1')
    expect(document.activeElement).toBe(input)
    slot.remove()
  })

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

  it('focusSurface focuses the chat composer and the changed side of a diff', () => {
    const slot = div()
    document.body.appendChild(slot)
    mountSurface('chat', slot)
    const composer = document.createElement('textarea')
    composer.name = 'message'
    surfaceHost('chat').appendChild(composer)
    focusSurface('chat')
    expect(document.activeElement).toBe(composer)

    mountSurface('diff', slot)
    const side = (name: string): HTMLElement => {
      const editor = div()
      editor.className = `editor ${name}`
      const input = div()
      input.className = 'native-edit-context'
      input.tabIndex = 0
      editor.appendChild(input)
      surfaceHost('diff').appendChild(editor)
      return input
    }
    side('original')
    const modified = side('modified')
    focusSurface('diff')
    expect(document.activeElement).toBe(modified)
    slot.remove()
  })

  describe('focusSurfaceWhenReady', () => {
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve))

    function terminalInput(paneId: string): HTMLTextAreaElement {
      const input = document.createElement('textarea')
      input.className = 'xterm-helper-textarea'
      surfaceHost(paneId).appendChild(input)
      return input
    }

    it('waits until the surface sits in a shown slot, then focuses it once', async () => {
      const input = terminalInput('pane-1')
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
      layer.remove()
    })

    it('waits while a dialog holds the keyboard', async () => {
      const slot = div()
      document.body.appendChild(slot)
      mountSurface('pane-1', slot)
      const input = terminalInput('pane-1')
      const dialog = div()
      dialog.setAttribute('role', 'dialog')
      const field = document.createElement('input')
      dialog.appendChild(field)
      document.body.appendChild(dialog)
      field.focus()

      focusSurfaceWhenReady('pane-1', () => true)
      await settle()
      expect(document.activeElement).toBe(field)

      dialog.remove()
      await settle()
      expect(document.activeElement).toBe(input)
      slot.remove()
    })

    it('gives up on a pointer press, a newer request or once the pane is no longer wanted', async () => {
      const slot = div()
      document.body.appendChild(slot)
      mountSurface('pane-1', slot)
      mountSurface('pane-2', slot)
      let wanted = true

      focusSurfaceWhenReady('pane-1', () => true)
      window.dispatchEvent(new Event('pointerdown'))
      const pressed = terminalInput('pane-1')
      await settle()
      expect(document.activeElement).not.toBe(pressed)
      pressed.remove()

      focusSurfaceWhenReady('pane-1', () => true)
      const newer = terminalInput('pane-2')
      focusSurfaceWhenReady('pane-2', () => true)
      expect(document.activeElement).toBe(newer)
      const older = terminalInput('pane-1')
      await settle()
      expect(document.activeElement).toBe(newer)
      older.remove()
      newer.remove()
      newer.blur()

      focusSurfaceWhenReady('pane-2', () => wanted)
      wanted = false
      const unwanted = terminalInput('pane-2')
      await settle()
      expect(document.activeElement).not.toBe(unwanted)
      slot.remove()
    })
  })
})
