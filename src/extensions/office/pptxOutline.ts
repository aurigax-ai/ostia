import { GuardStop, type OfficeLimits } from './officeLimits'
import { type Block, type Cell, type Figure, type Run, runsText, type Slide } from './outlineHtml'
import {
  childOf,
  childrenOf,
  elementsOf,
  pathOf,
  type XmlElement,
  xmlPartReader,
} from './xmlReader'

export interface PresentationOutline {
  slides: Slide[]
  slidesCut: boolean
}

interface Relationship {
  type: string
  target: string
  external: boolean
}

type Read = (key: string) => XmlElement | undefined
type Links = Map<string, Relationship>

const PRESENTATION = 'ppt/presentation.xml'
const PRESENTATION_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
  'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
  'application/vnd.ms-powerpoint.template.macroEnabled.main+xml',
])
const TITLES = new Set(['title', 'ctrTitle'])
const BODIES = new Set(['body', 'obj'])
const CHROME = new Set(['dt', 'ftr', 'hdr', 'sldNum'])
const TRUE = new Set(['1', 'true'])

function fail(): never {
  throw new GuardStop('failed')
}

function isPresentation(types: XmlElement | undefined): boolean {
  return childrenOf(types, 'ct:Override').some(
    (override) =>
      override.attributes.get('PartName')?.toLowerCase() === `/${PRESENTATION}` &&
      PRESENTATION_TYPES.has(override.attributes.get('ContentType') ?? ''),
  )
}

function relationships(read: Read, key: string): Links {
  const slash = key.lastIndexOf('/') + 1
  const root = read(`${key.slice(0, slash)}_rels/${key.slice(slash)}.rels`)
  const links: Links = new Map()
  for (const rel of childrenOf(root, 'rel:Relationship')) {
    const id = rel.attributes.get('Id')
    const target = rel.attributes.get('Target')
    if (!id || target === undefined) continue
    links.set(id, {
      type: rel.attributes.get('Type') ?? '',
      target,
      external: rel.attributes.get('TargetMode') === 'External',
    })
  }
  return links
}

export function partKey(from: string, target: string): string | null {
  const segments = target.startsWith('/') ? [] : from.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
    } else if (segment !== '.' && segment !== '') {
      segments.push(segment)
    }
  }
  return segments.join('/').toLowerCase()
}

function linkedPart(links: Links, id: string | undefined, from: string, type: string) {
  const rel = id === undefined ? undefined : links.get(id)
  if (!rel || rel.external || !rel.type.endsWith(`/${type}`)) return null
  return partKey(from, rel.target)
}

function hyperlink(links: Links, properties: XmlElement | undefined): string | undefined {
  const id = childOf(properties, 'a:hlinkClick')?.attributes.get('r:id')
  const rel = id === undefined ? undefined : links.get(id)
  return rel?.external && rel.type.endsWith('/hyperlink') ? rel.target : undefined
}

function runsOf(paragraph: XmlElement, links: Links): Run[] {
  const runs: Run[] = []
  for (const part of elementsOf(paragraph)) {
    if (part.name === 'a:br') {
      runs.push({ text: '\n' })
    } else if (part.name === 'a:r' || part.name === 'a:fld') {
      const text = childOf(part, 'a:t')?.children.filter((node) => typeof node === 'string')
      const href = hyperlink(links, childOf(part, 'a:rPr'))
      runs.push(href ? { text: text?.join('') ?? '', href } : { text: text?.join('') ?? '' })
    }
  }
  return runs
}

function paragraphsOf(body: XmlElement | undefined, links: Links, bulleted: boolean): Block[] {
  const blocks: Block[] = []
  for (const paragraph of childrenOf(body, 'a:p')) {
    const runs = runsOf(paragraph, links)
    if (!runsText(runs)) continue
    const properties = childOf(paragraph, 'a:pPr')
    const numbered = childOf(properties, 'a:buAutoNum') !== undefined
    const marked = numbered || childOf(properties, 'a:buChar') !== undefined
    if (marked || (bulleted && !childOf(properties, 'a:buNone'))) {
      const level = Number.parseInt(properties?.attributes.get('lvl') ?? '0', 10)
      blocks.push({
        type: 'li',
        level: level > 0 ? Math.min(level, 8) : 0,
        ordered: numbered,
        runs,
      })
    } else {
      blocks.push({ type: 'p', runs })
    }
  }
  return blocks
}

function figure(kind: Figure['kind'], properties: XmlElement | undefined): Block {
  return { type: 'p', runs: [{ figure: { kind, alt: properties?.attributes.get('descr') ?? '' } }] }
}

