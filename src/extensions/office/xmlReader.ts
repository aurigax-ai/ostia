import { GuardStop } from './officeLimits'

export interface XmlElement {
  name: string
  attributes: Map<string, string>
  children: XmlNode[]
}

type XmlNode = XmlElement | string

interface Scope {
  names: Map<string, string>
  parent: Scope | null
}

interface Frame {
  element: XmlElement
  written: string
  scope: Scope | null
}

const NAMESPACES = new Map([
  ['http://schemas.openxmlformats.org/presentationml/2006/main', 'p'],
  ['http://purl.oclc.org/ooxml/presentationml/main', 'p'],
  ['http://schemas.openxmlformats.org/drawingml/2006/main', 'a'],
  ['http://purl.oclc.org/ooxml/drawingml/main', 'a'],
  ['http://schemas.openxmlformats.org/drawingml/2006/chart', 'c'],
  ['http://purl.oclc.org/ooxml/drawingml/chart', 'c'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'r'],
  ['http://purl.oclc.org/ooxml/officeDocument/relationships', 'r'],
  ['http://schemas.openxmlformats.org/markup-compatibility/2006', 'mc'],
  ['http://schemas.openxmlformats.org/package/2006/content-types', 'ct'],
  ['http://schemas.openxmlformats.org/package/2006/relationships', 'rel'],
  ['urn:oasis:names:tc:opendocument:xmlns:office:1.0', 'office'],
  ['urn:oasis:names:tc:opendocument:xmlns:text:1.0', 'text'],
  ['urn:oasis:names:tc:opendocument:xmlns:table:1.0', 'table'],
  ['urn:oasis:names:tc:opendocument:xmlns:drawing:1.0', 'draw'],
  ['urn:oasis:names:tc:opendocument:xmlns:presentation:1.0', 'presentation'],
  ['urn:oasis:names:tc:opendocument:xmlns:style:1.0', 'style'],
  ['urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0', 'svg'],
  ['http://www.w3.org/1999/xlink', 'xlink'],
])
const PREDEFINED = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])
const ENTITY = /&(?:#x([0-9a-fA-F]{1,8})|#([0-9]{1,10})|([A-Za-z]{2,4}));/y
const NAME_STOP = /[\s/>]/
const BAD_NAME = /[\s<>"'=/&]/

function fail(): never {
  throw new GuardStop('failed')
}

function after(text: string, close: string, from: number): number {
  const at = text.indexOf(close, from)
  if (at === -1) fail()
  return at + close.length
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13
}

function skipSpace(text: string, from: number): number {
  let at = from
  while (isSpace(text.charCodeAt(at))) at++
  return at
}

function entityText([, hex, decimal, named]: RegExpExecArray): string {
  if (named !== undefined) return PREDEFINED.get(named) ?? fail()
  const code = Number.parseInt(hex ?? decimal ?? '', hex === undefined ? 10 : 16)
  const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
  return valid ? String.fromCodePoint(code) : '\uFFFD'
}

function decoded(raw: string): string {
  let at = raw.indexOf('&')
  if (at === -1) return raw
  let out = ''
  let last = 0
  while (at !== -1) {
    ENTITY.lastIndex = at
    const match = ENTITY.exec(raw)
    if (!match) fail()
    out += raw.slice(last, at) + entityText(match)
    last = ENTITY.lastIndex
    at = raw.indexOf('&', last)
  }
  return out + raw.slice(last)
}

function uriOf(scope: Scope | null, prefix: string): string {
  for (let at = scope; at; at = at.parent) {
    const uri = at.names.get(prefix)
    if (uri !== undefined) return uri
  }
  return ''
}

function resolved(written: string, scope: Scope | null, attribute: boolean): string {
  const colon = written.indexOf(':')
  if (colon === -1 && attribute) return written
  const prefix = colon === -1 ? '' : written.slice(0, colon)
  const canonical = NAMESPACES.get(uriOf(scope, prefix))
  if (canonical === undefined) return written
  return `${canonical}:${written.slice(colon + 1)}`
}

function startTag(
  text: string,
  open: number,
  parent: Scope | null,
): { frame: Frame; closed: boolean; next: number } {
  let at = open + 1
  while (at < text.length && !NAME_STOP.test(text[at])) at++
  const written = text.slice(open + 1, at)
  if (!written || BAD_NAME.test(written)) fail()
  const raw: [string, string][] = []
  let declared: Map<string, string> | null = null
  let closed = false
  for (;;) {
    at = skipSpace(text, at)
    const code = text.charCodeAt(at)
    if (code === 62 || code === 47) {
      closed = code === 47
      if (closed && text.charCodeAt(at + 1) !== 62) fail()
      at += closed ? 2 : 1
      break
    }
    const equals = text.indexOf('=', at)
    if (equals === -1) fail()
    const name = text.slice(at, equals).trimEnd()
    if (!name || BAD_NAME.test(name)) fail()
    const quoteAt = skipSpace(text, equals + 1)
    const quote = text[quoteAt]
    if (quote !== '"' && quote !== "'") fail()
    const close = text.indexOf(quote, quoteAt + 1)
    if (close === -1) fail()
    const value = text.slice(quoteAt + 1, close)
    if (value.includes('<')) fail()
    if (name === 'xmlns' || name.startsWith('xmlns:')) {
      declared ??= new Map()
      declared.set(name === 'xmlns' ? '' : name.slice(6), decoded(value))
    } else {
      raw.push([name, decoded(value)])
    }
    at = close + 1
  }
  const scope = declared ? { names: declared, parent } : parent
  const element: XmlElement = {
    name: resolved(written, scope, false),
    attributes: new Map(raw.map(([name, value]) => [resolved(name, scope, true), value])),
    children: [],
  }
  return { frame: { element, written, scope }, closed, next: at }
}

export function readXml(text: string, maxDepth: number): XmlElement {
  const stack: Frame[] = []
  let root: XmlElement | null = null
  const addText = (value: string): void => {
    const top = stack.at(-1)
    if (top) top.element.children.push(value)
    else if (value.trim()) fail()
  }
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (at < text.length) {
    const open = text.indexOf('<', at)
    const end = open === -1 ? text.length : open
    if (end > at) addText(decoded(text.slice(at, end)))
    if (open === -1) break
    if (text.startsWith('<?', open)) {
      at = after(text, '?>', open + 2)
    } else if (text.startsWith('<!--', open)) {
      at = after(text, '-->', open + 4)
    } else if (text.startsWith('<![CDATA[', open)) {
      at = after(text, ']]>', open + 9)
      addText(text.slice(open + 9, at - 3))
    } else if (text.charCodeAt(open + 1) === 33) {
      fail()
    } else if (text.charCodeAt(open + 1) === 47) {
      at = after(text, '>', open + 2)
      if (stack.pop()?.written !== text.slice(open + 2, at - 1).trimEnd()) fail()
    } else {
      const top = stack.at(-1)
      if (!top && root) fail()
      if (stack.length >= maxDepth) throw new GuardStop('depth-limit')
      const { frame, closed, next } = startTag(text, open, top ? top.scope : null)
      if (top) top.element.children.push(frame.element)
      else root = frame.element
      if (!closed) stack.push(frame)
      at = next
    }
  }
  if (!root || stack.length > 0) fail()
  return root
}

export function elementsOf(parent: XmlElement | undefined): XmlElement[] {
  const out: XmlElement[] = []
  for (const node of parent?.children ?? []) if (typeof node !== 'string') out.push(node)
  return out
}

export function childOf(parent: XmlElement | undefined, name: string): XmlElement | undefined {
  return elementsOf(parent).find((element) => element.name === name)
}

export function childrenOf(parent: XmlElement | undefined, name: string): XmlElement[] {
  return elementsOf(parent).filter((element) => element.name === name)
}

export function pathOf(parent: XmlElement | undefined, ...names: string[]): XmlElement | undefined {
  let at = parent
  for (const name of names) at = childOf(at, name)
  return at
}

export function xmlPartReader(
  parts: Map<string, { data: Uint8Array }>,
  maxDepth: number,
): (key: string) => XmlElement | undefined {
  const read = new Map<string, XmlElement>()
  const decoder = new TextDecoder()
  return (key) => {
    const part = parts.get(key)
    if (!part) return undefined
    const known = read.get(key)
    if (known) return known
    const root = readXml(decoder.decode(part.data), maxDepth)
    read.set(key, root)
    return root
  }
}
