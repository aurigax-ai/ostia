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
const CONFIRM_MS = 20_000
const CONFIRM_POLL_MS = 500

export interface HandoffDeps {
  ext: Pick<
    OstiaExtension,
    'listPanes' | 'listWorkspaces' | 'runAgent' | 'exec' | 'requireCallerCaps' | 'playbookEnabled'
  >
  tickets: Tickets
  projectsDir: string
  confirmMs?: number
  pollMs?: number
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
  return who.workDir === '' ? [] : [who.workDir]
}

async function reachAll(deps: HandoffDeps, who: Acting): Promise<ExtensionResult | null> {
  const res = await deps.ext.requireCallerCaps(
    who.paneId,
    ['all-workspaces'],
    'read the sessions of every project',
  )
  return res.ok ? null : failure(res.error, res.message)
}

async function confirmStarted(
  deps: HandoffDeps,
  ticketId: string,
  paneId: string,
): Promise<'the new session read its steps' | 'the agent is running' | null> {
  const until = Date.now() + (deps.confirmMs ?? CONFIRM_MS)
  for (;;) {
    if (deps.tickets.isClaimed(ticketId)) return 'the new session read its steps'
    const panes = await deps.ext.listPanes().catch((): PaneInfo[] => [])
    if (panes.find((p) => p.paneId === paneId)?.agentSessionId) return 'the agent is running'
    if (Date.now() >= until) return null
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? CONFIRM_POLL_MS))
  }
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
    const seen = await confirmStarted(deps, ticket.id, started.paneId)
    const where = `${ticket.id} → ${started.paneId.slice(0, 8)}`
    if (seen === null) {
      return failure(
        'not-confirmed',
        `handoff ${where}: the new tab started no agent session within ${CONFIRM_MS / 1000} s; check that ${pane.agent} runs there and the agent hooks are on. The ticket stays valid for 10 minutes.`,
      )
    }
    return ok(`handoff ${where} started (${seen}); this session is unchanged`)
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
    const files = parsed.all ? listSessions(deps.projectsDir, 'all') : sessionsInScope(deps, who)
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

function sessionsInScope(deps: HandoffDeps, who: Acting): SessionFile[] {
  const files = listSessions(deps.projectsDir, foldersOf(who))
  const callerSession = deps.tickets.claimedBy(who.paneId)?.sessionId
  if (!callerSession || files.some((f) => f.id === callerSession)) return files
  return [
    ...files,
    ...sessionsByPrefix(deps.projectsDir, callerSession).filter((f) => f.id === callerSession),
  ]
}

async function resolveSessions(
  deps: HandoffDeps,
  who: Acting,
  prefixes: readonly string[],
  all: boolean,
): Promise<SessionFile[] | ExtensionResult> {
  const inScope = sessionsInScope(deps, who)
  const near = (prefix: string): SessionFile[] => inScope.filter((s) => s.id.startsWith(prefix))
  const outside = prefixes.filter((prefix) => near(prefix).length === 0)
  if (outside.length > 0) {
    if (!all) {
      return failure(
        'unknown-session',
        `no session ${outside[0]} in this folder; --all searches every project`,
      )
    }
    const denied = await reachAll(deps, who)
    if (denied) return denied
  }
  const chosen = new Map<string, SessionFile>()
  for (const prefix of prefixes) {
    const found = outside.includes(prefix)
      ? sessionsByPrefix(deps.projectsDir, prefix)
      : near(prefix)
    if (found.length === 0) return failure('unknown-session', `no session ${prefix}`)
    const exact = found.filter((s) => s.id === prefix)
    const candidates = exact.length === 1 ? exact : found
    if (candidates.length > 1) {
      return failure(
        'ambiguous-session',
        `${prefix} matches ${candidates.map((c) => c.id).join(', ')}; give more characters`,
      )
    }
    chosen.set(candidates[0].path, candidates[0])
  }
  return [...chosen.values()].sort((a, b) => a.modified - b.modified)
}
