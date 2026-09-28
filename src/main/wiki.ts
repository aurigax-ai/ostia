import { ipcMain } from 'electron'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { Capability } from '../shared/capabilities'
import { hasDangerousSegment } from '../shared/protoGuard'
import type { WikiFailure, WikiPage as WikiPageDTO, WikiPageSummary } from '../shared/types'
import { connHasCap } from './controlAuth'
import { registerControlMethod } from './controlServer'
import { type StoreScope, loadJson, saveJson, storePath } from './jsonStore'
import { workDirForSession } from './sessionRegistry'

function needsElevation(cap: Capability): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, `needs-elevation: ${cap}`)
}

const MAX_BODY_BYTES = 256 * 1024
const MAX_PAGES = 2000

export interface WikiPage {
  title: string
  body: string
  updatedAt: string
}

type WikiData = Record<string, WikiPage>

interface NoProjectWorkDir {
  ok: false
  error: 'no-project-workdir'
  message: string
}

function noProjectWorkDir(): NoProjectWorkDir {
  return {
    ok: false,
    error: 'no-project-workdir',
    message:
      'no project workDir is known for this session yet, so a project-scoped wiki would ' +
      "collapse into a shared default — pass `--global`, or retry once the pane's project " +
      'is resolved.',
  }
}

function wikiStorePathCore(
  scope: StoreScope,
  workDir: string | undefined,
): string | NoProjectWorkDir {
  if (scope === 'global') return storePath('wiki', 'global')
  if (!workDir) return noProjectWorkDir()
  return storePath('wiki', 'project', workDir)
}

function wikiStorePath(scope: StoreScope, sessionId: string): string | NoProjectWorkDir {
  return wikiStorePathCore(scope, scope === 'global' ? undefined : workDirForSession(sessionId))
}

function loadWiki(path: string): WikiData {
  return loadJson<WikiData>(path, {})
}

function saveWiki(path: string, data: WikiData): void {
  saveJson(path, data)
}

function makeSnippet(body: string, q: string, radius = 40): string {
  const idx = body.toLowerCase().indexOf(q.toLowerCase())
  if (idx === -1) return body.length > radius * 2 ? `${body.slice(0, radius * 2)}…` : body
  const start = Math.max(0, idx - radius)
  const end = Math.min(body.length, idx + q.length + radius)
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
}

const NOT_FOUND = { ok: false, error: 'not-found' } as const
const INVALID_SLUG = { ok: false, error: 'invalid-slug' } as const
const TOO_LARGE = { ok: false, error: 'too-large' } as const
const TOO_MANY_PAGES = {
  ok: false,
  error: 'too-many-pages',
  message: `this scope already has ${MAX_PAGES} pages — delete one before adding another`,
} as const

function getPageAt(path: string, slug: string): WikiPageDTO | typeof NOT_FOUND {
  const page = loadWiki(path)[slug]
  if (!page) return NOT_FOUND
  return { slug, title: page.title, body: page.body, updatedAt: page.updatedAt }
}

function listPagesAt(path: string): { pages: WikiPageSummary[] } {
  const store = loadWiki(path)
  const pages = Object.entries(store).map(([slug, p]) => ({
    slug,
    title: p.title,
    updatedAt: p.updatedAt,
  }))
  return { pages }
}

function setPageAt(
  path: string,
  slug: string,
  body: string,
  title: string | undefined,
): { ok: true } | typeof INVALID_SLUG | typeof TOO_LARGE | typeof TOO_MANY_PAGES {
  if (hasDangerousSegment(slug)) return INVALID_SLUG
  if (Buffer.byteLength(body ?? '', 'utf8') > MAX_BODY_BYTES) return TOO_LARGE
  const store = loadWiki(path)
  if (!Object.hasOwn(store, slug) && Object.keys(store).length >= MAX_PAGES) {
    return TOO_MANY_PAGES
  }
  store[slug] = { title: title ?? slug, body, updatedAt: new Date().toISOString() }
  saveWiki(path, store)
  return { ok: true }
}

