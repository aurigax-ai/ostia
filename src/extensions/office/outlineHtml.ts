import {
  type Translate,
  formatMessage,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'

export interface Figure {
  kind: 'image' | 'chart' | 'object'
  alt: string
}

export type Run = { text: string; href?: string } | { figure: Figure }

export interface Cell {
  blocks: Block[]
  colspan: number
  rowspan: number
}

export type Block =
  | { type: 'p'; runs: Run[] }
  | { type: 'h'; level: number; runs: Run[] }
  | { type: 'li'; level: number; ordered: boolean; runs: Run[] }
  | { type: 'table'; rows: Cell[][] }

export interface Slide {
  number: number
  title: string
  hidden: boolean
  blocks: Block[]
  notes: Block[]
}

export interface OutlineWords {
  slide: string
  hidden: string
  notes: string
  image: string
  imageAlt: string
  chart: string
  object: string
}

export interface OutlineHtml {
  html: string
  textCut: boolean
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const LINKABLE = /^(?:https?:|mailto:)/i
const SPAN_MAX = 1_000

export function outlineWords(t: Translate): OutlineWords {
  return {
    slide: t('slideTitle'),
    hidden: t('slideHidden'),
    notes: t('slideNotes'),
    image: t('outlineImage'),
    imageAlt: t('outlineImageAlt'),
    chart: t('outlineChart'),
    object: t('outlineObject'),
  }
}

function escaped(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char])
}

export function runsText(runs: Run[]): string {
  return runs
    .map((run) => ('text' in run ? run.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

class Writer {
  private readonly out: string[] = []
  private left: number
  cut = false

  constructor(
    readonly words: OutlineWords,
    maxChars: number,
  ) {
    this.left = maxChars
  }

  tag(markup: string): void {
    this.out.push(markup)
  }

  text(value: string): void {
    if (this.cut) return
    const kept = value.length > this.left ? value.slice(0, this.left) : value
    this.cut = kept.length < value.length
    this.left -= kept.length
    this.out.push(escaped(kept).replace(/\n/g, '<br>'))
  }

  html(): string {
    return this.out.join('')
  }
}

function figureText(words: OutlineWords, { kind, alt }: Figure): string {
  if (kind === 'chart') return words.chart
  if (kind === 'object') return words.object
  return alt ? formatMessage(words.imageAlt, { alt }) : words.image
}

function writeRuns(w: Writer, runs: Run[]): void {
  for (const run of runs) {
    if ('figure' in run) {
      w.text(figureText(w.words, run.figure))
    } else if (run.href && LINKABLE.test(run.href)) {
      w.tag(`<a href="${escaped(run.href)}">`)
      w.text(run.text)
      w.tag('</a>')
    } else {
      w.text(run.text)
    }
  }
}

function span(name: string, value: number): string {
  const kept = Math.min(Math.floor(value), SPAN_MAX)
  return kept > 1 ? ` ${name}="${kept}"` : ''
}

function writeTable(w: Writer, rows: Cell[][], headingShift: number): void {
  w.tag('<table><tbody>')
  for (const row of rows) {
    if (w.cut) break
    w.tag('<tr>')
    for (const cell of row) {
      w.tag(`<td${span('colspan', cell.colspan)}${span('rowspan', cell.rowspan)}>`)
      writeBlocks(w, cell.blocks, headingShift)
      w.tag('</td>')
    }
    w.tag('</tr>')
  }
  w.tag('</tbody></table>')
}

function writeBlocks(w: Writer, blocks: Block[], headingShift: number): void {
  const lists: string[] = []
  const closeLists = (depth: number): void => {
    while (lists.length > depth) w.tag(`</li></${lists.pop()}>`)
  }
  for (const block of blocks) {
    if (w.cut) break
    if (block.type !== 'li') closeLists(0)
    if (block.type === 'li') {
      const level = Math.min(block.level, lists.length)
      closeLists(level + 1)
      if (lists.length === level + 1) {
        w.tag('</li>')
      } else {
        const tag = block.ordered ? 'ol' : 'ul'
        lists.push(tag)
        w.tag(`<${tag}>`)
      }
      w.tag('<li>')
      writeRuns(w, block.runs)
    } else if (block.type === 'table') {
      writeTable(w, block.rows, headingShift)
    } else {
      const tag = block.type === 'h' ? `h${Math.min(block.level + headingShift, 6)}` : 'p'
      w.tag(`<${tag}>`)
      writeRuns(w, block.runs)
      w.tag(`</${tag}>`)
    }
  }
  closeLists(0)
}

export function documentOutlineHtml(
  blocks: Block[],
  words: OutlineWords,
  maxChars: number,
): OutlineHtml {
  const w = new Writer(words, maxChars)
  writeBlocks(w, blocks, 0)
  return { html: w.html(), textCut: w.cut }
}

export function presentationOutlineHtml(
  slides: Slide[],
  words: OutlineWords,
  maxChars: number,
): OutlineHtml {
  const w = new Writer(words, maxChars)
  for (const slide of slides) {
    if (w.cut) break
    const title = slide.title || formatMessage(words.slide, { number: slide.number })
    w.tag('<section><h2>')
    w.text(slide.hidden ? formatMessage(words.hidden, { title }) : title)
    w.tag('</h2>')
    writeBlocks(w, slide.blocks, 2)
    if (slide.notes.length > 0 && !w.cut) {
      w.tag('<blockquote><h3>')
      w.text(words.notes)
      w.tag('</h3>')
      writeBlocks(w, slide.notes, 3)
      w.tag('</blockquote>')
    }
    w.tag('</section>')
  }
  return { html: w.html(), textCut: w.cut }
}
