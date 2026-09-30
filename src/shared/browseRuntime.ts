/// <reference lib="dom" />
import type { SnapshotNode } from './browseSnapshot'

export type BrowseFail = { ok: false; error: string; message?: string }
export type BrowseOutcome<T extends object = object> = ({ ok: true } & T) | BrowseFail

export type StorageArea = 'local' | 'session'

export interface WebStorageDump {
  origin: string
  local: Record<string, string>
  session: Record<string, string>
}

export interface FindQuery {
  by: string
  value: string
  name?: string
  exact?: boolean
  index?: number
}

export type ElementState = 'visible' | 'hidden' | 'attached' | 'detached'

export interface BrowseRuntime {
  resolve: (target: string) => Element | null
  ref: (el: Element) => string
  snapshot: (scope: string | null) => BrowseOutcome<{ tree: SnapshotNode[] }>
  point: (target: string) => BrowseOutcome<{ x: number; y: number }>
  focus: (target: string) => BrowseOutcome
  fill: (target: string, text: string) => BrowseOutcome
  select: (target: string, values: string[]) => BrowseOutcome<{ values: string[] }>
  checked: (target: string) => BrowseOutcome<{ value: boolean }>
  scrollIntoView: (target: string) => BrowseOutcome
  scroll: (target: string | null, dx: number, dy: number) => BrowseOutcome
  highlight: (target: string, ms: number) => BrowseOutcome
  get: (sub: string, target: string | null, arg: string | null) => BrowseOutcome<{ value: unknown }>
  is: (sub: string, target: string) => BrowseOutcome<{ value: boolean }>
  find: (query: FindQuery) => BrowseOutcome<{ ref: string }>
  hasState: (target: string, state: ElementState) => boolean
  hasText: (text: string) => boolean
  frame: (target: string | null) => BrowseOutcome
  mark: (target: string, nonce: string) => BrowseOutcome
  unmark: (nonce: string) => void
  href: (target: string) => BrowseOutcome<{ url: string }>
  readText: () => string
  readyState: () => DocumentReadyState
  storage: () => WebStorageDump
  setStorage: (area: StorageArea, key: string, value: string) => BrowseOutcome
  removeStorage: (area: StorageArea, key: string) => BrowseOutcome
  clearStorage: (area: StorageArea) => BrowseOutcome
}

