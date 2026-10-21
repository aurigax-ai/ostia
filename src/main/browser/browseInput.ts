import { setTimeout as sleep } from 'node:timers/promises'
import type { KeyCombo } from '../../shared/browser/browseInput'
import type { BrowseOutcome } from '../../shared/browser/browseRuntime'
import type { BrowseState } from './browseGuests'
import { fail, world } from './browseMethod'
import { jsArgs } from './browseWorld'
import { injectInto } from './guestInject'

const INPUT_SETTLE_MS = 30

export type MouseButton = 'left' | 'right' | 'middle'

const TYPEABLE_KEY = /^[\x21-\x7e]$/

export function createBrowseInput({ mousePositions }: Pick<BrowseState, 'mousePositions'>) {
  async function settle(guest: Electron.WebContents): Promise<void> {
    await sleep(INPUT_SETTLE_MS)
    try {
      await guest.executeJavaScript('0', false)
    } catch {}
  }

  function zoomed(guest: Electron.WebContents, x: number, y: number): { x: number; y: number } {
    const zoom = guest.getZoomFactor()
    return { x: Math.round(x * zoom), y: Math.round(y * zoom) }
  }

  function mouseMove(guest: Electron.WebContents, x: number, y: number): void {
    const at = zoomed(guest, x, y)
    guest.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
    mousePositions.set(guest.id, { x, y })
  }

  function mouseButton(
    guest: Electron.WebContents,
    type: 'mouseDown' | 'mouseUp',
    button: MouseButton,
    clickCount: number,
  ): void {
    const pos = mousePositions.get(guest.id) ?? { x: 0, y: 0 }
    const at = zoomed(guest, pos.x, pos.y)
    guest.sendInputEvent({ type, x: at.x, y: at.y, button, clickCount })
  }

  async function clickPoint(
    guest: Electron.WebContents,
    x: number,
    y: number,
    clicks: number,
  ): Promise<void> {
    mouseMove(guest, x, y)
    for (let n = 1; n <= clicks; n++) {
      mouseButton(guest, 'mouseDown', 'left', n)
      mouseButton(guest, 'mouseUp', 'left', n)
    }
    await settle(guest)
  }

  function sendCombo(guest: Electron.WebContents, combo: KeyCombo, phase: 'down' | 'up' | 'press') {
    injectInto(guest.id, () => {
      if (phase !== 'up') {
        guest.sendInputEvent({
          type: 'keyDown',
          keyCode: combo.keyCode,
          modifiers: combo.modifiers,
        })
        if (combo.printable) {
          guest.sendInputEvent({ type: 'char', keyCode: combo.keyCode, modifiers: combo.modifiers })
        }
      }
      if (phase !== 'down') {
        guest.sendInputEvent({ type: 'keyUp', keyCode: combo.keyCode, modifiers: combo.modifiers })
      }
    })
  }

  function typeText(guest: Electron.WebContents, text: string): void {
    for (const ch of text) {
      if (ch === '\n') {
        sendCombo(guest, { keyCode: 'Return', modifiers: [], printable: false }, 'press')
        continue
      }
      const keyCode = ch === ' ' ? 'Space' : ch
      const hasKey = ch === ' ' || TYPEABLE_KEY.test(ch)
      injectInto(guest.id, () => {
        if (hasKey) guest.sendInputEvent({ type: 'keyDown', keyCode })
        guest.sendInputEvent({ type: 'char', keyCode: ch })
        if (hasKey) guest.sendInputEvent({ type: 'keyUp', keyCode })
      })
    }
  }

  async function clickTarget(
    guest: Electron.WebContents,
    target: string,
    clicks: number,
  ): Promise<BrowseOutcome> {
    const at = await world<{ x: number; y: number }>(guest, `point(${jsArgs(target)})`)
    if (!at.ok) return at
    await clickPoint(guest, at.x, at.y, clicks)
    return { ok: true }
  }

  async function setChecked(
    guest: Electron.WebContents,
    target: string,
    wanted: boolean,
  ): Promise<BrowseOutcome> {
    const state = await world<{ value: boolean }>(guest, `checked(${jsArgs(target)})`)
    if (!state.ok) return state
    if (state.value === wanted) return { ok: true }
    const clicked = await clickTarget(guest, target, 1)
    if (!clicked.ok) return clicked
    const after = await world<{ value: boolean }>(guest, `checked(${jsArgs(target)})`)
    if (!after.ok) return after
    return after.value === wanted ? { ok: true } : fail('state-unchanged', target)
  }

  return { settle, zoomed, mouseMove, mouseButton, sendCombo, typeText, clickTarget, setChecked }
}

export type BrowseInput = ReturnType<typeof createBrowseInput>
