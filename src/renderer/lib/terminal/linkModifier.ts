import type { IBufferRange } from '@xterm/xterm'
import type { FileLinkAction } from './terminalFileLinks'

export const LINK_MODIFIER_CLASS = 'link-modifier'

export function linkModifierHeld(e: { ctrlKey: boolean; metaKey: boolean }, mac: boolean): boolean {
  return mac ? e.metaKey : e.ctrlKey
}

export function attachLinkModifier(host: HTMLElement, mac: boolean): () => void {
  const sync = (e: KeyboardEvent | MouseEvent): void => {
    host.classList.toggle(LINK_MODIFIER_CLASS, linkModifierHeld(e, mac))
  }
  const clear = (): void => host.classList.remove(LINK_MODIFIER_CLASS)
  window.addEventListener('keydown', sync, true)
  window.addEventListener('keyup', sync, true)
  host.addEventListener('mousemove', sync)
  window.addEventListener('blur', clear)
  return () => {
    clear()
    window.removeEventListener('keydown', sync, true)
    window.removeEventListener('keyup', sync, true)
    host.removeEventListener('mousemove', sync)
    window.removeEventListener('blur', clear)
  }
}

export type WebLinkTarget = 'same-tab' | 'new-tab' | 'system'

export interface WebLinkClick {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  detail: number
}

export interface WebLinkClickContext {
  mac: boolean
  hasSelection: boolean
  mouseReporting: boolean
}

export function webLinkTarget(e: WebLinkClick, ctx: WebLinkClickContext): WebLinkTarget | null {
  if (linkModifierHeld(e, ctx.mac)) return e.shiftKey ? 'system' : 'new-tab'
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.detail > 1) return null
  if (ctx.hasSelection || ctx.mouseReporting) return null
  return 'same-tab'
}

export type LinkKind = 'web' | FileLinkAction

export interface LinkSpan {
  row: number
  start: number
  end: number
}

export function linkSpan(range: IBufferRange, viewportY: number, cols: number): LinkSpan {
  const end = range.end.y === range.start.y ? range.end.x : cols
  return { row: range.start.y - 1 - viewportY, start: range.start.x - 1, end }
}

export function attachLinkClaim(
  screen: HTMLElement,
  claims: (e: MouseEvent) => boolean,
): () => void {
  const claim = (e: MouseEvent): void => {
    if (e.button !== 0 || !claims(e)) return
    e.preventDefault()
    e.stopPropagation()
  }
  screen.addEventListener('mousedown', claim)
  return () => screen.removeEventListener('mousedown', claim)
}
