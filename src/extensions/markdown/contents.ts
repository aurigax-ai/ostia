import { h } from '@aurigax-ai/ostia-extension-sdk/panel'
import type { OutlineEntry } from './outline'

export interface ContentsLabels {
  title: string
  empty: string
}

export interface Contents {
  element: HTMLElement
  setEntries: (entries: readonly OutlineEntry[]) => void
  setOpen: (open: boolean) => void
}

export function createContents(
  labels: ContentsLabels,
  onPick: (entry: OutlineEntry) => void,
): Contents {
  const list = h('ul', { class: 'markdown-contents-list' })
  const element = h('nav', { class: 'markdown-contents', 'aria-label': labels.title }, list)
  element.hidden = true
  return {
    element,
    setOpen: (open) => {
      element.hidden = !open
      document.documentElement.toggleAttribute('data-contents', open)
    },
    setEntries: (entries) => {
      if (entries.length === 0) {
        list.replaceChildren(h('li', { class: 'markdown-contents-empty' }, labels.empty))
        return
      }
      list.replaceChildren(
        ...entries.map((entry) => {
          const item = h('button', { type: 'button', class: 'markdown-contents-item' }, entry.text)
          item.style.setProperty('--level', String(entry.level))
          item.addEventListener('click', () => onPick(entry))
          return h('li', {}, item)
        }),
      )
    },
  }
}
