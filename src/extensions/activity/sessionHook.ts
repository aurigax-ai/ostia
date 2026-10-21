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

function eligible(caller: ExtensionCaller): caller is ExtensionCaller & { workspaceId: string } {
  return !caller.manager && caller.remote === undefined && caller.workspaceId !== undefined
}

export function sessionHook(deps: SessionHookDeps): CommandHandler {
  return (args, caller) => {
    const parsed = cliArgs(args)
    const [agent] = parsed?.argv ?? []
    const payload = payloadOf(parsed?.stdin)
    if (!agent || !payload || !eligible(caller)) return ok()
    const opened = agent === OPEN_AGENT
    if (!opened && !GIVEN_SOURCES.includes(payload.source)) return ok()
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