function tableOf(table: XmlElement, links: Links): Block {
  const rows = childrenOf(table, 'a:tr').map((row) => {
    const cells: Cell[] = []
    for (const cell of childrenOf(row, 'a:tc')) {
      const merged = ['hMerge', 'vMerge'].some((name) => TRUE.has(cell.attributes.get(name) ?? ''))
      if (merged) continue
      cells.push({
        blocks: paragraphsOf(childOf(cell, 'a:txBody'), links, false),
        colspan: Number(cell.attributes.get('gridSpan') ?? 1) || 1,
        rowspan: Number(cell.attributes.get('rowSpan') ?? 1) || 1,
      })
    }
    return cells
  })
  return { type: 'table', rows }
}

interface Shapes {
  links: Links
  blocks: Block[]
  title: string
  placeholders: Set<string> | null
}

function shapeOf(shape: XmlElement, into: Shapes): void {
  const placeholder = pathOf(shape, 'p:nvSpPr', 'p:nvPr', 'p:ph')
  const kind = placeholder?.attributes.get('type') ?? (placeholder ? 'body' : '')
  if (into.placeholders) {
    if (into.placeholders.has(kind)) {
      into.blocks.push(...paragraphsOf(childOf(shape, 'p:txBody'), into.links, false))
    }
  } else if (TITLES.has(kind)) {
    const title = childrenOf(childOf(shape, 'p:txBody'), 'a:p')
      .map((paragraph) => runsText(runsOf(paragraph, into.links)))
      .filter(Boolean)
      .join(' ')
    if (into.title) into.blocks.push({ type: 'p', runs: [{ text: title }] })
    else into.title = title
  } else if (!CHROME.has(kind)) {
    into.blocks.push(...paragraphsOf(childOf(shape, 'p:txBody'), into.links, BODIES.has(kind)))
  }
}

function frameOf(frame: XmlElement, into: Shapes): void {
  const data = pathOf(frame, 'a:graphic', 'a:graphicData')
  const table = childOf(data, 'a:tbl')
  const properties = pathOf(frame, 'p:nvGraphicFramePr', 'p:cNvPr')
  if (table) into.blocks.push(tableOf(table, into.links))
  else into.blocks.push(figure(childOf(data, 'c:chart') ? 'chart' : 'object', properties))
}

function shapesOf(tree: XmlElement | undefined, into: Shapes): void {
  for (const shape of elementsOf(tree)) {
    if (shape.name === 'p:sp') {
      shapeOf(shape, into)
    } else if (shape.name === 'p:grpSp') {
      shapesOf(shape, into)
    } else if (shape.name === 'mc:AlternateContent') {
      shapesOf(childOf(shape, 'mc:Choice') ?? childOf(shape, 'mc:Fallback'), into)
    } else if (!into.placeholders && shape.name === 'p:graphicFrame') {
      frameOf(shape, into)
    } else if (!into.placeholders && shape.name === 'p:pic') {
      into.blocks.push(figure('image', pathOf(shape, 'p:nvPicPr', 'p:cNvPr')))
    }
  }
}

function notesOf(read: Read, key: string | null, shown: Set<string>): Block[] {
  if (!key || shown.has(key)) return []
  shown.add(key)
  const root = read(key)
  if (root?.name !== 'p:notes') return []
  const into: Shapes = {
    links: relationships(read, key),
    blocks: [],
    title: '',
    placeholders: new Set(['body']),
  }
  shapesOf(pathOf(root, 'p:cSld', 'p:spTree'), into)
  return into.blocks
}

function slideOf(read: Read, key: string, number: number, notes: Set<string>): Slide | null {
  const root = read(key)
  if (root?.name !== 'p:sld') return null
  const links = relationships(read, key)
  const into: Shapes = { links, blocks: [], title: '', placeholders: null }
  shapesOf(pathOf(root, 'p:cSld', 'p:spTree'), into)
  const notesId = [...links].find(([, rel]) => rel.type.endsWith('/notesSlide'))?.[0]
  return {
    number,
    title: into.title,
    hidden: root.attributes.get('show') === '0' || root.attributes.get('show') === 'false',
    blocks: into.blocks,
    notes: notesOf(read, linkedPart(links, notesId, key, 'notesSlide'), notes),
  }
}

export function pptxOutline(
  parts: Map<string, { data: Uint8Array }>,
  limits: OfficeLimits,
): PresentationOutline {
  const read = xmlPartReader(parts, limits.xmlDepth)
  if (!isPresentation(read('[content_types].xml'))) fail()
  const presentation = read(PRESENTATION)
  if (presentation?.name !== 'p:presentation') fail()
  const links = relationships(read, PRESENTATION)
  const slides: Slide[] = []
  const seen = new Set<string>()
  const notes = new Set<string>()
  for (const id of childrenOf(childOf(presentation, 'p:sldIdLst'), 'p:sldId')) {
    const key = linkedPart(links, id.attributes.get('r:id'), PRESENTATION, 'slide')
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (slides.length === limits.slides) return { slides, slidesCut: true }
    const slide = slideOf(read, key, slides.length + 1, notes)
    if (slide) slides.push(slide)
  }
  return { slides, slidesCut: false }
}
