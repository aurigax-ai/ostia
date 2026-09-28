import { hasDangerousSegment } from '../../shared/protoGuard'
import { globalStorePath, loadJson, projectStorePath, saveJson } from '../sdk'

export type WikiScope = 'project' | 'global'

export interface WikiPage {
  title: string
  body: string
  updatedAt: string
}

export type WikiData = Record<string, WikiPage>

export type WikiError = { ok: false; error: string; message?: string }

export const MAX_BODY_BYTES = 256 * 1024
export const MAX_PAGES = 2000

export const NOT_FOUND: WikiError = { ok: false, error: 'not-found' }
const INVALID_SLUG: WikiError = { ok: false, error: 'invalid-slug' }
const TOO_LARGE: WikiError = { ok: false, error: 'too-large' }
const TOO_MANY_PAGES: WikiError = {
  ok: false,
  error: 'too-many-pages',
  message: `this scope already has ${MAX_PAGES} pages — delete one before adding another`,
}

export function wikiPath(scope: WikiScope, workDir: string | undefined): string | WikiError {
  if (scope === 'global') return globalStorePath('wiki')
  if (!workDir?.trim()) {
    return {
      ok: false,
      error: 'no-project-workdir',
      message:
        'no project workDir is known for this session yet, so a project-scoped wiki would ' +
        "collapse into a shared default — pass `--global`, or retry once the pane's project " +
        'is resolved.',
    }
  }
  return projectStorePath('wiki', workDir)
}

function load(path: string): WikiData {
  const raw = loadJson<unknown>(path, {})
  const out: WikiData = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [slug, page] of Object.entries(raw as Record<string, WikiPage>)) {
    if (hasDangerousSegment(slug)) continue
    out[slug] = page
  }
  return out
}

export function getPage(path: string, slug: string): ({ slug: string } & WikiPage) | WikiError {
  const store = load(path)
  if (!Object.hasOwn(store, slug)) return NOT_FOUND
  const page = store[slug]
  return { slug, title: page.title, body: page.body, updatedAt: page.updatedAt }
}

export function listPages(path: string): { slug: string; title: string; updatedAt: string }[] {
  return Object.entries(load(path)).map(([slug, p]) => ({
    slug,
    title: p.title,
    updatedAt: p.updatedAt,
  }))
}

export function setPage(
  path: string,
  slug: string,
  body: string,
  title: string | undefined,
): { ok: true } | WikiError {
  if (!slug || hasDangerousSegment(slug)) return INVALID_SLUG
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return TOO_LARGE
  const store = load(path)
  if (!Object.hasOwn(store, slug) && Object.keys(store).length >= MAX_PAGES) return TOO_MANY_PAGES
  store[slug] = { title: title ?? slug, body, updatedAt: new Date().toISOString() }
  saveJson(path, store)
  return { ok: true }
}

export function deletePage(path: string, slug: string): { ok: true } {
  const store = load(path)
  if (Object.hasOwn(store, slug)) {
    delete store[slug]
    saveJson(path, store)
  }
  return { ok: true }
}

function snippet(body: string, q: string, radius = 40): string {
  const idx = body.toLowerCase().indexOf(q.toLowerCase())
  if (idx === -1) return body.length > radius * 2 ? `${body.slice(0, radius * 2)}…` : body
  const start = Math.max(0, idx - radius)
  const end = Math.min(body.length, idx + q.length + radius)
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
}

export function searchPages(
  path: string,
  q: string,
): { slug: string; title: string; snippet: string }[] {
  const needle = q.toLowerCase()
  return Object.entries(load(path))
    .filter(
      ([, p]) => p.title.toLowerCase().includes(needle) || p.body.toLowerCase().includes(needle),
    )
    .map(([slug, p]) => ({ slug, title: p.title, snippet: snippet(p.body, q) }))
}
