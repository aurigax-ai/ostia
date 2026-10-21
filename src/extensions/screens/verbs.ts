import {
  type CommandHandler,
  cliArgs,
  type ExtensionCaller,
  type ExtensionResult,
  failure,
  ok,
  type PhoneScreenReply,
  type SandboxDomainsResult,
  type Translate,
} from '@aurigax-ai/ostia-extension-sdk'
import type { CreateGate } from './createGate'
import type { OwnedScreen } from './screenRegistry'
import { MIN_SERVICE_VERSION, runScreens, type ScreensResult } from './screensCli'
import type { ScreensService } from './screensService'

type PhoneAsk = (request: {
  sessionId: string
  pane: string
  reason: string
  agent?: 'claude' | 'codex'
}) => Promise<PhoneScreenReply>

export interface VerbDeps {
  service: ScreensService
  gate: CreateGate
  translate: (locale?: string) => Translate
  installed: () => boolean
  sandboxDomains: (workspaceId: string) => Promise<SandboxDomainsResult>
  workspaceName: (workspaceId: string) => Promise<string>
  askPhone?: PhoneAsk
  agentOf: (paneId: string) => Promise<'claude' | 'codex' | undefined>
}

interface RelaySpec {
  values: string[]
  bools: string[]
  separator?: boolean
}

const SIZE_MIN = 64
const SIZE_MAX = 8192
const SCREEN_FLAG = 'screen'
const NUMBER = /^-\d+(\.\d+)?$/

const RELAY_VERBS: Record<string, RelaySpec> = {
  screenshot: { values: ['max-side'], bools: [] },
  click: { values: ['button', 'count', 'modifiers'], bools: ['down', 'up'] },
  move: { values: [], bools: [] },
  drag: { values: ['modifiers'], bools: [] },
  scroll: { values: ['modifiers'], bools: [] },
  type: { values: [], bools: [] },
  key: { values: ['repeat'], bools: [] },
  launch: { values: [], bools: [], separator: true },
  windows: { values: [], bools: [] },
  apps: { values: [], bools: [] },
  tree: { values: [], bools: [] },
}

type Parsed =
  | { ok: true; flags: Record<string, string[]>; bools: string[]; rest: string[]; tail: string[] }
  | { ok: false; message: string }

function parseArgs(argv: string[], values: string[], bools: string[], separator = false): Parsed {
  const flags: Record<string, string[]> = {}
  const seen: string[] = []
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      if (!separator) return { ok: false, message: '--' }
      return { ok: true, flags, bools: seen, rest, tail: argv.slice(i + 1) }
    }
    if (!arg.startsWith('-') || NUMBER.test(arg)) {
      rest.push(arg)
      continue
    }
    if (!arg.startsWith('--')) return { ok: false, message: arg }
    const name = arg.slice(2)
    if (values.includes(name) && i + 1 < argv.length) {
      flags[name] = [...(flags[name] ?? []), argv[++i]]
    } else if (bools.includes(name)) {
      seen.push(name)
    } else {
      return { ok: false, message: arg }
    }
  }
  return { ok: true, flags, bools: seen, rest, tail: [] }
}

function screensFailure(res: ScreensResult<unknown> & { ok: false }): ExtensionResult {
  return failure(res.code, res.message)
}

function sizeOf(raw: string[] | undefined): number | null | undefined {
  if (!raw) return undefined
  const value = Number(raw[raw.length - 1])
  return Number.isInteger(value) && value >= SIZE_MIN && value <= SIZE_MAX ? value : null
}

