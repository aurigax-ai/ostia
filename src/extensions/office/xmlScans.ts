import { GuardStop } from './officeLimits'

const SHEETJS_ATTRIBUTE = /\s([^"\s?>/]+)\s*=\s*((?:")([^"]*)(?:")|(?:')([^']*)(?:')|([^'">\s]+))/g
const SHEETJS_HYPERLINK = /<(?:\w+:)?hyperlink [^<>]*>/gm
const SHEETJS_XLML_TAG =
  /<([/]?)([^\s?><!/:"]*:|)([^\s?<>:/"]+)(?:\s+[^<>=?"'\s]+="[^"]*?")*\s*[/]?>/gm

export interface Budget {
  left: number
}

export function spend(
  budget: Budget,
  amount: number,
  problem: 'cells-limit' | 'nodes-limit',
): void {
  budget.left -= amount
  if (!(budget.left >= 0)) throw new GuardStop(problem)
}

export function sheetjsTagAttributes(tag: string): Record<string, string> {
  const z: Record<string, string> = {}
  let eq = 0
  for (; eq !== tag.length; ++eq) {
    const c = tag.charCodeAt(eq)
    if (c === 32 || c === 10 || c === 13) break
  }
  if (eq === tag.length) return z
  for (const match of tag.match(SHEETJS_ATTRIBUTE) ?? []) {
    const cc = match.slice(1)
    let c = 0
    for (; c !== cc.length; ++c) if (cc.charCodeAt(c) === 61) break
    let q = cc.slice(0, c).trim()
    while (cc.charCodeAt(c + 1) === 32) ++c
    const quote = cc.charCodeAt(c + 1)
    const quoted = quote === 34 || quote === 39 ? 1 : 0
    const v = cc.slice(c + 1 + quoted, cc.length - quoted)
    let j = 0
    for (; j !== q.length; ++j) if (q.charCodeAt(j) === 58) break
    if (j === q.length) {
      if (q.indexOf('_') > 0) q = q.slice(0, q.indexOf('_'))
      z[q] = v
      z[q.toLowerCase()] = v
    } else {
      const k = (j === 5 && q.slice(0, 5) === 'xmlns' ? 'xmlns' : '') + q.slice(j + 1)
      if (z[k] && q.slice(j - 3, j) === 'ext') continue
      z[k] = v
      z[k.toLowerCase()] = v
    }
  }
  return z
}

function removeBetween(text: string, open: string, close: string): string {
  const out: string[] = []
  let last = 0
  let si = text.indexOf(open)
  if (si === -1) return text
  while (si > -1) {
    out.push(text.slice(last, si))
    const ei = text.indexOf(close, si + open.length)
    if (ei === -1) break
    last = ei + close.length
    si = text.indexOf(open, last)
    if (si === -1) out.push(text.slice(last))
  }
  return out.join('')
}

function removeDoctype(text: string): string {
  const si = text.slice(0, 1024).indexOf('<!DOCTYPE')
  if (si === -1) return text
  const m = text.match(/<[\w]/)
  return m?.index === undefined ? text : text.slice(0, si) + text.slice(m.index)
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

export function hyperlinkCells(text: string): number {
  let cells = 0
  for (const [tag] of text.matchAll(SHEETJS_HYPERLINK)) {
    const ref = sheetjsTagAttributes(tag).ref
    if (ref) cells += decodeRangeArea(ref)
  }
  return cells
}

function repeat(value: string | undefined): number {
  const columns = Number.parseInt(value || '1', 10)
  return Number.isNaN(columns) ? 1 : Math.max(1, columns)
}

export function odsCells(text: string): number {
  const content = removeDoctype(removeBetween(text, '<!--', '-->'))
  let cells = 0
  let rowsRepeated = 1
  let cellTag: Record<string, string> = {}
  SHEETJS_XLML_TAG.lastIndex = 0
  for (let match = SHEETJS_XLML_TAG.exec(content); match; match = SHEETJS_XLML_TAG.exec(content)) {
    const [tag, closing, , rawName] = match
    const name = rawName.replace(/_[\s\S]*$/, '')
    if (name === 'table-row' || name === '行') {
      if (closing === '/') rowsRepeated = 1
      else rowsRepeated = Math.max(1, +sheetjsTagAttributes(tag)['number-rows-repeated'] || 1)
    } else if (name === 'covered-table-cell') {
      if (closing !== '/') cellTag = sheetjsTagAttributes(tag)
    } else if (name === 'table-cell' || name === '数据') {
      if (tag.charAt(tag.length - 2) === '/') {
        cellTag = sheetjsTagAttributes(tag)
        cells += 1
      } else if (closing !== '/') {
        cellTag = sheetjsTagAttributes(tag)
      } else {
        cells += rowsRepeated * repeat(cellTag['number-columns-repeated'])
      }
    }
  }
  return cells
}

export function elementCount(text: string): number {
  let count = 0
  for (let at = text.indexOf('<'); at !== -1; at = text.indexOf('<', at + 1)) {
    const next = text.charCodeAt(at + 1)
    if (next !== 47 && next !== 63 && next !== 33) count++
  }
  return count
}
