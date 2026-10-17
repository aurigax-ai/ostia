import { extname } from 'node:path'
import { escape as escapeHtml } from 'es-toolkit'
import { type DefaultTreeAdapterMap, parse } from 'parse5'
import type { PortableMode } from '../../shared/artifacts/portable'
import {
  BuildFailure,
  type BuildRun,
  type Bundler,
  bundle,
  escapeInlineScript,
} from './portableBundle'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

interface Splice {
  start: number
  end: number
  text: string
}

const MEDIA_SRC = new Set(['img', 'source', 'video', 'audio', 'track', 'embed'])
const ICON_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon'])

const MIME: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt',
}

function isElement(node: Node): node is Element {
  return 'tagName' in node
}

function attribute(element: Element, name: string): string | null {
  return element.attrs.find((attr) => attr.name === name)?.value ?? null
}

function isLocal(url: string | null): url is string {
  return url !== null && url !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)
}

function localPath(url: string): string {
  const clean = url.split(/[?#]/)[0]
  try {
    return decodeURIComponent(clean)
  } catch {
    return clean
  }
}

function startTag(element: Element, drop: readonly string[], set: Record<string, string> = {}) {
  const kept = element.attrs.filter((attr) => !drop.includes(attr.name) && !(attr.name in set))
  const attrs = [
    ...kept.map((attr) =>
      attr.value === '' ? attr.name : `${attr.name}="${escapeHtml(attr.value)}"`,
    ),
    ...Object.entries(set).map(([name, value]) => `${name}="${escapeHtml(value)}"`),
  ]
  return `<${element.tagName}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`
}

function walk(node: Node, visit: (element: Element) => void): void {
  if (isElement(node)) visit(node)
  const children = 'childNodes' in node ? node.childNodes : []
  for (const child of children) walk(child, visit)
  if (isElement(node) && node.tagName === 'template' && 'content' in node) {
    walk((node as DefaultTreeAdapterMap['template']).content, visit)
  }
}

function textOf(element: Element): string {
  return element.childNodes.map((child) => ('value' in child ? child.value : '')).join('')
}

export interface PageResult {
  html: string
  texts: string[]
}

export async function buildPage(
  bundler: Bundler,
  run: BuildRun,
  mode: PortableMode,
  target: string[],
  tailwind: (texts: string[]) => Promise<string>,
): Promise<PageResult> {
  const source = (await run.read(run.source.file)).toString('utf8')
  const tree = parse(source, { sourceCodeLocationInfo: true })
  const elements: Element[] = []
  walk(tree, (element) => elements.push(element))
  const splices: Splice[] = []
  const located = (element: Element, text: string): void => {
    const where = element.sourceCodeLocation
    if (where) splices.push({ start: where.startOffset, end: where.endOffset, text })
  }
  const attributeSplice = async (element: Element, name: string): Promise<void> => {
    const value = attribute(element, name)
    const where = element.sourceCodeLocation?.attrs?.[name]
    if (!isLocal(value) || !where) return
    const path = run.resolveLocal(`./${localPath(value).replace(/^\.\//, '')}`, run.source.file)
    if (!path) return
    const body = await run.read(path)
    const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
    splices.push({
      start: where.startOffset,
      end: where.endOffset,
      text: `${name}="data:${type};base64,${body.toString('base64')}"`,
    })
  }

  for (const element of elements) {
    const tag = element.tagName
    if (tag === 'script') {
      const src = attribute(element, 'src')
      if (attribute(element, 'type') === 'module') {
        if (src !== null && !isLocal(src)) continue
        const entry =
          src === null
            ? ({ kind: 'inline', code: textOf(element) } as const)
            : ({ kind: 'module', path: requireLocal(run, src) } as const)
        const out = await bundle(bundler, run, entry, mode, target)
        const style = out.css ? `<style>${out.css}</style>` : ''
        located(element, `${style}${startTag(element, ['src'])}${out.js}</script>`)
      } else if (isLocal(src)) {
        const code = (await run.read(requireLocal(run, src))).toString('utf8')
        located(element, `${startTag(element, ['src'])}${escapeInlineScript(code)}</script>`)
      }
    } else if (tag === 'link') {
      const rel = (attribute(element, 'rel') ?? '').toLowerCase().split(/\s+/)
      const href = attribute(element, 'href')
      if (rel.includes('stylesheet') && isLocal(href)) {
        const out = await bundle(
          bundler,
          run,
          { kind: 'stylesheet', path: requireLocal(run, href) },
          mode,
          target,
        )
        located(element, `<style>${out.css}</style>`)
      } else if (rel.some((name) => ICON_RELS.has(name))) {
        await attributeSplice(element, 'href')
      }
    } else if (MEDIA_SRC.has(tag) || (tag === 'input' && attribute(element, 'type') === 'image')) {
      await attributeSplice(element, 'src')
      if (tag === 'video') await attributeSplice(element, 'poster')
    }
  }

  const texts = [source, ...run.sources.values()]
  const css = await tailwind(texts)
  if (css) splices.push(styleSplice(tree, source, `<style>${css}</style>`))
  return { html: applySplices(source, splices), texts }
}

function requireLocal(run: BuildRun, url: string): string {
  const path = run.resolveLocal(`./${localPath(url).replace(/^\.\//, '')}`, run.source.file)
  if (path) return path
  throw new BuildFailure([
    {
      file: run.label(run.source.file),
      line: 1,
      column: 1,
      message: `cannot find "${url}" (not-found)`,
    },
  ])
}

function styleSplice(
  tree: DefaultTreeAdapterMap['document'],
  source: string,
  text: string,
): Splice {
  let head: Element | null = null
  walk(tree, (element) => {
    if (!head && element.tagName === 'head') head = element
  })
  const found = head as Element | null
  const end = found?.sourceCodeLocation?.endTag?.startOffset
  if (end !== undefined) return { start: end, end, text }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(source)
  const at = doctype ? doctype[0].length : 0
  return { start: at, end: at, text }
}

function applySplices(source: string, splices: Splice[]): string {
  let out = ''
  let at = 0
  for (const splice of [...splices].sort((a, b) => a.start - b.start)) {
    if (splice.start < at) continue
    out += source.slice(at, splice.start) + splice.text
    at = splice.end
  }
  return out + source.slice(at)
}
