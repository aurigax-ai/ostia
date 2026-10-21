import type { Translate } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { h } from '@aurigax-ai/ostia-extension-sdk/panel'
import { createPill, type Pill } from '@aurigax-ai/ostia-extension-sdk/pill'
import {
  clearSelection,
  openViewerLink,
  publishSelection,
  requestEditSource,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { createContents } from './contents'
import { MermaidDiagram } from './diagram'
import { createFinder } from './find'
import { findKeyOf } from './findKeys'
import { ICONS } from './icons'
import { entryForFragment, type OutlineEntry, outlineOf } from './outline'
import { markdownElement } from './render'
import { trackSelection } from './selection'

export interface PreviewView {
  show: (text: string) => void
  destroy: () => void
}

function findChord(): string {
  return isMac() ? '⌘F' : 'Ctrl+F'
}

function isMac(): boolean {
  return /Mac/i.test(navigator.platform)
}

export function createPreview(root: HTMLElement, t: Translate): PreviewView {
  const article = h('article', { class: 'typeset typeset-ostia' })
  const page = h('main', { class: 'markdown-page' }, article)
  const reactRoot = createRoot(article)
  let entries: readonly OutlineEntry[] = []
  let pill: Pill | null = null

  const scrollTo = (entry: OutlineEntry): void => {
    entry.element.scrollIntoView({ block: 'start' })
  }
  const contents = createContents({ title: t('contents'), empty: t('noHeadings') }, scrollTo)
  const notice = h('div', { class: 'markdown-notice', role: 'status' })
  notice.hidden = true
  root.replaceChildren(contents.element, page, notice)

  const finder = createFinder(article, (result) => pill?.find.setResult(result))
  const selection = trackSelection(article, {
    publish: (picked) => {
      notice.textContent = picked.shortened ? t('selectionShortened') : ''
      notice.hidden = !picked.shortened
      void publishSelection({
        capture: {
          kind: 'text',
          view: 'preview',
          range: { startLine: picked.startLine, endLine: picked.endLine },
        },
        text: picked.text,
        rect: picked.rect,
      })
    },
    clear: () => {
      notice.hidden = true
      void clearSelection()
    },
  })

  const onLink = (href: string): void => {
    if (!href.startsWith('#')) {
      void openViewerLink(href)
      return
    }
    const target = entryForFragment(entries, href.slice(1))
    if (target) scrollTo(target)
  }
  const diagramLabels = {
    alt: t('diagram'),
    problem: t('diagramProblem'),
    tooLarge: t('diagramTooLarge'),
  }
  const hooks = {
    onLink,
    diagram: (code: string, lines: Record<string, unknown>) =>
      createElement(MermaidDiagram, { code, labels: diagramLabels, lines }),
  }

  pill = createPill({
    label: t('tools'),
    page: document.body,
    controls: [
      {
        type: 'toggle',
        id: 'contents',
        label: t('contents'),
        icon: ICONS.contents,
        onToggle: (open) => contents.setOpen(open),
      },
      {
        type: 'find',
        id: 'find',
        label: t('find'),
        chord: findChord(),
        icon: ICONS.search,
        labels: {
          placeholder: t('findPlaceholder'),
          matchCase: t('matchCase'),
          highlightAll: t('highlightAll'),
          previous: t('previousMatch'),
          next: t('nextMatch'),
          done: t('done'),
          none: t('noMatches'),
          count: (index, total) => t('matchCount', { index, total }),
        },
        onQuery: (query, options) => finder.search(query, options),
        onStep: (direction) => finder.step(direction),
        onClose: () => finder.close(),
      },
      {
        type: 'button',
        id: 'source',
        label: t('editSource'),
        icon: ICONS.source,
        onClick: () => void requestEditSource(),
      },
    ],
  })
  const tools = pill

  const onKeyDown = (event: KeyboardEvent): void => {
    const action = findKeyOf(event, isMac())
    if (!action) return
    event.preventDefault()
    if (action === 'open' || !tools.find.isOpen()) tools.find.open()
    else finder.step(action === 'next' ? 1 : -1)
  }
  document.addEventListener('keydown', onKeyDown)

  return {
    show: (text) => {
      flushSync(() => reactRoot.render(markdownElement(text, hooks)))
      entries = outlineOf(article)
      contents.setEntries(entries)
      finder.refresh()
      selection.sync()
    },
    destroy: () => {
      document.removeEventListener('keydown', onKeyDown)
      selection.destroy()
      finder.close()
      tools.destroy()
      reactRoot.unmount()
      document.documentElement.removeAttribute('data-contents')
    },
  }
}
