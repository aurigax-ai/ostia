/// <reference lib="dom" />
import type { RawPick } from '../browser/pick'
import { tagOf } from './pickSelectors'
import { createTableReader } from './pickTable'

const HTML_LIMIT = 4096
const MEDIA_TAGS = new Set(['img', 'picture', 'canvas', 'video', 'audio', 'svg'])
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

export function createDescribe({
  win,
  selectorFor,
}: {
  win: Window & typeof globalThis
  selectorFor: (el: Element) => string
}) {
  const doc = win.document
  const { tableOf, rowsOf } = createTableReader(win)

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
    const tag = tagOf(el)
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
      hasText: !MEDIA_TAGS.has(tag) && (el.textContent ?? '').trim() !== '',
      table: tag === 'table' ? rowsOf(el as HTMLTableElement) : null,
    }
  }

  const resolve = (el: Element, single: boolean): Element => (single ? el : (tableOf(el) ?? el))

  return { roleOf, nameOf, labelFor, describe, resolve }
}
