/// <reference lib="dom" />
import type { BrowseOutcome } from '../browser/browseRuntime'
import type { PageLayout } from './pageLayout'
import type { PageTargets } from './pageTargets'
import { collapse, describeElement, fail } from './pageText'

type ActionDeps = Pick<PageTargets, 'resolve' | 'frameDoc'> &
  Pick<PageLayout, 'frameOffset'> & { win: Window & typeof globalThis }

export function createActions({ win, resolve, frameDoc, frameOffset }: ActionDeps) {
  const point = (target: string): BrowseOutcome<{ x: number; y: number }> => {
    const el = resolve(target)
    if (!el) return fail('not-found', target)
    let rect = el.getBoundingClientRect()
    const view = el.ownerDocument.defaultView ?? win
    const outside =
      rect.bottom < 0 ||
      rect.right < 0 ||
      rect.top > view.innerHeight ||
      rect.left > view.innerWidth
    if (outside) {
      el.scrollIntoView({ block: 'center', inline: 'center' })
      rect = el.getBoundingClientRect()
    }
    if (rect.width === 0 || rect.height === 0) return fail('not-visible', target)
    const localX = rect.left + rect.width / 2
    const localY = rect.top + rect.height / 2
    const hit = el.ownerDocument.elementFromPoint(localX, localY)
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      return fail('covered', `covered by ${describeElement(hit)}`)
    }
    const offset = frameOffset(el)
    return { ok: true, x: Math.round(localX + offset.x), y: Math.round(localY + offset.y) }
  }

  const withElement = <T extends object>(
    target: string,
    run: (el: Element) => BrowseOutcome<T>,
  ): BrowseOutcome<T> => {
    const el = resolve(target)
    return el ? run(el) : fail('not-found', target)
  }

  const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    const proto = Object.getPrototypeOf(el) as object
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
  }

  const fire = (el: Element, type: string): void => {
    el.dispatchEvent(new Event(type, { bubbles: true }))
  }

  const fill = (target: string, text: string): BrowseOutcome =>
    withElement(target, (el) => {
      const tag = el.tagName.toLowerCase()
      ;(el as HTMLElement).focus?.()
      if (tag === 'input' || tag === 'textarea') {
        setNativeValue(el as HTMLInputElement, text)
      } else if ((el as HTMLElement).isContentEditable) {
        el.textContent = text
      } else {
        return fail('not-editable', describeElement(el))
      }
      fire(el, 'input')
      fire(el, 'change')
      return { ok: true }
    })

  const select = (target: string, values: string[]): BrowseOutcome<{ values: string[] }> =>
    withElement(target, (el) => {
      if (el.tagName.toLowerCase() !== 'select') return fail('not-a-select', describeElement(el))
      const selectEl = el as HTMLSelectElement
      const options = Array.from(selectEl.options)
      const picked: HTMLOptionElement[] = []
      for (const wanted of values) {
        const norm = wanted.replace(/ /g, ' ')
        const match =
          options.find((o) => o.value === wanted) ??
          options.find((o) => collapse(o.textContent).replace(/ /g, ' ') === norm)
        if (!match) return fail('no-option', wanted)
        picked.push(match)
      }
      for (const option of options) option.selected = picked.includes(option)
      fire(el, 'input')
      fire(el, 'change')
      return { ok: true, values: picked.map((o) => o.value) }
    })

  const scrollIntoView = (target: string): BrowseOutcome =>
    withElement(target, (el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' })
      return { ok: true }
    })

  const scroll = (target: string | null, dx: number, dy: number): BrowseOutcome => {
    if (!target) {
      frameDoc().defaultView?.scrollBy(dx, dy)
      return { ok: true }
    }
    return withElement(target, (el) => {
      el.scrollBy(dx, dy)
      return { ok: true }
    })
  }

  const highlight = (target: string, ms: number): BrowseOutcome =>
    withElement(target, (el) => {
      const style = (el as HTMLElement).style
      if (!style) return fail('not-styleable', describeElement(el))
      const prev = { outline: style.outline, offset: style.outlineOffset }
      style.outline = '2px solid #ff3366'
      style.outlineOffset = '2px'
      win.setTimeout(() => {
        style.outline = prev.outline
        style.outlineOffset = prev.offset
      }, ms)
      return { ok: true }
    })

  const mark = (target: string, nonce: string): BrowseOutcome =>
    withElement(target, (el) => {
      el.setAttribute('data-ostia-mark', nonce)
      return { ok: true }
    })

  const href = (target: string): BrowseOutcome<{ url: string }> =>
    withElement(target, (el) => {
      const link = el.closest('a[href]') as HTMLAnchorElement | null
      return link ? { ok: true, url: link.href } : fail('no-link', describeElement(el))
    })

  return { point, withElement, fill, select, scrollIntoView, scroll, highlight, mark, href }
}

export type PageActions = ReturnType<typeof createActions>