export function wikiGetForWorkDir(
  slug: string,
  scope: StoreScope,
  workDir: string | undefined,
): WikiPageDTO | WikiFailure {
  const path = wikiStorePathCore(scope, workDir)
  if (typeof path !== 'string') return path
  return getPageAt(path, slug)
}

export function wikiListForWorkDir(
  scope: StoreScope,
  workDir: string | undefined,
): { pages: WikiPageSummary[] } | WikiFailure {
  const path = wikiStorePathCore(scope, workDir)
  if (typeof path !== 'string') return path
  return listPagesAt(path)
}

export function wikiSetForWorkDir(
  slug: string,
  body: string,
  title: string | undefined,
  scope: StoreScope,
  workDir: string | undefined,
): { ok: true } | WikiFailure {
  const path = wikiStorePathCore(scope, workDir)
  if (typeof path !== 'string') return path
  return setPageAt(path, slug, body, title)
}

export function registerWikiIpc(): void {
  ipcMain.handle('wiki:list', (_e, params: { scope?: StoreScope; workDir?: string }) =>
    wikiListForWorkDir(params?.scope ?? 'project', params?.workDir),
  )
  ipcMain.handle('wiki:get', (_e, params: { slug: string; scope?: StoreScope; workDir?: string }) =>
    wikiGetForWorkDir(params?.slug, params?.scope ?? 'project', params?.workDir),
  )
  ipcMain.handle(
    'wiki:set',
    (
      _e,
      params: { slug: string; body: string; title?: string; scope?: StoreScope; workDir?: string },
    ) =>
      wikiSetForWorkDir(
        params?.slug,
        params?.body,
        params?.title,
        params?.scope ?? 'project',
        params?.workDir,
      ),
  )
}

export function registerWikiMethods(): void {
  registerControlMethod('wiki.get', {
    cap: 'wiki-read',
    handler: (params, ctx) => {
      const { slug, scope } = (params ?? {}) as { slug: string; scope?: StoreScope }
      const path = wikiStorePath(scope ?? 'project', ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      return getPageAt(path, slug)
    },
  })

  registerControlMethod('wiki.set', {
    cap: 'wiki-write',
    handler: (params, ctx) => {
      const { slug, body, title, scope } = (params ?? {}) as {
        slug: string
        body: string
        title?: string
        scope?: StoreScope
      }
      if (hasDangerousSegment(slug)) return INVALID_SLUG
      const resolvedScope = scope ?? 'project'
      if (resolvedScope === 'global' && !connHasCap(ctx.authed, 'workspace-wide')) {
        throw needsElevation('workspace-wide')
      }
      const path = wikiStorePath(resolvedScope, ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      return setPageAt(path, slug, body, title)
    },
  })

  registerControlMethod('wiki.list', {
    cap: 'wiki-read',
    handler: (params, ctx) => {
      const { scope } = (params ?? {}) as { scope?: StoreScope }
      const path = wikiStorePath(scope ?? 'project', ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      return listPagesAt(path)
    },
  })

  registerControlMethod('wiki.search', {
    cap: 'wiki-read',
    handler: (params, ctx) => {
      const { q, scope } = (params ?? {}) as { q: string; scope?: StoreScope }
      const path = wikiStorePath(scope ?? 'project', ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const store = loadWiki(path)
      const needle = q.toLowerCase()
      const matches = Object.entries(store)
        .filter(
          ([, p]) =>
            p.title.toLowerCase().includes(needle) || p.body.toLowerCase().includes(needle),
        )
        .map(([slug, p]) => ({ slug, title: p.title, snippet: makeSnippet(p.body, q) }))
      return { matches }
    },
  })

  registerControlMethod('wiki.delete', {
    cap: 'wiki-write',
    handler: (params, ctx) => {
      const { slug, scope } = (params ?? {}) as { slug: string; scope?: StoreScope }
      const resolvedScope = scope ?? 'project'
      if (resolvedScope === 'global' && !connHasCap(ctx.authed, 'workspace-wide')) {
        throw needsElevation('workspace-wide')
      }
      const path = wikiStorePath(resolvedScope, ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const store = loadWiki(path)
      delete store[slug]
      saveWiki(path, store)
      return { ok: true }
    },
  })
}
