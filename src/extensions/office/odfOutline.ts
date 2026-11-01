import { GuardStop, type OfficeLimits } from './officeLimits'
import { type Block, type Cell, type Figure, type Run, runsText, type Slide } from './outlineHtml'
import type { PresentationOutline } from './pptxOutline'
import { childOf, childrenOf, elementsOf, type XmlElement, xmlPartReader } from './xmlReader'

type Parts = Map<string, { data: Uint8Array }>

const SKIPPED = new Set([
  'office:annotation',
  'office:annotation-end',
  'office:event-listeners',
  'office:forms',
  'text:tracked-changes',
  'text:note-body',
  'text:sequence-decls',
  'table:table-columns',
  'table:table-column',
  'presentation:notes',
  'draw:page-thumbnail',
])
const CHROME = new Set(['page-number', 'footer', 'date-time', 'header'])
const SPACE_MAX = 64
const ROW_GROUPS = new Set(['table:table-header-rows', 'table:table-rows', 'table:table-row-group'])

function skipped(element: XmlElement): boolean {
  return SKIPPED.has(element.name) || element.name.endsWith('-source')
}

function contentOf(parts: Parts, limits: OfficeLimits): XmlElement {
  const root = xmlPartReader(parts, limits.xmlDepth)('content.xml')
  if (root?.name !== 'office:document-content') throw new GuardStop('failed')
  return root
}

function count(element: XmlElement, name: string): number {
  const value = Number.parseInt(element.attributes.get(name) ?? '1', 10)
  return Math.max(value, 1)
}

function figureOf(frame: XmlElement): Figure | null {
  const alt = (childOf(frame, 'svg:title') ?? childOf(frame, 'svg:desc'))?.children
    .filter((node) => typeof node === 'string')
    .join('')
    .trim()
  if (childOf(frame, 'draw:image')) return { kind: 'image', alt: alt ?? '' }
  if (childOf(frame, 'draw:object') || childOf(frame, 'draw:object-ole')) {
    return { kind: 'object', alt: alt ?? '' }
  }
  return null
}

function runsOf(element: XmlElement, runs: Run[], href?: string): Run[] {
  for (const node of element.children) {
    if (typeof node === 'string') {
      const text = node.replace(/[\t\n\r ]+/g, ' ')
      runs.push(href ? { text, href } : { text })
      continue
    }
    if (skipped(node)) continue
    if (node.name === 'text:tab') runs.push({ text: '\t' })
    else if (node.name === 'text:line-break') runs.push({ text: '\n' })
    else if (node.name === 'text:s') {
      runs.push({ text: '\u00a0'.repeat(Math.min(count(node, 'text:c'), SPACE_MAX)) })
    } else if (node.name === 'text:a') runsOf(node, runs, node.attributes.get('xlink:href'))
    else if (node.name === 'draw:frame') frameRuns(node, runs)
    else runsOf(node, runs, href)
  }
  return runs
}

function boxRuns(container: XmlElement, runs: Run[]): void {
  for (const element of elementsOf(container)) {
    if (skipped(element) || element.name === 'table:table') continue
    if (element.name === 'text:p' || element.name === 'text:h') {
      runs.push({ text: '\n' })
      runsOf(element, runs)
    } else if (element.name === 'draw:frame') {
      frameRuns(element, runs)
    } else {
      boxRuns(element, runs)
    }
  }
}

function frameRuns(frame: XmlElement, runs: Run[]): void {
  const box = childOf(frame, 'draw:text-box')
  const figure = box ? null : figureOf(frame)
  if (box) boxRuns(box, runs)
  else if (figure) runs.push({ figure })
}

function paragraph(element: XmlElement, out: Block[], heading: boolean): void {
  const runs = runsOf(element, [])
  if (!runsText(runs) && !runs.some((run) => 'figure' in run)) return
  const level = Math.min(count(element, 'text:outline-level'), 6)
  out.push(heading ? { type: 'h', level, runs } : { type: 'p', runs })
}

