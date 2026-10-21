/// <reference lib="dom" />
import type { BrowseOutcome } from '../browser/browseRuntime'
import type { SnapshotNode } from '../browser/browseSnapshot'
import {
  checkedOf,
  disabledOf,
  expandedOf,
  INTERACTIVE_ROLES,
  inputValueOf,
  isClickableGeneric,
  levelOf,
  NAME_FROM_CONTENT,
  nameOf,
  roleOf,
} from './ariaRoles'
import type { PageLayout } from './pageLayout'
import type { PageTargets } from './pageTargets'
import { clipName, collapse, fail, SKIP_TAGS } from './pageText'

const MAX_NODES = 3000

type SnapshotDeps = Pick<PageTargets, 'frameDoc' | 'lookup' | 'ref'> &
  Pick<PageLayout, 'isRendered' | 'hasBox'>

export function createSnapshot({ frameDoc, lookup, ref, isRendered, hasBox }: SnapshotDeps) {
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

  return snapshot
}
