/// <reference lib="dom" />
import type { PickTheme, RawPick } from './pick'

export interface PickRuntime {
  selectorFor: (el: Element) => string
  labelFor: (el: Element) => string
  roleOf: (el: Element) => string
  nameOf: (el: Element) => string
  describe: (el: Element) => RawPick
  start: (theme: PickTheme) => Promise<RawPick | null>
  cancel: () => void
  active: () => boolean
}

export function pickRuntime(win: Window & typeof globalThis): PickRuntime {
  const doc = win.document
  const HTML_LIMIT = 4096
  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa']
  const STYLE_PROPS = [
    'display',
    'position',
    'box-sizing',
    'width',
    'height',
    'margin',
    'padding',
    'border',
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'opacity',
    'visibility',
    'overflow',
    'z-index',
  ]
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

  const escapeIdent = (s: string): string =>
    win.CSS?.escape ? win.CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)
  const quote = (s: string): string => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`
  const tagOf = (el: Element): string => el.tagName.toLowerCase()

  const matchesOnly = (sel: string, el: Element): boolean => {
    try {
      const found = doc.querySelectorAll(sel)
      return found.length === 1 && found[0] === el
    } catch {
      return false
    }
  }

  const anchorFor = (el: Element): string | null => {
    const tag = tagOf(el)
    if (el.id) {
      const byId = `#${escapeIdent(el.id)}`
      if (matchesOnly(byId, el)) return byId
    }
    for (const attr of TEST_ATTRS) {
      const value = el.getAttribute(attr)
      if (!value) continue
      const byAttr = `[${attr}=${quote(value)}]`
      if (matchesOnly(byAttr, el)) return byAttr
      if (matchesOnly(`${tag}${byAttr}`, el)) return `${tag}${byAttr}`
    }
    const aria = el.getAttribute('aria-label')
    if (aria) {
      const byAria = `${tag}[aria-label=${quote(aria)}]`
      if (matchesOnly(byAria, el)) return byAria
    }
    const name = el.getAttribute('name')
    if (name && /^(input|select|textarea|button|form)$/.test(tag)) {
      const byName = `${tag}[name=${quote(name)}]`
      if (matchesOnly(byName, el)) return byName
    }
    return null
  }

  const stepFor = (el: Element): string => {
    const tag = tagOf(el)
    const parent = el.parentElement
    if (!parent) return tag
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName)
    return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag
  }

  const selectorFor = (el: Element): string => {
    const direct = anchorFor(el)
    if (direct) return direct
    const steps: string[] = []
    let cur: Element | null = el
    while (cur && cur !== doc.documentElement) {
      const anchor: string | null = cur === el ? null : anchorFor(cur)
      if (anchor) {
        steps.unshift(anchor)
        const anchored = steps.join(' > ')
        if (matchesOnly(anchored, el)) return anchored
        break
      }
      steps.unshift(stepFor(cur))
      const joined = steps.join(' > ')
      if (steps.length > 1 && matchesOnly(joined, el)) return joined
      cur = cur.parentElement
    }
    const full: string[] = []
    let node: Element | null = el
    while (node && node !== doc.documentElement) {
      full.unshift(stepFor(node))
      node = node.parentElement
    }
    return ['html', ...full].join(' > ')
  }

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = tagOf(el)
    if (tag === 'a' && el.hasAttribute('href')) return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
      if (type === 'checkbox' || type === 'radio') return type
      return 'textbox'
    }
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return 'img'
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (tag === 'li') return 'listitem'
    return 'generic'
  }

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label')
    if (aria?.trim()) return aria.trim()
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
      if (text) return text
    }
    if (tagOf(el) === 'img') return (el.getAttribute('alt') || '').trim()
    const labels = (el as HTMLInputElement).labels
    if (labels && labels.length > 0) {
      const text = (labels[0].textContent || '').trim()
      if (text) return text
    }
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) return text.slice(0, 120)
    return (el.getAttribute('placeholder') || el.getAttribute('title') || '').trim()
  }

  const labelFor = (el: Element): string => {
    let label = tagOf(el)
    if (el.id) label += `#${el.id}`
    const classes = Array.from(el.classList).slice(0, 2)
    for (const c of classes) label += `.${c}`
    const r = el.getBoundingClientRect()
    return `${label}  ${Math.round(r.width)}×${Math.round(r.height)}`
  }

  const describe = (el: Element): RawPick => {
    const r = el.getBoundingClientRect()
    const computed = win.getComputedStyle(el)
    const styles: Record<string, string> = {}
    for (const prop of STYLE_PROPS) styles[prop] = computed.getPropertyValue(prop)
    const html = el.outerHTML
    return {
      url: win.location.href,
      title: doc.title,
      selector: selectorFor(el),
      label: labelFor(el),
      html: html.length > HTML_LIMIT ? html.slice(0, HTML_LIMIT) : html,
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
      viewport: { width: win.innerWidth, height: win.innerHeight },
      styles,
      role: roleOf(el),
      name: nameOf(el),
    }
  }

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
      host.setAttribute('data-pine-pick', '')
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
        if (!e.isTrusted || isOurs(e.target)) return
        if (e.target instanceof win.Element && e.target !== hovered) show(e.target)
      }
      const onBlocked = (e: Event): void => {
        if (!e.isTrusted) return
        e.preventDefault()
        e.stopImmediatePropagation()
        if (e.type !== 'click') return
        const target = e.target instanceof win.Element ? e.target : hovered
        if (target && !isOurs(target)) finish(target)
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

  return {
    selectorFor,
    labelFor,
    roleOf,
    nameOf,
    describe,
    start,
    cancel: () => session?.finish(null),
    active: () => session !== null,
  }
}

export const PICK_RUNTIME_GLOBAL = '__pinePick'

export function pickRuntimeScript(): string {
  return `window.${PICK_RUNTIME_GLOBAL} = window.${PICK_RUNTIME_GLOBAL} || (${pickRuntime.toString()})(window);`
}
