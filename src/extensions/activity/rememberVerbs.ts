import {
  type CommandHandler,
  cliArgs,
  type ExtensionCaller,
  type ExtensionResult,
  failure,
  ok,
  parseFlags,
} from '@aurigax-ai/ostia-extension-sdk'
import { isRecordId, newRecordId } from './hookEvent'
import { keepsOnDisk } from './recorder'
import type { RememberStore } from './remember'
import { REMEMBER_OPEN_MAX, REMEMBER_TEXT_MAX, type RememberItem, startOf } from './rememberItem'
import { ageOf } from './view'

interface PaneSession {
  agent: string
  session: string
}

export interface RememberDeps {
  store: RememberStore
  now: () => number
  redact: (texts: string[]) => Promise<string[] | null>
  workspaceKind: (workspaceId: string) => Promise<string | null>
  paneSession: (paneId: string) => Promise<PaneSession | null>
  changed: () => void
}

const USAGE = 'remember "<task>"'

function withoutControls(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return out.replace(/\s+/g, ' ').trim()
}

function ageText(item: RememberItem, now: number): string {
  const age = ageOf(startOf(item), now)
  if (age.unit === 'now') return 'now'
  return `${age.count}${age.unit === 'minutes' ? 'm' : age.unit === 'hours' ? 'h' : 'd'}`
}

function ownPane(caller: ExtensionCaller): caller is ExtensionCaller & {
  paneId: string
  workspaceId: string
} {
  return caller.kind === 'pane' && !!caller.paneId && !!caller.workspaceId && !caller.manager
}

const NO_SESSION =
  'this pane has no agent session to remember for; remember needs an agent that reports its session'

export interface RememberVerbs {
  remember: CommandHandler
  list: (caller: ExtensionCaller, archived: boolean, json: boolean) => Promise<ExtensionResult>
  done: (id: string, caller: ExtensionCaller) => Promise<ExtensionResult | null>
}

export function rememberVerbs(deps: RememberDeps): RememberVerbs {
  const remember: CommandHandler = async (args, caller) => {
    if (!ownPane(caller)) {
      return failure('not-available', 'only an agent’s pane can remember a task')
    }
    const { rest } = parseFlags(cliArgs(args)?.argv ?? [], [], [])
    const odd = rest.find((arg) => arg.startsWith('--'))
    if (odd) return failure('usage', `unknown option ${odd}\nusage: ostia activity ${USAGE}`)
    const text = withoutControls(rest.join(' '))
    if (text === '') return failure('usage', `the task is missing\nusage: ostia activity ${USAGE}`)
    if ([...text].length > REMEMBER_TEXT_MAX) {
      return failure('too-long', `the task is longer than ${REMEMBER_TEXT_MAX} characters`)
    }
    const found = await deps.paneSession(caller.paneId).catch(() => null)
    if (!found) return failure('no-session', NO_SESSION)
    const workspaceId = caller.workspaceId
    const mine = deps.store
      .items(workspaceId)
      .filter((item) => item.state === 'open' && item.session === found.session)
    const clean = await deps.redact([text]).catch(() => null)
    const safe = clean?.[0]
    if (!safe) return failure('redaction-failed', 'the secret scan failed, so nothing was stored')
    const same = mine.find((item) => item.text === safe)
    if (same) return ok(`remembered ${same.id}`, { id: same.id })
    if (deps.store.openCount(workspaceId) >= REMEMBER_OPEN_MAX) {
      return failure('too-many', `there are already ${REMEMBER_OPEN_MAX} open items`)
    }
    const item: RememberItem = {
      v: 1,
      id: newRecordId(),
      t: deps.now(),
      pane: caller.paneId,
      session: found.session,
      agent: found.agent,
      text: safe,
      state: 'open',
    }
    const kind = await deps.workspaceKind(workspaceId).catch(() => null)
    deps.store.add(workspaceId, item, keepsOnDisk(caller, kind))
    deps.changed()
    return ok(`remembered ${item.id}`, { id: item.id })
  }

  const list = async (
    caller: ExtensionCaller,
    archived: boolean,
    json: boolean,
  ): Promise<ExtensionResult> => {
    if (!ownPane(caller)) {
      return failure('not-available', 'only an agent’s pane can list its remembered tasks')
    }
    const found = await deps.paneSession(caller.paneId).catch(() => null)
    if (!found) return failure('no-session', NO_SESSION)
    const wanted = archived ? 'archived' : 'open'
    const items = deps.store
      .items(caller.workspaceId)
      .filter((item) => item.session === found.session && item.state === wanted)
      .sort((a, b) => startOf(b) - startOf(a))
    if (json)
      return ok(
        undefined,
        items.map(({ id, t, text, state }) => ({ id, t, text, state })),
      )
    const now = deps.now()
    return ok(
      items.length > 0
        ? items.map((item) => `${item.id}\t${ageText(item, now)}\t${item.text}`).join('\n')
        : 'no entries',
    )
  }

  const done = async (id: string, caller: ExtensionCaller): Promise<ExtensionResult | null> => {
    if (!isRecordId(id) || !caller.workspaceId) return null
    const item = deps.store.find(caller.workspaceId, id)
    if (!item) return null
    if (!ownPane(caller)) {
      return failure('not-available', 'the human marks items done in the Activity panel')
    }
    const found = await deps.paneSession(caller.paneId).catch(() => null)
    if (item.pane !== caller.paneId && item.session !== found?.session) {
      return failure(
        'not-yours',
        'an agent finishes only its own remembered tasks; the human does the others in the Activity panel',
      )
    }
    deps.store.setState(caller.workspaceId, id, 'done', deps.now())
    deps.changed()
    return ok(`${id} done`)
  }

  return { remember, list, done }
}
