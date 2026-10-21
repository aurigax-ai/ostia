import { globMatches } from '../../shared/browser/browseInput'
import {
  filterRequests,
  type NetworkFilter,
  summarizeRequest,
} from '../../shared/browser/browseNetwork'
import type { StorageArea } from '../../shared/browser/browseRuntime'
import type { BrowseState } from './browseGuests'
import { type BrowseMethod, fail, num, str, world } from './browseMethod'
import { clearStorage, listCookies, readWebStorage, writeCookie } from './browserStorage'
import { jsArgs } from './browseWorld'
import {
  clearRequestLog,
  type PausedReply,
  type PausedRequest,
  requestsFor,
  setGuestRoutes,
} from './guestNetwork'

function jsonContentType(body: string): string {
  try {
    JSON.parse(body)
    return 'application/json'
  } catch {
    return 'text/plain'
  }
}

function routeReply(
  guestRoutes: BrowseState['guestRoutes'],
  wcId: number,
  paused: PausedRequest,
): PausedReply | null {
  const route = [...(guestRoutes.get(wcId) ?? [])]
    .reverse()
    .find((r) => globMatches(r.pattern, paused.request.url))
  if (!route) return null
  if (route.abort) {
    return {
      method: 'Fetch.failRequest',
      params: { requestId: paused.requestId, errorReason: 'BlockedByClient' },
    }
  }
  if (route.body === undefined) return null
  return {
    method: 'Fetch.fulfillRequest',
    params: {
      requestId: paused.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: jsonContentType(route.body) }],
      body: Buffer.from(route.body).toString('base64'),
    },
  }
}

async function applyRoutes(
  guestRoutes: BrowseState['guestRoutes'],
  guest: Electron.WebContents,
): Promise<void> {
  const routes = guestRoutes.get(guest.id) ?? []
  const wcId = guest.id
  if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
  await setGuestRoutes(
    guest,
    routes.map((r) => r.pattern),
    routes.length === 0 ? null : (paused) => routeReply(guestRoutes, wcId, paused),
  )
}

interface StateDeps {
  method: BrowseMethod
  state: BrowseState
}

export function registerBrowseStateMethods(deps: StateDeps): void {
  const { method } = deps
  const { guestRoutes } = deps.state

  method('cookies', async (guest, p) => {
    switch (p.sub ?? 'get') {
      case 'get': {
        const url = str(p.url)
        return { ok: true, cookies: await listCookies(guest, url ? { url } : {}) }
      }
      case 'set': {
        const name = str(p.name)
        if (!name) return fail('name-required')
        const url = str(p.url) ?? guest.getURL()
        const domain = str(p.domain)
        const host = (() => {
          try {
            return new URL(url).hostname
          } catch {
            return ''
          }
        })()
        if (!domain && !host) return fail('url-required')
        const sameSite = str(p.sameSite)?.toLowerCase()
        await writeCookie(guest, {
          name,
          value: str(p.value) ?? '',
          domain: domain ?? host,
          path: str(p.path) ?? '/',
          hostOnly: domain === undefined,
          expires: num(p.expires) ?? null,
          httpOnly: p.httpOnly === true,
          secure: p.secure === true || url.startsWith('https:'),
          sameSite:
            sameSite === 'strict' || sameSite === 'lax'
              ? sameSite
              : sameSite === 'none'
                ? 'no_restriction'
                : 'unspecified',
        })
        return { ok: true }
      }
      case 'clear':
        return clearStorage(guest, 'cookies')
      default:
        return fail('bad-sub', String(p.sub))
    }
  })

  method('storage', async (guest, p) => {
    const area = p.area
    if (area !== 'local' && area !== 'session') return fail('bad-area', String(area))
    switch (p.sub ?? 'get') {
      case 'get': {
        const dump = await readWebStorage(guest)
        const values = area === 'local' ? dump.local : dump.session
        const key = str(p.key)
        if (key === undefined) return { ok: true, origin: dump.origin, values }
        return { ok: true, key, value: key in values ? values[key] : null }
      }
      case 'set': {
        const key = str(p.key)
        if (!key) return fail('key-required')
        return world(guest, `setStorage(${jsArgs(area as StorageArea, key, str(p.value) ?? '')})`)
      }
      case 'clear':
        return world(guest, `clearStorage(${jsArgs(area)})`)
      default:
        return fail('bad-sub', String(p.sub))
    }
  })

  method('network', async (guest, p) => {
    switch (p.sub) {
      case 'requests': {
        if (p.clear === true) {
          clearRequestLog(guest.id)
          return { ok: true }
        }
        const filter: NetworkFilter = {
          filter: str(p.filter),
          types: Array.isArray(p.types) ? p.types.map(String) : undefined,
          method: str(p.method),
          status: str(p.status),
        }
        return {
          ok: true,
          requests: filterRequests(requestsFor(guest.id), filter).map(summarizeRequest),
        }
      }
      case 'request': {
        const id = str(p.requestId)
        const found = requestsFor(guest.id).find((r) => r.requestId === id)
        return found ? { ok: true, request: found } : fail('not-found', id)
      }
      case 'route': {
        const pattern = str(p.url)
        if (!pattern) return fail('url-required')
        const routes = (guestRoutes.get(guest.id) ?? []).filter((r) => r.pattern !== pattern)
        routes.push({ pattern, abort: p.abort === true, body: str(p.body) })
        guestRoutes.set(guest.id, routes)
        await applyRoutes(guestRoutes, guest)
        return { ok: true, routes: routes.map((r) => r.pattern) }
      }
      case 'unroute': {
        const pattern = str(p.url)
        const routes = pattern
          ? (guestRoutes.get(guest.id) ?? []).filter((r) => r.pattern !== pattern)
          : []
        guestRoutes.set(guest.id, routes)
        await applyRoutes(guestRoutes, guest)
        return { ok: true, routes: routes.map((r) => r.pattern) }
      }
      default:
        return fail('bad-sub', String(p.sub))
    }
  })
}
