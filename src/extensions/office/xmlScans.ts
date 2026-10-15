import type { EntrySink } from './canonicalZip'
import { GuardStop } from './officeLimits'

const TAG_MAX = 1024 * 1024
const HYPERLINK = /<(?:\w+:)?hyperlink [^<>]*>/g
const REF = /(?:^|\s)(?:\w+:)?ref\s*=\s*(?:"([^"]*)"|'([^']*)')/
const ODS_TAG = /<(\/?)(?:[\w.-]+:)?(table-row|table-cell|行|数据)(?=[\s/>])([^<>]*?)(\/?)>/g
const ROWS_REPEATED = /(?:^|\s)(?:[\w.-]+:)?number-rows-repeated\s*=\s*(?:"([^"]*)"|'([^']*)')/
const COLUMNS_REPEATED =
  /(?:^|\s)(?:[\w.-]+:)?number-columns-repeated\s*=\s*(?:"([^"]*)"|'([^']*)')/
const STRING_TYPE = /(?:^|\s)(?:[\w.-]+:)?(?:value-type|数据类型)\s*=\s*(?:"string"|'string')/

export interface CellBudget {
  left: number
}

function spend(budget: CellBudget, cells: number): void {
  budget.left -= cells
  if (!(budget.left >= 0)) throw new GuardStop('cells-limit')
}

function attribute(tag: string, pattern: RegExp): string | null {
  const match = pattern.exec(tag)
  return match ? (match[1] ?? match[2] ?? '') : null
}

function tagSink(onText: (text: string) => string): EntrySink {
  const decoder = new TextDecoder()
  let carry = ''
  return (chunk, final) => {
    const text = carry + decoder.decode(chunk, { stream: !final })
    const rest = onText(text)
    if (rest.length > TAG_MAX) throw new GuardStop('failed')
    carry = final ? '' : rest
  }
}

function afterLastTag(text: string): string {
  const open = text.lastIndexOf('<')
  return open > text.lastIndexOf('>') ? text.slice(open) : ''
}

export function decodeRangeArea(range: string): number {
  let i = 0
  let idx = 0
  let cc = 0
  const read = (base: number, from: number, to: number, scale: number): number => {
    for (idx = 0; i < range.length; ++i) {
      cc = range.charCodeAt(i) - base
      if (cc < from || cc > to) break
      idx = scale * idx + cc
    }
    return --idx
  }
  const sc = read(64, 1, 26, 26)
  const sr = read(48, 0, 9, 10)
  if (i === range.length || cc !== 10) return 1
  ++i
  const ec = read(64, 1, 26, 26)
  const er = read(48, 0, 9, 10)
  const rows = er - sr + 1
  const columns = ec - sc + 1
  return rows > 0 && columns > 0 ? rows * columns : 0
}

export function hyperlinkScan(budget: CellBudget): EntrySink {
  return tagSink((text) => {
    for (const match of text.matchAll(HYPERLINK)) {
      const ref = attribute(match[0], REF)
      if (ref) spend(budget, decodeRangeArea(ref))
    }
    return afterLastTag(text)
  })
}

export function odsRepeatScan(budget: CellBudget): EntrySink {
  let rowsRepeated = 1
  return tagSink((text) => {
    for (const match of text.matchAll(ODS_TAG)) {
      const [, closing, name, attributes, selfClosing] = match
      const row = name === 'table-row' || name === '行'
      if (row) {
        if (closing) rowsRepeated = 1
        else rowsRepeated = Number(attribute(attributes, ROWS_REPEATED) ?? '1') || 1
        continue
      }
      if (closing) continue
      if (selfClosing) {
        if (STRING_TYPE.test(attributes)) spend(budget, 1)
        continue
      }
      const columns = Number.parseInt(attribute(attributes, COLUMNS_REPEATED) ?? '1', 10)
      spend(budget, Math.max(1, rowsRepeated) * Math.max(1, Number.isNaN(columns) ? 1 : columns))
    }
    return afterLastTag(text)
  })
}
