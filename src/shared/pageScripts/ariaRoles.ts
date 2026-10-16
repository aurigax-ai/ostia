/// <reference lib="dom" />
import { clipName, collapse, textOf } from './pageText'

export const INTERACTIVE_ROLES = new Set([
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
export const NAME_FROM_CONTENT = new Set([
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

export const roleOf = (el: Element): string => {
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

export const nameOf = (el: Element, role: string): string => {
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

export const isClickableGeneric = (el: Element): boolean => {
  if (el.hasAttribute('onclick')) return true
  const tabindex = el.getAttribute('tabindex')
  return tabindex !== null && tabindex !== '-1'
}

export const inputValueOf = (el: Element, role: string): string | undefined => {
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

export const checkedOf = (el: Element, role: string): boolean | 'mixed' | undefined => {
  if (!['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
    return undefined
  }
  const aria = el.getAttribute('aria-checked')
  if (aria === 'mixed') return 'mixed'
  if (aria !== null) return aria === 'true'
  return (el as HTMLInputElement).checked === true
}

export const disabledOf = (el: Element): boolean =>
  (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true'

export const expandedOf = (el: Element): boolean | undefined => {
  const aria = el.getAttribute('aria-expanded')
  if (aria !== null) return aria === 'true'
  if (el.tagName.toLowerCase() === 'summary') {
    const details = el.parentElement
    if (details?.tagName.toLowerCase() === 'details') return (details as HTMLDetailsElement).open
  }
  return undefined
}

export const levelOf = (el: Element, role: string): number | undefined => {
  if (role !== 'heading') return undefined
  const aria = Number(el.getAttribute('aria-level'))
  if (aria > 0) return aria
  const match = /^h([1-6])$/i.exec(el.tagName)
  return match ? Number(match[1]) : 2
}
