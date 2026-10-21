import {
  type CommandHandler,
  cliArgs,
  type ExtensionCaller,
  ok,
} from '@aurigax-ai/ostia-extension-sdk'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { RememberStore } from './remember'
import { injectionOf } from './rememberInject'

const GIVEN_SOURCES = ['resume', 'compact', 'clear']
const OPEN_AGENT = 'agent'
const SESSION_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/

export interface SessionHookDeps {
  store: RememberStore
  paneSession: (paneId: string) => Promise<{ agent: string; session: string } | null>
  now: () => number
  days: () => number
  changed: () => void
}

function payloadOf(stdin: string | undefined): { session: string; source: string } | null {
  if (stdin === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stdin)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const { session_id: session, source } = parsed
  if (typeof session !== 'string' || !SESSION_PATTERN.test(session)) return null
  return { session, source: typeof source === 'string' ? source : '' }
}

const CLEAR_WAIT_MS = 300
const CLEAR_TRIES = 4

async function agreesWithMain(
  deps: SessionHookDeps,
  paneId: string,
  agent: string,
  payload: { session: string; source: string },
): Promise<boolean> {
  const tries = payload.source === 'clear' ? CLEAR_TRIES : 1
  for (let attempt = 0; attempt < tries; attempt++) {
    const known = await deps.paneSession(paneId).catch(() => null)
    if (!known) return true
    if (known.agent !== agent) return false
    if (known.session === payload.session) return true
    if (attempt + 1 < tries) await new Promise((resolve) => setTimeout(resolve, CLEAR_WAIT_MS))
  }
  return false
}

function eligible(caller: ExtensionCaller): caller is ExtensionCaller & { workspaceId: string } {
  return !caller.manager && caller.remote === undefined && caller.workspaceId !== undefined
}

export function sessionHook(deps: SessionHookDeps): CommandHandler {
  return async (args, caller) => {
    const parsed = cliArgs(args)
    const [agent] = parsed?.argv ?? []
    const payload = payloadOf(parsed?.stdin)
    if (!agent || !payload || !eligible(caller)) return ok()
    const opened = agent === OPEN_AGENT
    if (!opened && !GIVEN_SOURCES.includes(payload.source)) return ok()
    if (caller.paneId && !(await agreesWithMain(deps, caller.paneId, agent, payload))) return ok()
    if (payload.source === 'clear' && caller.paneId) {
      if (deps.store.adopt(caller.workspaceId, caller.paneId, agent, payload.session) > 0) {
        deps.changed()
      }
    }
    const items = deps.store.forSession(
      caller.workspaceId,
      payload.session,
      deps.now(),
      deps.days(),
    )
    const { text, count } = injectionOf(items, deps.now())
    return text ? ok(text, { count }) : ok()
  }
}