function listOf(list: XmlElement, level: number, out: Block[]): void {
  for (const item of elementsOf(list)) {
    if (item.name !== 'text:list-item' && item.name !== 'text:list-header') continue
    for (const part of elementsOf(item)) {
      if (part.name === 'text:list') {
        listOf(part, level + 1, out)
      } else if (part.name === 'text:p' || part.name === 'text:h') {
        const runs = runsOf(part, [])
        if (runsText(runs)) out.push({ type: 'li', level, ordered: false, runs })
      } else if (!skipped(part)) {
        blocksOf(part, out)
      }
    }
  }
}

function rowsOf(container: XmlElement, rows: Cell[][]): Cell[][] {
  for (const part of elementsOf(container)) {
    if (ROW_GROUPS.has(part.name)) {
      rowsOf(part, rows)
    } else if (part.name === 'table:table-row') {
      rows.push(
        childrenOf(part, 'table:table-cell').map((cell) => ({
          blocks: blocksOf(cell, []),
          colspan: count(cell, 'table:number-columns-spanned'),
          rowspan: count(cell, 'table:number-rows-spanned'),
        })),
      )
    }
  }
  return rows
}

function blockOf(element: XmlElement, out: Block[]): void {
  if (skipped(element)) return
  if (element.name === 'text:p') paragraph(element, out, false)
  else if (element.name === 'text:h') paragraph(element, out, true)
  else if (element.name === 'text:list') listOf(element, 0, out)
  else if (element.name === 'table:table') out.push({ type: 'table', rows: rowsOf(element, []) })
  else if (element.name === 'draw:frame') frameBlocks(element, out)
  else blocksOf(element, out)
}

function blocksOf(container: XmlElement, out: Block[]): Block[] {
  for (const element of elementsOf(container)) blockOf(element, out)
  return out
}

function frameBlocks(frame: XmlElement, out: Block[]): void {
  const box = childOf(frame, 'draw:text-box')
  const table = childOf(frame, 'table:table')
  const figure = figureOf(frame)
  if (box) blocksOf(box, out)
  else if (table) out.push({ type: 'table', rows: rowsOf(table, []) })
  else if (figure) out.push({ type: 'p', runs: [{ figure }] })
}

export function odtOutline(parts: Parts, limits: OfficeLimits): Block[] {
  const text = childOf(childOf(contentOf(parts, limits), 'office:body'), 'office:text')
  return text ? blocksOf(text, []) : []
}

function hiddenStyles(root: XmlElement | undefined): Set<string> {
  const hidden = new Set<string>()
  for (const style of childrenOf(root, 'style:style')) {
    const properties = childOf(style, 'style:drawing-page-properties')
    const name = style.attributes.get('style:name')
    if (name && properties?.attributes.get('presentation:visibility') === 'hidden') hidden.add(name)
  }
  return hidden
}

function pageOf(page: XmlElement, number: number, hidden: Set<string>): Slide {
  const slide: Slide = { number, title: '', hidden: false, blocks: [], notes: [] }
  for (const shape of elementsOf(page)) {
    const kind = shape.attributes.get('presentation:class') ?? ''
    if (shape.name === 'draw:frame' && kind === 'title' && !slide.title) {
      const lines = blocksOf(shape, []).map((block) =>
        'runs' in block ? runsText(block.runs) : '',
      )
      slide.title = lines.filter(Boolean).join(' ')
    } else if (!CHROME.has(kind)) {
      blockOf(shape, slide.blocks)
    }
  }
  const notes = childOf(page, 'presentation:notes')
  for (const shape of elementsOf(notes)) {
    if (shape.attributes.get('presentation:class') === 'notes') blocksOf(shape, slide.notes)
  }
  const style = page.attributes.get('draw:style-name') ?? ''
  slide.hidden = page.attributes.get('presentation:visibility') === 'hidden' || hidden.has(style)
  slide.title ||= page.attributes.get('draw:name') ?? ''
  return slide
}

export function odpOutline(parts: Parts, limits: OfficeLimits): PresentationOutline {
  const content = contentOf(parts, limits)
  const presentation = childOf(childOf(content, 'office:body'), 'office:presentation')
  const hidden = hiddenStyles(childOf(content, 'office:automatic-styles'))
  const slides: Slide[] = []
  for (const page of childrenOf(presentation, 'draw:page')) {
    if (slides.length === limits.slides) return { slides, slidesCut: true }
    slides.push(pageOf(page, slides.length + 1, hidden))
  }
  return { slides, slidesCut: false }
}
