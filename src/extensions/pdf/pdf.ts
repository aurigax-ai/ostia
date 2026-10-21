import {
  type Translate,
  translatorFor,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { createPill, type Pill, type PillControl } from '@aurigax-ai/ostia-extension-sdk/pill'
import {
  openViewerDocument,
  openViewerLink,
  showViewerMessage,
  ViewerDocumentError,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import { attachCapture } from './capture'
import { createFindController } from './findController'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import { Pages } from './pages'
import type { PageView } from './pageView'
import { seedFromHash } from './pdfFind'
import { PDF_ICONS } from './pdfIcons'
import { isPasswordError, openPdf, type PdfDocument } from './pdfjs'
import {
  modeChoice,
  modeOfChoice,
  pinchScale,
  resolveScale,
  rotateBy,
  stepScale,
  turnedSize,
  ZOOM_PRESETS,
  type ZoomMode,
  zoomText,
} from './pdfLayout'
import type { LinkTarget } from './pdfSelection'
import { createSidebar, type OutlineNode } from './sidebar'

const NARROW_PIXELS = 480
const isMac = /Mac/.test(navigator.platform)
const ROTATE_STEP = 90

const root = document.getElementById('root') as HTMLElement

function problemKey(error: unknown): 'unreadable' | 'gone' {
  return error instanceof ViewerDocumentError && error.problem === 'gone' ? 'gone' : 'unreadable'
}

function zoomItems(t: Translate): { id: string; label: string }[][] {
  return [
    [
      { id: 'fit-width', label: t('fitWidth') },
      { id: 'fit-page', label: t('fitPage') },
      { id: 'actual-size', label: t('actualSize') },
    ],
    ZOOM_PRESETS.map((value) => {
      const text = zoomText(value)
      return { id: `zoom-${Math.round(value * 100)}`, label: text }
    }),
  ]
}

async function start(doc: PdfDocument, t: Translate): Promise<void> {
  const first = await doc.getPage(1)
  const unit = first.getViewport({ scale: 1 })
  const firstSize = { width: unit.width, height: unit.height }
  first.cleanup()

  const outline = (await doc.getOutline().catch(() => null)) as OutlineNode[] | null
  let mode: ZoomMode = 'fit-width'
  let cropMode = false
  let pill!: Pill
  let pillNarrow = false

  const stageSize = () => ({
    width: document.documentElement.clientWidth - sidebarWidth(),
    height: window.innerHeight,
  })
  const sidebarWidth = (): number => (sidebar.isOpen() ? sidebar.element.offsetWidth : 0)

  const pageOf = (element: Element | null): PageView | null => {
    const page = element?.closest<HTMLElement>('.pdf-page')
    return page ? (pages.views[Number(page.dataset.page) - 1] ?? null) : null
  }

  const find = createFindController({
    doc,
    views: () => pages.views,
    pill: () => pill,
    currentPage: () => pages.current || 1,
    goTo: (page) => pages.goTo(page),
  })

  const pages: Pages = new Pages(doc, firstSize, {
    onCurrent: (page) => {
      pill.setState('page', { page })
      sidebar.setCurrent(page)
    },
    onRendered: (view) => find.rendered(view),
    onFirstSize: () => {
      if (mode === 'fit-width' || mode === 'fit-page') applyMode(mode, undefined, true)
    },
  })

  const sidebar = createSidebar({
    doc,
    labels: {
      sidebar: t('sidebar'),
      tabs: t('sidebarTabs'),
      pages: t('pages'),
      outline: t('outline'),
      thumbnail: (page) => t('thumbnail', { page }),
    },
    outline,
    firstAspect: firstSize.height / firstSize.width,
    onGo: (page) => pages.goTo(page),
    onTarget: (target) => void follow(target),
  })

  const scaleOf = (next: ZoomMode): number =>
    resolveScale(
      next,
      turnedSize(pages.views[0]?.unrotatedSize ?? firstSize, pages.state.rotation),
      stageSize(),
    )

  function syncZoom(scale: number): void {
    pill.setState('zoom', { text: zoomText(scale), checked: modeChoice(mode) })
    pill.setState('fit-width', { pressed: mode === 'fit-width' })
    pill.setState('fit-page', { pressed: mode === 'fit-page' })
  }

  function applyView(nextMode: ZoomMode, rotation: number, clientY?: number, keep = false): void {
    mode = nextMode
    const scale = scaleOf(nextMode)
    const { state } = pages
    if (state.scale === scale && state.rotation === rotation) {
      syncZoom(scale)
      return
    }
    if (keep) capture.clearRegion()
    else capture.clear()
    const anchor = window.scrollY > 0 ? pages.anchorAt(clientY ?? window.innerHeight / 2) : null
    pages.setView({ scale, rotation })
    if (anchor) pages.restore(anchor)
    syncZoom(scale)
  }

  function applyMode(next: ZoomMode, clientY?: number, keep = false): void {
    applyView(next, pages.state.rotation, clientY, keep)
  }

  const zoomBy = (direction: 1 | -1): void => applyMode(stepScale(pages.state.scale, direction))

  async function follow(target: LinkTarget): Promise<void> {
    if (target.kind === 'url') {
      void openViewerLink(target.url)
      return
    }
    if (target.kind === 'step') {
      const count = pages.views.length
      const current = pages.current || 1
      const page = { next: current + 1, previous: current - 1, first: 1, last: count }[target.step]
      pages.goTo(Math.min(count, Math.max(1, page)))
      return
    }
    const explicit =
      typeof target.dest === 'string' ? await doc.getDestination(target.dest) : target.dest
    const reference = explicit?.[0]
    if (reference === undefined || reference === null) return
    const index =
      typeof reference === 'number' ? reference : await doc.getPageIndex(reference as never)
    pages.goTo(index + 1)
  }

  const capture = attachCapture({
    pageOf,
    scale: () => pages.state.scale,
    rotation: () => pages.state.rotation,
    cropMode: () => cropMode,
    onLink: (target) => void follow(target),
  })

  function controls(narrow: boolean): PillControl[] {
    const zoomOut: PillControl = {
      type: 'button',
      id: 'zoom-out',
      label: t('zoomOut'),
      icon: PDF_ICONS.zoomOut,
      onClick: () => zoomBy(-1),
    }
    const zoomIn: PillControl = {
      type: 'button',
      id: 'zoom-in',
      label: t('zoomIn'),
      icon: PDF_ICONS.zoomIn,
      onClick: () => zoomBy(1),
    }
    const fitWidth: PillControl = {
      type: 'toggle',
      id: 'fit-width',
      label: t('fitWidth'),
      icon: PDF_ICONS.fitWidth,
      pressed: mode === 'fit-width',
      onToggle: (pressed) => applyMode(pressed ? 'fit-width' : pages.state.scale),
    }
    const fitPage: PillControl = {
      type: 'toggle',
      id: 'fit-page',
      label: t('fitPage'),
      icon: PDF_ICONS.fitPage,
      pressed: mode === 'fit-page',
      onToggle: (pressed) => applyMode(pressed ? 'fit-page' : pages.state.scale),
    }
    return [
      {
        type: 'toggle',
        id: 'sidebar',
        label: t('sidebar'),
        icon: PDF_ICONS.sidebar,
        pressed: sidebar.isOpen(),
        onToggle: (open) => {
          sidebar.setOpen(open)
          if (mode === 'fit-width' || mode === 'fit-page') applyMode(mode)
        },
      },
      {
        type: 'pager',
        id: 'page',
        label: t('page'),
        page: pages.current || 1,
        count: pages.views.length,
        of: (count) => t('of', { count }),
        previous: { label: t('previousPage') },
        next: { label: t('nextPage') },
        onGo: (page) => pages.goTo(page),
      },
      ...(narrow ? [] : [zoomOut]),
      {
        type: 'menu',
        id: 'zoom',
        label: t('zoom'),
        text: zoomText(pages.state.scale),
        items: zoomItems(t),
        checked: modeChoice(mode) ?? undefined,
        onPick: (id) => {
          const next = modeOfChoice(id)
          if (next !== null) applyMode(next)
        },
      },
      ...(narrow ? [] : [zoomIn, fitWidth, fitPage]),
      {
        type: 'button',
        id: 'rotate',
        label: t('rotate'),
        icon: PDF_ICONS.rotate,
        onClick: () => applyView(mode, rotateBy(pages.state.rotation, ROTATE_STEP)),
      },
      {
        type: 'toggle',
        id: 'crop',
        label: t('selectRegion'),
        icon: PDF_ICONS.crop,
        pressed: cropMode,
        onToggle: (pressed) => {
          cropMode = pressed
          capture.clear()
          document.body.classList.toggle('pdf-crop-mode', pressed)
        },
      },
      {
        type: 'find',
        id: 'find',
        label: t('find'),
        chord: isMac ? '⌘F' : 'Ctrl+F',
        icon: PDF_ICONS.search,
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
        onQuery: (query, options) => find.query(query, options),
        onStep: (direction) => find.step(direction),
        onClose: () => find.close(),
      },
    ]
  }

  function buildPill(): void {
    pillNarrow = window.innerWidth < NARROW_PIXELS
    pill = createPill({ label: t('controls'), controls: controls(pillNarrow) })
  }

  buildPill()
  document.body.append(sidebar.element, pages.element)
  root.remove()
  applyMode('fit-width')

  let lastStage = stageSize()
  window.addEventListener('resize', () => {
    const stage = stageSize()
    if (stage.width === lastStage.width && stage.height === lastStage.height) return
    lastStage = stage
    if (pill.find.isOpen()) return
    if (window.innerWidth < NARROW_PIXELS !== pillNarrow) {
      pill.destroy()
      buildPill()
      syncZoom(pages.state.scale)
    }
    if (mode === 'fit-width' || mode === 'fit-page') applyMode(mode, undefined, true)
  })

  window.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      applyMode(pinchScale(pages.state.scale, event.deltaY), event.clientY)
    },
    { passive: false },
  )

  document.addEventListener(
    'keydown',
    (event) => {
      const primary = isMac ? event.metaKey : event.ctrlKey
      const key = event.key.toLowerCase()
      const opens = primary && !event.altKey && !event.shiftKey && key === 'f'
      const steps = key === 'f3' || (primary && key === 'g')
      if (!opens && !steps) return
      event.preventDefault()
      if (opens || !pill.find.isOpen()) pill.find.open()
      else find.step(event.shiftKey ? -1 : 1)
    },
    true,
  )

  const seed = seedFromHash(location.hash)
  if (seed.page) pages.goTo(Math.min(seed.page, pages.views.length))
  if (seed.find) {
    pill.find.open()
    const field = pill.element.querySelector<HTMLInputElement>('.ostia-pill-find-field')
    if (field) {
      field.value = seed.find
      field.dispatchEvent(new Event('input'))
    }
  }
}

async function main(): Promise<void> {
  const catalogs = { en: en.messages, 'zh-Hant': zhHant.messages }
  let meta: Awaited<ReturnType<typeof openViewerDocument>>
  try {
    meta = await openViewerDocument()
  } catch (error) {
    showViewerMessage(root, translatorFor(catalogs, undefined)(problemKey(error)))
    return
  }
  const t = translatorFor(catalogs, meta.locale)
  meta.onDidChange(() => location.reload())
  showViewerMessage(root, t('loading'))
  try {
    await start(await openPdf(), t)
  } catch (error) {
    showViewerMessage(root, t(isPasswordError(error) ? 'protected' : 'failed'))
  }
}

void main()