export function browseRuntime(win: Window & typeof globalThis): BrowseRuntime {
  const topDoc = win.document
  const MAX_NODES = 3000
  const MAX_NAME = 200
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link'])
  const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'option',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
  ])
  const NAME_FROM_CONTENT = new Set([
    'button',
    'link',
    'heading',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'checkbox',
    'radio',
    'switch',
    'treeitem',
    'cell',
    'columnheader',
    'rowheader',
    'tooltip',
    'generic',
  ])
  const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'])
  const STYLE_KEYS = [
    'display',
    'position',
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'width',
    'height',
    'margin',
    'padding',
    'opacity',
    'visibility',
  ]
  const refs = new Map<string, Element>()
  const ids = new WeakMap<Element, string>()
  let counter = 0
  let frameTarget: string | null = null

  const fail = (error: string, message?: string): BrowseFail =>
    message ? { ok: false, error, message } : { ok: false, error }

  const collapse = (text: string | null | undefined): string =>
    (text ?? '').replace(/\s+/g, ' ').trim()

  const clipName = (text: string): string =>
    text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text

  const ref = (el: Element): string => {
    const known = ids.get(el)
    if (known && refs.get(known) === el) return known
    counter += 1
    const id = `e${counter}`
    ids.set(el, id)
    refs.set(id, el)
    return id
  }

  const frameDoc = (): Document => {
    if (!frameTarget) return topDoc
    const frameEl = lookup(topDoc, frameTarget)
    try {
      const doc = (frameEl as HTMLIFrameElement | null)?.contentDocument
      return doc ?? topDoc
    } catch {
      return topDoc
    }
  }

  const byText = (doc: Document, text: string): Element | null => {
    const wanted = text.toLowerCase()
    let best: Element | null = null
    let bestSize = Number.POSITIVE_INFINITY
    for (const el of Array.from(doc.body?.querySelectorAll('*') ?? [])) {
      if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue
      const own = collapse((el as HTMLElement).innerText ?? el.textContent).toLowerCase()
      if (!own.includes(wanted)) continue
      const size = el.querySelectorAll('*').length
      if (size < bestSize) {
        best = el
        bestSize = size
      }
    }
    return best
  }

  function lookup(doc: Document, target: string): Element | null {
    const refMatch = /^@?(e\d+)$/.exec(target)
    if (refMatch) {
      const el = refs.get(refMatch[1])
      return el?.isConnected ? el : null
    }
    if (target.startsWith('text=')) return byText(doc, target.slice(5))
    if (target.startsWith('xpath=')) {
      try {
        const result = doc.evaluate(target.slice(6), doc, null, 9, null)
        const node = result.singleNodeValue
        return node && node.nodeType === 1 ? (node as Element) : null
      } catch {
        return null
      }
    }
    try {
      return doc.querySelector(target)
    } catch {
      return null
    }
  }

  const resolve = (target: string): Element | null => lookup(frameDoc(), target)

  const hasLayoutApi = (el: Element): boolean =>
    typeof (el as Element & { checkVisibility?: unknown }).checkVisibility === 'function'

  const hasBox = (el: Element): boolean => !hasLayoutApi(el) || el.getClientRects().length > 0

  const isRendered = (el: Element): boolean => {
    if (!el.isConnected) return false
    if (hasLayoutApi(el)) {
      return (el as Element & { checkVisibility: (o?: object) => boolean }).checkVisibility({
        visibilityProperty: true,
      })
    }
    const view = el.ownerDocument.defaultView ?? win
    let node: Element | null = el
    while (node) {
      if (node.hasAttribute('hidden')) return false
      const style = view.getComputedStyle(node)
      if (style.display === 'none') return false
      if (node === el && style.visibility === 'hidden') return false
      node = node.parentElement
    }
    return true
  }

  const isVisible = (el: Element): boolean => isRendered(el) && hasBox(el)

  const textOf = (el: Element): string =>
    collapse((el as HTMLElement).innerText ?? el.textContent ?? '')

  const labelText = (el: Element): string => {
    const doc = el.ownerDocument
    const id = el.getAttribute('id')
    if (id) {
      for (const label of Array.from(doc.querySelectorAll('label'))) {
        if (label.getAttribute('for') === id) return textOf(label)
      }
    }
    const wrapping = el.closest('label')
    return wrapping ? textOf(wrapping) : ''
  }

  const hasNamedAncestor = (el: Element, tags: string[]): boolean => {
    let node = el.parentElement
    while (node) {
      if (tags.includes(node.tagName.toLowerCase())) return true
      node = node.parentElement
    }
    return false
  }

  const roleOf = (el: Element): string => {
    const explicit = collapse(el.getAttribute('role')).split(' ')[0]
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    switch (tag) {
      case 'a':
      case 'area':
        return el.hasAttribute('href') ? 'link' : ''
      case 'button':
      case 'summary':
        return 'button'
      case 'input': {
        const type = (el.getAttribute('type') || 'text').toLowerCase()
        if (type === 'hidden') return ''
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        if (type === 'range') return 'slider'
        if (type === 'number') return 'spinbutton'
        if (type === 'search') return 'searchbox'
        return 'textbox'
      }
      case 'textarea':
        return 'textbox'
      case 'select': {
        const select = el as HTMLSelectElement
        return select.multiple || select.size > 1 ? 'listbox' : 'combobox'
      }
      case 'option':
        return 'option'
      case 'img':
        return el.getAttribute('alt') === '' ? '' : 'img'
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading'
      case 'ul':
      case 'ol':
        return 'list'
      case 'li':
        return 'listitem'
      case 'nav':
        return 'navigation'
      case 'main':
        return 'main'
      case 'header':
        return hasNamedAncestor(el, ['article', 'aside', 'main', 'nav', 'section']) ? '' : 'banner'
      case 'footer':
        return hasNamedAncestor(el, ['article', 'aside', 'main', 'nav', 'section'])
          ? ''
          : 'contentinfo'
      case 'aside':
        return 'complementary'
      case 'form':
        return 'form'
      case 'section':
        return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : ''
      case 'article':
        return 'article'
      case 'dialog':
        return 'dialog'
      case 'table':
        return 'table'
      case 'tr':
        return 'row'
      case 'td':
        return 'cell'
      case 'th':
        return 'columnheader'
      case 'fieldset':
      case 'details':
        return 'group'
      case 'p':
        return 'paragraph'
      case 'hr':
        return 'separator'
      case 'progress':
        return 'progressbar'
      case 'meter':
        return 'meter'
      case 'iframe':
        return 'iframe'
    }
    if ((el as HTMLElement).isContentEditable && el.getAttribute('contenteditable') !== null) {
      return 'textbox'
    }
    return ''
  }

  const nameOf = (el: Element, role: string): string => {
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id))
        .filter((node): node is HTMLElement => node !== null)
        .map((node) => textOf(node))
        .filter(Boolean)
      if (parts.length > 0) return clipName(parts.join(' '))
    }
    const aria = collapse(el.getAttribute('aria-label'))
    if (aria) return clipName(aria)
    const tag = el.tagName.toLowerCase()
    if (tag === 'img') return clipName(collapse(el.getAttribute('alt')))
    if (tag === 'iframe')
      return clipName(collapse(el.getAttribute('title') || el.getAttribute('name')))
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (['button', 'submit', 'reset'].includes(type)) {
        return clipName(collapse((el as HTMLInputElement).value) || type)
      }
      const label = labelText(el)
      if (label) return clipName(label)
      const placeholder = collapse(el.getAttribute('placeholder'))
      if (placeholder) return clipName(placeholder)
      return clipName(collapse(el.getAttribute('title')))
    }
    if (NAME_FROM_CONTENT.has(role)) {
      const content = textOf(el)
      if (content) return clipName(content)
    }
    if (tag === 'fieldset') {
      const legend = el.querySelector('legend')
      if (legend) return clipName(textOf(legend))
    }
    return clipName(collapse(el.getAttribute('title')))
  }

  const isClickableGeneric = (el: Element): boolean => {
    if (el.hasAttribute('onclick')) return true
    const tabindex = el.getAttribute('tabindex')
    return tabindex !== null && tabindex !== '-1'
  }

  const inputValueOf = (el: Element, role: string): string | undefined => {
    if (!VALUE_ROLES.has(role)) return undefined
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'password') {
      return undefined
    }
    if (tag === 'select') {
      const select = el as HTMLSelectElement
      return collapse(select.selectedOptions?.[0]?.textContent) || undefined
    }
    if (tag === 'input' || tag === 'textarea') {
      return (el as HTMLInputElement).value || undefined
    }
    return undefined
  }

  const checkedOf = (el: Element, role: string): boolean | 'mixed' | undefined => {
    if (!['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
      return undefined
    }
    const aria = el.getAttribute('aria-checked')
    if (aria === 'mixed') return 'mixed'
    if (aria !== null) return aria === 'true'
    return (el as HTMLInputElement).checked === true
  }

  const disabledOf = (el: Element): boolean =>
    (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true'

  const expandedOf = (el: Element): boolean | undefined => {
    const aria = el.getAttribute('aria-expanded')
    if (aria !== null) return aria === 'true'
    if (el.tagName.toLowerCase() === 'summary') {
      const details = el.parentElement
      if (details?.tagName.toLowerCase() === 'details') return (details as HTMLDetailsElement).open
    }
    return undefined
  }

  const levelOf = (el: Element, role: string): number | undefined => {
    if (role !== 'heading') return undefined
    const aria = Number(el.getAttribute('aria-level'))
    if (aria > 0) return aria
    const match = /^h([1-6])$/i.exec(el.tagName)
    return match ? Number(match[1]) : 2
  }

  const snapshot = (scope: string | null): BrowseOutcome<{ tree: SnapshotNode[] }> => {
    const doc = frameDoc()
    const root = scope ? lookup(doc, scope) : doc.body
    if (!root) return fail('not-found', scope ?? 'document has no body')
    let count = 0

    const pushText = (out: SnapshotNode[], text: string): void => {
      const last = out[out.length - 1]
      if (last && last.role === 'text') last.name = clipName(`${last.name} ${text}`)
      else out.push({ role: 'text', name: clipName(text), children: [] })
    }

    const walk = (parent: Node, out: SnapshotNode[], skipText: boolean): void => {
      const children = [
        ...Array.from(parent.childNodes),
        ...Array.from((parent as Element).shadowRoot?.childNodes ?? []),
      ]
      for (const child of children) {
        if (count >= MAX_NODES) return
        if (child.nodeType === 3) {
          const text = collapse(child.textContent)
          if (text && !skipText) pushText(out, text)
          continue
        }
        if (child.nodeType !== 1) continue
        const el = child as Element
        if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue
        if (el.getAttribute('aria-hidden') === 'true' || !isRendered(el)) continue
        let role = roleOf(el)
        if (role === 'presentation' || role === 'none') role = ''
        if (!role && isClickableGeneric(el)) role = 'generic'
        if (!role || !hasBox(el)) {
          walk(el, out, skipText)
          continue
        }
        count += 1
        const node: SnapshotNode = {
          role,
          name: nameOf(el, role),
          ref: ref(el),
          children: [],
        }
        if (INTERACTIVE_ROLES.has(role) || isClickableGeneric(el)) node.interactive = true
        const level = levelOf(el, role)
        if (level !== undefined) node.level = level
        const checked = checkedOf(el, role)
        if (checked !== undefined) node.checked = checked
        if (disabledOf(el)) node.disabled = true
        const expanded = expandedOf(el)
        if (expanded !== undefined) node.expanded = expanded
        if (
          (el as HTMLOptionElement).selected === true ||
          el.getAttribute('aria-selected') === 'true'
        ) {
          node.selected = true
        }
        const value = inputValueOf(el, role)
        if (value !== undefined) node.value = value
        if (role === 'link') {
          const href = (el as HTMLAnchorElement).href
          if (href) node.url = href
        }
        if (el.tagName.toLowerCase() === 'iframe') {
          try {
            const inner = (el as HTMLIFrameElement).contentDocument?.body
            if (inner) walk(inner, node.children, false)
          } catch {}
        } else {
          walk(el, node.children, NAME_FROM_CONTENT.has(role) && node.name !== '')
        }
        out.push(node)
      }
    }

    const tree: SnapshotNode[] = []
    if (scope) {
      const wrapper = { childNodes: [root] } as unknown as Node
      walk(wrapper, tree, false)
    } else {
      walk(root, tree, false)
    }
    return { ok: true, tree }
  }

  const frameOffset = (el: Element): { x: number; y: number } => {
    let x = 0
    let y = 0
    let view = el.ownerDocument.defaultView
    while (view && view !== win && view.frameElement) {
      const frameRect = view.frameElement.getBoundingClientRect()
      x += frameRect.left + (view.frameElement as HTMLElement).clientLeft
      y += frameRect.top + (view.frameElement as HTMLElement).clientTop
      view = view.frameElement.ownerDocument.defaultView
    }
    return { x, y }
  }

  const describeElement = (el: Element): string => {
    const id = el.id ? `#${el.id}` : ''
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : ''
    return `<${el.tagName.toLowerCase()}${id}${cls}>`
  }

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

  const stylesOf = (el: Element, property: string | null): unknown => {
    const view = el.ownerDocument.defaultView ?? win
    const computed = view.getComputedStyle(el)
    if (property) return computed.getPropertyValue(property)
    const out: Record<string, string> = {}
    for (const key of STYLE_KEYS) out[key] = computed.getPropertyValue(key)
    return out
  }

  const get = (
    sub: string,
    target: string | null,
    arg: string | null,
  ): BrowseOutcome<{ value: unknown }> => {
    if (sub === 'title') return { ok: true, value: topDoc.title }
    if (sub === 'url') return { ok: true, value: win.location.href }
    if (!target) return fail('selector-required', sub)
    if (sub === 'count') {
      if (/^@?e\d+$/.test(target)) return { ok: true, value: resolve(target) ? 1 : 0 }
      try {
        return { ok: true, value: frameDoc().querySelectorAll(target).length }
      } catch {
        return fail('bad-selector', target)
      }
    }
    return withElement(target, (el) => {
      switch (sub) {
        case 'text':
          return { ok: true, value: (el as HTMLElement).innerText ?? el.textContent ?? '' }
        case 'html':
          return { ok: true, value: el.innerHTML }
        case 'value':
          return { ok: true, value: (el as HTMLInputElement).value ?? null }
        case 'attr':
          if (!arg) return fail('attr-required')
          return { ok: true, value: el.getAttribute(arg) }
        case 'box': {
          const rect = el.getBoundingClientRect()
          const offset = frameOffset(el)
          return {
            ok: true,
            value: {
              x: rect.x + offset.x,
              y: rect.y + offset.y,
              width: rect.width,
              height: rect.height,
            },
          }
        }
        case 'styles':
          return { ok: true, value: stylesOf(el, arg) }
        default:
          return fail('bad-sub', sub)
      }
    })
  }

  const is = (sub: string, target: string): BrowseOutcome<{ value: boolean }> =>
    withElement(target, (el) => {
      switch (sub) {
        case 'visible':
          return { ok: true, value: isVisible(el) }
        case 'enabled':
          return { ok: true, value: !disabledOf(el) }
        case 'checked':
          return {
            ok: true,
            value: checkedOf(el, roleOf(el) || 'checkbox') === true,
          }
        default:
          return fail('bad-sub', sub)
      }
    })

  const matches = (value: string | null | undefined, query: string, exact: boolean): boolean => {
    if (value === null || value === undefined) return false
    const text = collapse(value)
    return exact ? text === query : text.toLowerCase().includes(query.toLowerCase())
  }

  const candidates = (doc: Document): Element[] =>
    Array.from(doc.querySelectorAll('*')).filter(
      (el) => !SKIP_TAGS.has(el.tagName.toLowerCase()) && isVisible(el),
    )

  const locate = (query: FindQuery): Element | null => {
    const doc = frameDoc()
    const exact = query.exact === true
    switch (query.by) {
      case 'role': {
        const role = query.value.toLowerCase()
        return (
          candidates(doc).find((el) => {
            const elRole = roleOf(el) || (isClickableGeneric(el) ? 'generic' : '')
            if (elRole !== role) return false
            return query.name === undefined || matches(nameOf(el, elRole), query.name, exact)
          }) ?? null
        )
      }
      case 'text': {
        const found = candidates(doc).filter((el) => matches(textOf(el), query.value, exact))
        found.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)
        return found[0] ?? null
      }
      case 'label': {
        for (const label of Array.from(doc.querySelectorAll('label'))) {
          if (!matches(textOf(label), query.value, exact)) continue
          const control = (label as HTMLLabelElement).control
          if (control) return control
        }
        return (
          candidates(doc).find((el) =>
            matches(el.getAttribute('aria-label'), query.value, exact),
          ) ?? null
        )
      }
      case 'placeholder':
      case 'alt':
      case 'title': {
        const attr = query.by
        return (
          candidates(doc).find((el) => matches(el.getAttribute(attr), query.value, exact)) ?? null
        )
      }
      case 'testid':
        return (
          Array.from(doc.querySelectorAll('[data-testid]')).find(
            (el) => el.getAttribute('data-testid') === query.value,
          ) ?? null
        )
      case 'nth': {
        let list: Element[]
        try {
          list = Array.from(doc.querySelectorAll(query.value))
        } catch {
          return null
        }
        const index = query.index ?? 0
        return (index < 0 ? list[list.length + index] : list[index]) ?? null
      }
      default:
        return null
    }
  }

  const find = (query: FindQuery): BrowseOutcome<{ ref: string }> => {
    const el = locate(query)
    return el ? { ok: true, ref: ref(el) } : fail('not-found', `${query.by} ${query.value}`)
  }

  const hasState = (target: string, state: ElementState): boolean => {
    const el = resolve(target)
    switch (state) {
      case 'attached':
        return el !== null
      case 'detached':
        return el === null
      case 'hidden':
        return el === null || !isVisible(el)
      default:
        return el !== null && isVisible(el)
    }
  }

  const hasText = (text: string): boolean => textOf(frameDoc().body ?? topDoc.body).includes(text)

  const frame = (target: string | null): BrowseOutcome => {
    if (!target) {
      frameTarget = null
      return { ok: true }
    }
    const el = lookup(topDoc, target)
    if (!el) return fail('not-found', target)
    if (el.tagName.toLowerCase() !== 'iframe' && el.tagName.toLowerCase() !== 'frame') {
      return fail('not-a-frame', describeElement(el))
    }
    try {
      if (!(el as HTMLIFrameElement).contentDocument) return fail('cross-origin-frame', target)
    } catch {
      return fail('cross-origin-frame', target)
    }
    frameTarget = target
    return { ok: true }
  }

  const mark = (target: string, nonce: string): BrowseOutcome =>
    withElement(target, (el) => {
      el.setAttribute('data-pine-mark', nonce)
      return { ok: true }
    })

  const unmark = (nonce: string): void => {
    const docs = [topDoc, frameDoc()]
    for (const doc of docs) {
      for (const el of Array.from(doc.querySelectorAll(`[data-pine-mark="${nonce}"]`))) {
        el.removeAttribute('data-pine-mark')
      }
    }
  }

  const href = (target: string): BrowseOutcome<{ url: string }> =>
    withElement(target, (el) => {
      const link = el.closest('a[href]') as HTMLAnchorElement | null
      return link ? { ok: true, url: link.href } : fail('no-link', describeElement(el))
    })

  const dumpArea = (storage: Storage): Record<string, string> => {
    const out: Record<string, string> = {}
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (key !== null) out[key] = storage.getItem(key) ?? ''
    }
    return out
  }

  const areaOf = (area: StorageArea): Storage =>
    area === 'local' ? win.localStorage : win.sessionStorage

  const storageOp = (run: () => void): BrowseOutcome => {
    try {
      run()
      return { ok: true }
    } catch (e) {
      return fail('storage-failed', e instanceof Error ? e.message : String(e))
    }
  }

  return {
    resolve,
    ref,
    snapshot,
    point,
    focus: (target) =>
      withElement(target, (el) => {
        ;(el as HTMLElement).focus?.()
        const field = el as HTMLInputElement
        if (typeof field.value === 'string' && typeof field.setSelectionRange === 'function') {
          try {
            field.setSelectionRange(field.value.length, field.value.length)
          } catch {}
        }
        return { ok: true }
      }),
    fill,
    select,
    checked: (target) =>
      withElement(target, (el) => ({
        ok: true,
        value: checkedOf(el, roleOf(el) || 'checkbox') === true,
      })),
    scrollIntoView,
    scroll,
    highlight,
    get,
    is,
    find,
    hasState,
    hasText,
    frame,
    mark,
    unmark,
    href,
    readyState: () => topDoc.readyState,
    readText: () => (topDoc.body ? (topDoc.body.innerText ?? topDoc.body.textContent ?? '') : ''),
    storage: () => {
      let local: Record<string, string> = {}
      let session: Record<string, string> = {}
      try {
        local = dumpArea(win.localStorage)
      } catch {}
      try {
        session = dumpArea(win.sessionStorage)
      } catch {}
      return { origin: win.location.origin, local, session }
    },
    setStorage: (area, key, value) => storageOp(() => areaOf(area).setItem(key, value)),
    removeStorage: (area, key) => storageOp(() => areaOf(area).removeItem(key)),
    clearStorage: (area) => storageOp(() => areaOf(area).clear()),
  }
}

export const BROWSE_RUNTIME_GLOBAL = '__pineBrowse'

export function browseRuntimeScript(): string {
  return `window.${BROWSE_RUNTIME_GLOBAL} = window.${BROWSE_RUNTIME_GLOBAL} || (${browseRuntime.toString()})(window);`
}
