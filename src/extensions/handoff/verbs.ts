import {
  type CommandHandler,
  cliArgs,
  type ExtensionCaller,
  type ExtensionResult,
  failure,
  type OstiaExtension,
  ok,
  type PaneInfo,
  parseFlags,
} from '@aurigax-ai/ostia-extension-sdk'
import { findLines } from './findSessions'
import { type GatherExec, gather } from './gather'
import { intakeText, startPrompt } from './procedure'
import { listSessions, SESSION_ID_PREFIX, type SessionFile, sessionsByPrefix } from './sessionFiles'
import type { Tickets } from './tickets'
import { capTimelines, timelineOf } from './timeline'
import { cleanTopic, searchWords } from './words'

const USAGE = {
  start: 'start "<topic>"',
  intake: 'intake <ticket>',
  find: 'find "<words>" [--all]',
  timeline: 'timeline <session-id>... [--all]',
  gather: 'gather "<words>"',
} as const

const PLAYBOOK_OFF = 'turn on the handoff playbook in Settings › Agents › Playbooks'
const SESSIONS_FOR_AGENT = 'claude'

export interface HandoffDeps {
  ext: Pick<
    OstiaExtension,
    'listPanes' | 'listWorkspaces' | 'runAgent' | 'exec' | 'requireCallerCaps' | 'playbookEnabled'
  >
  tickets: Tickets
  projectsDir: string
}

interface Acting {
  paneId: string
  workspaceId: string
  workDir: string
  cwd: string
}

function usage(verb: keyof typeof USAGE, problem?: string): ExtensionResult {
  const text = `usage: ostia handoff ${USAGE[verb]}`
  return failure('usage', problem ? `${problem}\n${text}` : text)
}

function allFlag(
  verb: 'find' | 'timeline',
  args: unknown,
): { all: boolean; rest: string[] } | ExtensionResult {
  const { bools, rest } = parseFlags(cliArgs(args)?.argv ?? [], [], ['all'])
  const odd = rest.find((a) => a.startsWith('--'))
  return odd ? usage(verb, `unknown option ${odd}`) : { all: bools.has('all'), rest }
}

function refusal(caller: ExtensionCaller): ExtensionResult | null {
  if (caller.sandboxed) return failure('sandboxed', 'a sandboxed workspace cannot hand off')
  if (caller.manager) return failure('manager', 'the manager pane cannot hand off')
  if (caller.remote) return failure('remote', 'a remote folder cannot hand off')
  return null
}

async function scratchWorkspace(deps: HandoffDeps, workspaceId: string): Promise<boolean> {
  const workspaces = await deps.ext.listWorkspaces().catch(() => [])
  return workspaces.find((w) => w.workspaceId === workspaceId)?.kind === 'scratch'
}

async function acting(
  deps: HandoffDeps,
  caller: ExtensionCaller,
  allowUser: boolean,
): Promise<Acting | ExtensionResult> {
  if (!(await deps.ext.playbookEnabled())) return failure('playbook-off', PLAYBOOK_OFF)
  const fromPane = caller.kind === 'pane' || (allowUser && caller.kind === 'user')
  if (!fromPane || !caller.paneId || !caller.workspaceId) {
    return failure('not-available', 'only an agent pane can do this')
  }
  const refused = refusal(caller)
  if (refused) return refused
  if (await scratchWorkspace(deps, caller.workspaceId)) {
    return failure('scratch', 'a scratch workspace cannot hand off')
  }
  const workDir = caller.workDir ?? caller.cwd ?? ''
  return {
    paneId: caller.paneId,
    workspaceId: caller.workspaceId,
    workDir,
    cwd: caller.cwd ?? workDir,
  }
}

function isActing(value: Acting | ExtensionResult): value is Acting {
  return 'paneId' in value
}

function foldersOf(who: Acting): string[] {
  return [...new Set([who.workDir, who.cwd].filter((f) => f !== ''))]
}

async function reachAll(deps: HandoffDeps, who: Acting): Promise<ExtensionResult | null> {
  const res = await deps.ext.requireCallerCaps(
    who.paneId,
    ['all-workspaces'],
    'read the sessions of every project',
  )
  return res.ok ? null : failure(res.error, res.message)
}

