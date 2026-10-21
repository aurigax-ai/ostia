/// <reference lib="dom" />
import type { PickTheme, RawPick } from '../browser/pick'

const BLOCKED_EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
]

interface PickSessionDeps {
  win: Window & typeof globalThis
  labelFor: (el: Element) => string
  describe: (el: Element) => RawPick
  resolveTarget: (el: Element, single: boolean) => Element
}

export function createPickSession({ win, labelFor, describe, resolveTarget }: PickSessionDeps) {
  const doc = win.document

  let session: { finish: (el: Element | null) => void } | null = null

  const nextFrame = (fn: () => void): void => {
    if (typeof win.requestAnimationFrame === 'function') {
      win.requestAnimationFrame(() => win.requestAnimationFrame(() => fn()))
    } else {
      win.setTimeout(fn, 32)
    }
  }

  const start = (theme: PickTheme): Promise<RawPick | null> => {
    if (session) session.finish(null)
    return new Promise((resolve) => {
      const host = doc.createElement('div')
      host.setAttribute('data-ostia-pick', '')
      host.style.cssText =
        'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;'
      const root = host.attachShadow({ mode: 'closed' })
      const box = doc.createElement('div')
      box.style.cssText = `position: fixed; display: none; box-sizing: border-box; border: 1px solid ${theme.accent}; background: color-mix(in srgb, ${theme.accent} 12%, transparent); border-radius: 2px; pointer-events: none;`
      const tag = doc.createElement('div')
      tag.style.cssText = `position: fixed; display: none; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 6px; border-radius: 4px; background: ${theme.surface}; color: ${theme.fg}; border: 1px solid ${theme.accent}; font: 500 11px/16px system-ui, sans-serif; pointer-events: none;`
      root.append(box, tag)
      const cursor = doc.createElement('style')
      cursor.textContent = '* { cursor: crosshair !important; }'
      ;(doc.documentElement || doc.body).append(host)
      ;(doc.head || doc.documentElement).append(cursor)

      let hovered: Element | null = null
      const isOurs = (t: EventTarget | null): boolean => t === host
      const show = (el: Element): void => {
        hovered = el
        const r = el.getBoundingClientRect()
        box.style.display = 'block'
        box.style.left = `${r.left}px`
        box.style.top = `${r.top}px`
        box.style.width = `${r.width}px`
        box.style.height = `${r.height}px`
        tag.textContent = labelFor(el)
        tag.style.display = 'block'
        tag.style.left = `${Math.max(0, r.left)}px`
        const above = r.top - 22
        tag.style.top = `${above >= 0 ? above : Math.min(win.innerHeight - 20, r.bottom + 4)}px`
      }
      const onMove = (e: Event): void => {
        if (!e.isTrusted || isOurs(e.target) || !(e.target instanceof win.Element)) return
        const el = resolveTarget(e.target, (e as MouseEvent).altKey === true)
        if (el !== hovered) show(el)
      }
      const onBlocked = (e: Event): void => {
        if (!e.isTrusted) return
        e.preventDefault()
        e.stopImmediatePropagation()
        if (e.type !== 'click') return
        const target = e.target instanceof win.Element ? e.target : hovered
        if (target && !isOurs(target))
          finish(resolveTarget(target, (e as MouseEvent).altKey === true))
      }
      const onKey = (e: KeyboardEvent): void => {
        if (!e.isTrusted || e.key !== 'Escape') return
        e.preventDefault()
        e.stopImmediatePropagation()
        finish(null)
      }
      const cleanup = (): void => {
        win.removeEventListener('mousemove', onMove, true)
        win.removeEventListener('mouseover', onMove, true)
        for (const type of BLOCKED_EVENTS) win.removeEventListener(type, onBlocked, true)
        win.removeEventListener('keydown', onKey, true)
        host.remove()
        cursor.remove()
      }
      const finish = (el: Element | null): void => {
        if (!session || session.finish !== finish) return
        session = null
        const result = el ? describe(el) : null
        cleanup()
        if (result) nextFrame(() => resolve(result))
        else resolve(null)
      }
      session = { finish }
      win.addEventListener('mousemove', onMove, true)
      win.addEventListener('mouseover', onMove, true)
      for (const type of BLOCKED_EVENTS) win.addEventListener(type, onBlocked, true)
      win.addEventListener('keydown', onKey, true)
    })
  }

  const cancel = () => session?.finish(null)
  const active = () => session !== null

  return { start, cancel, active }
}
