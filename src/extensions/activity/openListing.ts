import type { OpenPane, OpenWorkspace } from './view'

export const LISTING_TTL_MS = 2000

interface Listing {
  workspaces: OpenWorkspace[]
  panes: OpenPane[]
  rev: number
}

interface OpenListingDeps {
  listWorkspaces: () => Promise<OpenWorkspace[] | null>
  listPanes: () => Promise<unknown>
  now: () => number
}

export interface OpenListing {
  read: (workspaceId: string) => Promise<Listing | null>
  invalidate: () => void
}

function listedPanes(raw: unknown): OpenPane[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p): p is OpenPane => typeof p?.paneId === 'string')
    .map((p) => ({
      paneId: p.paneId,
      ...(typeof p.agentState === 'string' ? { agentState: p.agentState } : {}),
      ...(typeof p.title === 'string' && p.title.trim() ? { title: p.title } : {}),
    }))
}

export function createOpenListing(deps: OpenListingDeps): OpenListing {
  let current: Listing | null = null
  let signature = ''
  let loadedAt = 0
  let stale = true
  let loading: Promise<Listing | null> | null = null

  const load = async (): Promise<Listing | null> => {
    stale = false
    try {
      const [workspaces, raw] = await Promise.all([deps.listWorkspaces(), deps.listPanes()])
      if (!workspaces) {
        stale = true
        return null
      }
      const panes = listedPanes(raw)
      const next = JSON.stringify([workspaces.map((w) => w.workspaceId), panes])
      const changed = next !== signature
      signature = next
      current = { workspaces, panes, rev: (current?.rev ?? 0) + (changed ? 1 : 0) }
      loadedAt = deps.now()
      return current
    } catch {
      stale = true
      return null
    }
  }

  const read = async (workspaceId: string): Promise<Listing | null> => {
    if (loading) await loading
    const fresh =
      current !== null &&
      !stale &&
      deps.now() - loadedAt < LISTING_TTL_MS &&
      current.workspaces.some((w) => w.workspaceId === workspaceId)
    if (fresh) return current
    loading = load().finally(() => {
      loading = null
    })
    return loading
  }

  return {
    read,
    invalidate: () => {
      stale = true
    },
  }
}
