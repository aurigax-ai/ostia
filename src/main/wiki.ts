/**
 * `wiki` toolbelt service (agent-toolbelt #6, capabilities 'wiki-read' (default — low-risk)
 * / 'wiki-write' (elevated)). A tiny slug → { title, body } knowledge base for agents,
 * isolated per project (default, scoped to the caller's session workDir, like `vault.ts`)
 * or globally to the machine.
 *
 * Scope resolution follows the same fail-closed shape as `vault.ts`: `jsonStore.storePath`
 * falls back to `process.cwd()` when handed an empty workDir, which would silently pool
 * every unrecognized session's project pages into one store. `project` scope therefore
 * requires a resolved session workDir up front (`no-project-workdir`); `global` scope is
 * unaffected (it never depends on a workDir).
 */
import { registerControlMethod } from './controlServer'
import { type StoreScope, loadJson, saveJson, storePath } from './jsonStore'
import { workDirForSession } from './sessionRegistry'

export interface WikiPage {
  title: string
  body: string
  updatedAt: string
}

/** slug → page */
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

/**
 * project = the caller's session workDir; global = the machine-wide store (see `jsonStore`).
 * Fails closed (returns `NoProjectWorkDir`) rather than letting `jsonStore.storePath` fall
 * back to `process.cwd()` for a session whose workDir isn't registered yet.
 */
function wikiStorePath(scope: StoreScope, sessionId: string): string | NoProjectWorkDir {
  if (scope === 'global') return storePath('wiki', 'global')
  const workDir = workDirForSession(sessionId)
  if (!workDir) return noProjectWorkDir()
  return storePath('wiki', 'project', workDir)
}

function loadWiki(path: string): WikiData {
  return loadJson<WikiData>(path, {})
}

function saveWiki(path: string, data: WikiData): void {
  saveJson(path, data)
}

/**
 * A short excerpt of `body` centered on the first case-insensitive occurrence of `q`, so
 * `wiki.search` results show *why* a page matched instead of just its title. Falls back to
 * the start of the body when `q` doesn't occur there (e.g. it only matched the title).
 */
function makeSnippet(body: string, q: string, radius = 40): string {
  const idx = body.toLowerCase().indexOf(q.toLowerCase())
  if (idx === -1) return body.length > radius * 2 ? `${body.slice(0, radius * 2)}…` : body
  const start = Math.max(0, idx - radius)
  const end = Math.min(body.length, idx + q.length + radius)
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
}

const NOT_FOUND = { ok: false, error: 'not-found' as const }

export function registerWikiMethods(): void {
  registerControlMethod('wiki.get', {
    cap: 'wiki-read',
    handler: (params, ctx) => {
      const { slug, scope } = (params ?? {}) as { slug: string; scope?: StoreScope }
      const path = wikiStorePath(scope ?? 'project', ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const page = loadWiki(path)[slug]
      if (!page) return NOT_FOUND
      return { slug, title: page.title, body: page.body, updatedAt: page.updatedAt }
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
      const path = wikiStorePath(scope ?? 'project', ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const store = loadWiki(path)
      store[slug] = { title: title ?? slug, body, updatedAt: new Date().toISOString() }
      saveWiki(path, store)
      return { ok: true }
    },
  })

  registerControlMethod('wiki.list', {
    cap: 'wiki-read',
    handler: (params, ctx) => {
      const { scope } = (params ?? {}) as { scope?: StoreScope }
      const path = wikiStorePath(scope ?? 'project', ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const store = loadWiki(path)
      const pages = Object.entries(store).map(([slug, p]) => ({
        slug,
        title: p.title,
        updatedAt: p.updatedAt,
      }))
      return { pages }
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
      const path = wikiStorePath(scope ?? 'project', ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const store = loadWiki(path)
      delete store[slug]
      saveWiki(path, store)
      return { ok: true }
    },
  })
}