export function verbHandlers(deps: VerbDeps): Record<string, CommandHandler> {
  const t = (caller: ExtensionCaller): Translate => deps.translate(caller.locale)

  const notInstalled = (caller: ExtensionCaller): ExtensionResult | null =>
    deps.installed() ? null : failure('not-installed', t(caller)('verb.notInstalled'))

  const pick = (
    caller: ExtensionCaller,
    id: string | undefined,
  ): { ok: true; screen: OwnedScreen } | { ok: false; result: ExtensionResult } => {
    const workspaceId = caller.workspaceId ?? ''
    const mine = workspaceId ? deps.service.registry.inWorkspace(workspaceId) : []
    if (id) {
      const screen = mine.find((s) => s.id === id)
      return screen
        ? { ok: true, screen }
        : { ok: false, result: failure('refused', t(caller)('verb.notHere', { id })) }
    }
    if (mine.length === 1) return { ok: true, screen: mine[0] }
    if (mine.length === 0) {
      return { ok: false, result: failure('no-screen', t(caller)('verb.noScreen')) }
    }
    return {
      ok: false,
      result: failure(
        'ambiguous',
        t(caller)('verb.ambiguous', { ids: mine.map((s) => s.id).join(', ') }),
      ),
    }
  }

  const create: CommandHandler = async (args, caller) => {
    const tr = t(caller)
    const workspaceId = caller.workspaceId
    if (!workspaceId) return failure('no-workspace', tr('verb.noWorkspace'))
    const missing = notInstalled(caller)
    if (missing) return missing
    const outdated = await deps.service.outdatedVersion()
    if (outdated) {
      return failure(
        'outdated',
        tr('verb.outdated', { version: outdated, min: MIN_SERVICE_VERSION }),
      )
    }
    const parsed = parseArgs(cliArgs(args)?.argv ?? [], ['width', 'height', 'allow'], [])
    if (!parsed.ok || parsed.rest.length > 0) return failure('usage', tr('verb.createUsage'))
    const width = sizeOf(parsed.flags.width)
    const height = sizeOf(parsed.flags.height)
    if (width === null || height === null) return failure('usage', tr('verb.createUsage'))
    let allow = parsed.flags.allow ?? []
    if (caller.sandboxed) {
      if (allow.length > 0) return failure('usage', tr('verb.allowInSandbox'))
      const domains = await deps.sandboxDomains(workspaceId)
      if (!domains.ok) return failure('sandbox-domains', domains.message ?? domains.error)
      allow = domains.domains
    }
    if (caller.kind === 'pane') {
      const name = await deps.workspaceName(workspaceId)
      if (!(await deps.gate.allows(workspaceId, name, caller.locale))) {
        return failure('refused', tr('verb.createRefused'))
      }
    }
    const res = await deps.service.create({ workspaceId, allow, width, height })
    if (!res.ok) return screensFailure(res)
    const { id } = res.value
    return ok(tr('verb.created', { id, width: res.value.width, height: res.value.height }), {
      id,
      width: res.value.width,
      height: res.value.height,
    })
  }

  const token: CommandHandler = async (args, caller) => {
    if (caller.kind !== 'pane') return failure('refused', t(caller)('verb.tokenPanesOnly'))
    const chosen = pick(caller, cliArgs(args)?.argv[0])
    return chosen.ok ? ok(chosen.screen.agentToken) : chosen.result
  }

  const list: CommandHandler = async (_args, caller) => {
    const workspaceId = caller.workspaceId
    const screens = workspaceId ? await deps.service.shown(workspaceId) : []
    const text = screens
      .map((s) => `${s.id}\t${s.width}x${s.height}\t${s.owner}\t${s.state}`)
      .join('\n')
    return ok(text, { screens })
  }

  const stop: CommandHandler = async (args, caller) => {
    const chosen = pick(caller, cliArgs(args)?.argv[0])
    if (!chosen.ok) return chosen.result
    const res = await deps.service.stop(chosen.screen.id)
    return res.ok ? ok(t(caller)('verb.stopped', { id: res.value.id })) : screensFailure(res)
  }

  const relay =
    (verb: string, spec: RelaySpec): CommandHandler =>
    async (args, caller) => {
      const tr = t(caller)
      const parsed = parseArgs(
        cliArgs(args)?.argv ?? [],
        [SCREEN_FLAG, ...spec.values],
        spec.bools,
        spec.separator,
      )
      if (!parsed.ok) return failure('usage', tr('verb.badFlag', { flag: parsed.message }))
      if (spec.separator && parsed.tail.length === 0) {
        return failure('usage', tr('verb.launchUsage'))
      }
      const missing = notInstalled(caller)
      if (missing) return missing
      const chosen = pick(caller, parsed.flags[SCREEN_FLAG]?.at(-1))
      if (!chosen.ok) return chosen.result
      const forwarded = [verb, chosen.screen.id, ...parsed.rest]
      for (const name of spec.values) {
        for (const value of parsed.flags[name] ?? []) forwarded.push(`--${name}`, value)
      }
      for (const name of parsed.bools) forwarded.push(`--${name}`)
      if (spec.separator) forwarded.push('--', ...parsed.tail)
      const res = await runScreens<Record<string, unknown>>({
        args: forwarded,
        token: chosen.screen.agentToken,
      })
      if (!res.ok) return screensFailure(res)
      return Object.keys(res.value).length === 0 ? ok('ok') : ok(undefined, res.value)
    }

  const relayed = Object.fromEntries(
    Object.entries(RELAY_VERBS).map(([verb, spec]) => [verb, relay(verb, spec)]),
  )
  const askPhone: CommandHandler = async (args, caller) => {
    const tr = t(caller)
    if (caller.kind !== 'pane' || !caller.paneId || !caller.workspaceId) {
      return failure('refused', tr('verb.askPanesOnly'))
    }
    const parsed = parseArgs(cliArgs(args)?.argv ?? [], ['reason'], [])
    const reason = parsed.ok ? (parsed.flags.reason?.at(-1) ?? parsed.rest.join(' ')) : ''
    if (!reason.trim()) return failure('usage', tr('verb.askUsage'))
    if (!deps.askPhone) return failure('phone-off', tr('verb.askOff'))
    const agent = await deps.agentOf(caller.paneId)
    const res = await deps.askPhone({
      sessionId: caller.workspaceId,
      pane: caller.paneId,
      reason,
      ...(agent ? { agent } : {}),
    })
    if (!res.ok) return failure(res.error, res.message)
    const answer = res.data as { outcome?: string }
    if (answer.outcome === 'started') return ok(tr('verb.askStarted'), answer)
    if (answer.outcome === 'declined') {
      const why =
        (answer as { reason?: string }).reason === 'denied' ? 'verb.askDenied' : 'verb.askDeclined'
      return failure('declined', tr(why))
    }
    return failure('no-answer', tr('verb.askNoAnswer'))
  }

  return { create, token, list, stop, 'ask-phone': askPhone, ...relayed }
}