export function handoffVerbs(deps: HandoffDeps): Record<string, CommandHandler> {
  const start: CommandHandler = async (args, caller) => {
    const who = await acting(deps, caller, true)
    if (!isActing(who)) return who
    const topic = cleanTopic(cliArgs(args)?.argv ?? [])
    if (topic === '') return usage('start', 'the topic is missing')
    const panes = await deps.ext.listPanes().catch((): PaneInfo[] => [])
    const pane = panes.find((p) => p.paneId === who.paneId)
    if (!pane || pane.kind === 'manager' || !pane.agent || !pane.agentSessionId) {
      return failure('no-session', 'this pane has no agent session; the agent hooks may be off')
    }
    if (pane.agent !== SESSIONS_FOR_AGENT) {
      return failure(
        'unsupported-agent',
        `handoff reads ${SESSIONS_FOR_AGENT} sessions only so far`,
      )
    }
    const ticket = deps.tickets.create({
      topic,
      agent: pane.agent,
      sessionId: pane.agentSessionId,
      cwd: who.cwd,
      workDir: who.workDir,
      workspaceId: who.workspaceId,
    })
    const started = await deps.ext.runAgent({
      workspaceId: who.workspaceId,
      agent: pane.agent,
      prompt: startPrompt(ticket.id),
      afterPaneId: who.paneId,
    })
    if (!started.ok) {
      deps.tickets.drop(ticket.id)
      return failure('not-started', started.message ?? started.error)
    }
    deps.tickets.opened(ticket.id, started.paneId)
    return ok(
      `handoff ${ticket.id} → ${started.paneId.slice(0, 8)} started; this session is unchanged`,
    )
  }

  const intake: CommandHandler = async (args, caller) => {
    const who = await acting(deps, caller, false)
    if (!isActing(who)) return who
    const [id, extra] = cliArgs(args)?.argv ?? []
    if (!id || extra !== undefined) return usage('intake')
    const claimed = await deps.tickets.claim(id, who.paneId)
    if (!claimed.ok) return failure(claimed.error, CLAIM_MESSAGES[claimed.error])
    return ok(intakeText(claimed.ticket, who.workDir))
  }

  const find: CommandHandler = async (args, caller) => {
    const who = await acting(deps, caller, false)
    if (!isActing(who)) return who
    const parsed = allFlag('find', args)
    if ('ok' in parsed) return parsed
    const terms = searchWords(parsed.rest)
    if (terms.length === 0) return usage('find', 'the words are missing')
    if (parsed.all) {
      const denied = await reachAll(deps, who)
      if (denied) return denied
    }
    const files = listSessions(deps.projectsDir, parsed.all ? 'all' : foldersOf(who))
    const lines = findLines(files, terms, deps.tickets.claimedBy(who.paneId)?.sessionId ?? null)
    return ok(lines.length > 0 ? lines.join('\n') : 'no session mentions those words')
  }

  const timeline: CommandHandler = async (args, caller) => {
    const who = await acting(deps, caller, false)
    if (!isActing(who)) return who
    const parsed = allFlag('timeline', args)
    if ('ok' in parsed) return parsed
    if (parsed.rest.length === 0 || !parsed.rest.every((id) => SESSION_ID_PREFIX.test(id))) {
      return usage('timeline', 'session ids are 4 or more hex characters')
    }
    const chosen = await resolveSessions(deps, who, parsed.rest, parsed.all)
    if ('ok' in chosen) return chosen
    return ok(capTimelines(chosen.map((file) => timelineOf(file).join('\n'))))
  }

  const gatherVerb: CommandHandler = async (args, caller) => {
    const who = await acting(deps, caller, false)
    if (!isActing(who)) return who
    const words = searchWords(cliArgs(args)?.argv ?? [])
    if (words.length === 0) return usage('gather', 'the words are missing')
    const exec: GatherExec = (opts) => deps.ext.exec(opts)
    return ok(await gather(exec, who.workspaceId, words))
  }

  return { start, intake, find, timeline, gather: gatherVerb }
}

const CLAIM_MESSAGES = {
  'unknown-ticket': 'no such handoff ticket',
  'expired-ticket': 'the ticket expired; ask the human to run /handoff again',
  'claimed-ticket': 'this ticket was already used',
  'wrong-pane': 'this ticket belongs to the session it opened',
} as const

async function resolveSessions(
  deps: HandoffDeps,
  who: Acting,
  prefixes: readonly string[],
  all: boolean,
): Promise<SessionFile[] | ExtensionResult> {
  const inScope = new Set(listSessions(deps.projectsDir, foldersOf(who)).map((s) => s.path))
  const chosen = new Map<string, SessionFile>()
  let outside = false
  for (const prefix of prefixes) {
    const found = sessionsByPrefix(deps.projectsDir, prefix)
    if (found.length === 0) return failure('unknown-session', `no session ${prefix}`)
    const near = found.filter((s) => inScope.has(s.path))
    const pick = near[0] ?? found[0]
    if (!inScope.has(pick.path)) outside = true
    chosen.set(pick.path, pick)
  }
  if (outside) {
    if (!all) return failure('other-project', 'that session is in another project; add --all')
    const denied = await reachAll(deps, who)
    if (denied) return denied
  }
  return [...chosen.values()].sort((a, b) => a.modified - b.modified)
}
