import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const root = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? process.cwd()
const check = process.argv.includes('--check')

const SCAN_DIRS = ['src', 'e2e', 'test', 'scripts']
const ROOT_FILES = ['electron.vite.config.ts', 'vitest.config.ts', 'vitest.workspace.ts', 'playwright.config.ts']
const SKIP = [/node_modules/, /src\/renderer\/components\/ui\//, /\.d\.ts$/]
const DIRECTIVE = /^(\/\/|\/\*)\s*(biome-ignore|@ts-expect-error|@ts-ignore|@ts-nocheck|eslint-|@vite-ignore|webpackIgnore)|^\/\/\/\s*<reference/

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const p = join(dir, name)
    if (SKIP.some((re) => re.test(p))) continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|mjs|css)$/.test(name)) out.push(p)
  }
  return out
}

function literalSpans(sf) {
  const spans = []
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.JsxText:
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
      case ts.SyntaxKind.RegularExpressionLiteral:
        spans.push([node.getStart(sf), node.end])
    }
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  return spans
}

function scriptRanges(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const spans = literalSpans(sf)
  const inLiteral = (pos) => spans.some(([s, e]) => pos >= s && pos < e)
  const found = new Map()
  const add = (ranges) => {
    for (const r of ranges ?? []) {
      if (inLiteral(r.pos)) continue
      if (DIRECTIVE.test(text.slice(r.pos, r.end))) continue
      found.set(r.pos, { pos: r.pos, end: r.end })
    }
  }
  const emptyJsx = []
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(text, node.pos))
    add(ts.getTrailingCommentRanges(text, node.end))
    if (node.kind === ts.SyntaxKind.JsxExpression && !node.expression) emptyJsx.push(node)
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  for (const node of emptyJsx) {
    const start = node.getStart(sf)
    const inner = [...found.values()].filter((r) => r.pos > start && r.end < node.end)
    if (inner.length === 0) continue
    for (const r of inner) found.delete(r.pos)
    found.set(start, { pos: start, end: node.end })
  }
  return [...found.values()]
}

function cssRanges(text) {
  const ranges = []
  let i = 0
  let quote = null
  while (i < text.length) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      ranges.push({ pos: i, end: stop })
      i = stop
      continue
    }
    i++
  }
  return ranges
}

function strip(text, ranges) {
  let out = text
  for (const { pos, end } of [...ranges].sort((a, b) => b.pos - a.pos)) {
    const lineStart = out.lastIndexOf('\n', pos - 1) + 1
    let lineEnd = out.indexOf('\n', end)
    if (lineEnd === -1) lineEnd = out.length
    const before = out.slice(lineStart, pos)
    const after = out.slice(end, lineEnd)
    if (before.trim() === '' && after.trim() === '') {
      out = out.slice(0, lineStart) + out.slice(Math.min(lineEnd + 1, out.length))
    } else {
      const left = after.trim() === '' ? before.replace(/[ \t]+$/, '') : before
      out = out.slice(0, lineStart) + left + (after.trim() === '' ? '' : after) + out.slice(lineEnd)
    }
  }
  return out.replace(/\n{3,}/g, '\n\n')
}

const files = [
  ...SCAN_DIRS.flatMap((d) => walk(join(root, d), [])),
  ...ROOT_FILES.map((f) => join(root, f)).filter((f) => {
    try {
      return statSync(f).isFile()
    } catch {
      return false
    }
  }),
]

const offenders = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const ranges = file.endsWith('.css') ? cssRanges(text) : scriptRanges(file, text)
  if (ranges.length === 0) continue
  const rel = relative(root, file)
  if (check) {
    for (const r of ranges.slice(0, 3)) {
      const line = text.slice(0, r.pos).split('\n').length
      offenders.push(`${rel}:${line}  ${text.slice(r.pos, r.end).split('\n')[0].slice(0, 80)}`)
    }
    if (ranges.length > 3) offenders.push(`${rel}: …and ${ranges.length - 3} more`)
  } else {
    writeFileSync(file, strip(text, ranges))
    offenders.push(`${rel}: removed ${ranges.length}`)
  }
}

if (check && offenders.length > 0) {
  console.error('Code comments are not allowed (see CLAUDE.md "No code comments"):')
  for (const o of offenders) console.error(`  ${o}`)
  process.exit(1)
}
if (!check) console.log(offenders.join('\n') || 'no comments found')
