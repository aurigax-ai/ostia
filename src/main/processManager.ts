import { isAbsolute } from 'node:path'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import { MANAGER_AGENT_NAME } from '../shared/managerSettings'
import { PRODUCT_DISPLAY_NAME } from '../shared/productDisplay'
import { quoteArgv } from '../shared/shellQuote'
import { connHasCap } from './controlAuth'
import { ensureCaps } from './controlElevation'
import {
  type ControlMethodContext,
  registerControlMethod,
  registerTargetableMethod,
} from './controlServer'
import type { TerminalOpenRequest } from './extensionHost'
import { getByPaneId, resolveExternal } from './idRegistry'
import { PromptMarkScanner, plainTerminalText } from './terminalText'

export const PROCESS_COMMAND_MAX = 8 * 1024
export const PROCESS_NAME_MAX = 60
export const INTERRUPT_GRACE_MS = 3000
const INTERRUPT = '\x03'
const COMMAND_START = 'C'
const COMMAND_END = 'D'

export type ProcessStatus = 'starting' | 'running' | 'exited' | 'closed'

export interface RingSlice {
  data: string
  cursor: number
  dropped: boolean
}

export type RingReader = (from: number) => RingSlice

export interface ProcessEntry {
  id: string
  name: string
  cmd: string
  cwd: string | undefined
  workspaceId: string
  ownerPaneId: string
  paneId: string
  externalPaneId: string
  startedAt: string
  status: ProcessStatus
  exitCode?: number
  outputStart?: number
  outputEnd?: number
}

export interface ProcessInfo {
  id: string
  name: string
  cmd: string
  cwd: string | undefined
  status: ProcessStatus
  exitCode: number | undefined
  paneId: string
  startedAt: string
}

export interface ProcessOutput {
  data: string
  cursor: number
  dropped: boolean
}

export interface NewProcess {
  name: string
  cmd: string
  cwd: string | undefined
  workspaceId: string
  ownerPaneId: string
  paneId: string
  externalPaneId: string
}

export interface RegistryDeps {
  ring: (paneId: string) => RingReader | undefined
  workspaceOfPane: (paneId: string) => string | undefined
  now: () => Date
  onChange?: (entry: ProcessEntry) => void
}

export interface KeptProcess extends NewProcess {
  startedAt: string
  status: 'starting' | 'running' | 'exited'
  exitCode?: number
}

interface Tracking {
  scanner: PromptMarkScanner
  waiters: Set<() => void>
}

function exitCodeOf(arg: string | undefined): number | undefined {
  if (arg === undefined || arg === '') return undefined
  const code = Number(arg)
  return Number.isInteger(code) ? code : undefined
}

function sliceFrom(frozen: RingSlice, from: number): RingSlice {
  const start = frozen.cursor - frozen.data.length
  return {
    data: frozen.data.slice(Math.max(0, from - start)),
    cursor: frozen.cursor,
    dropped: from < start,
  }
}

export class ProcessRegistry {
  private readonly entries = new Map<string, ProcessEntry>()
  private readonly tracked = new Map<string, Tracking>()
  private readonly byPane = new Map<string, ProcessEntry>()
  private readonly frozen = new Map<string, RingSlice>()
  private counter = 0

  constructor(private readonly deps: RegistryDeps) {}

  add(input: NewProcess): ProcessEntry {
    const id = `proc-${++this.counter}`
    const entry: ProcessEntry = {
      id,
      name: input.name,
      cmd: input.cmd,
      cwd: input.cwd,
      workspaceId: input.workspaceId,
      ownerPaneId: input.ownerPaneId,
      paneId: input.paneId,
      externalPaneId: input.externalPaneId,
      startedAt: this.deps.now().toISOString(),
      status: 'starting',
    }
    this.entries.set(id, entry)
    this.byPane.set(entry.paneId, entry)
    this.track(entry)
    this.deps.onChange?.(entry)
    return entry
  }

  adopt(kept: KeptProcess, cursor: number): ProcessEntry {
    const id = `proc-${++this.counter}`
    const entry: ProcessEntry = {
      id,
      name: kept.name,
      cmd: kept.cmd,
      cwd: kept.cwd,
      workspaceId: kept.workspaceId,
      ownerPaneId: kept.ownerPaneId,
      paneId: kept.paneId,
      externalPaneId: kept.externalPaneId,
      startedAt: kept.startedAt,
      status: kept.status,
      ...(kept.exitCode !== undefined ? { exitCode: kept.exitCode } : {}),
      outputStart: cursor,
    }
    this.entries.set(id, entry)
    this.byPane.set(entry.paneId, entry)
    if (entry.status !== 'exited') this.track(entry)
    return entry
  }

  forPane(paneId: string): ProcessEntry | undefined {
    return this.byPane.get(paneId)
  }

  feed(paneId: string, data: string, endCursor: number): void {
    const tracking = this.tracked.get(paneId)
    const entry = this.byPane.get(paneId)
    if (!tracking || !entry) return
    for (const mark of tracking.scanner.scan(data, endCursor)) {
      if (mark.kind === COMMAND_START && entry.status === 'starting') {
        entry.status = 'running'
        entry.outputStart = mark.end
        this.deps.onChange?.(entry)
      } else if (mark.kind === COMMAND_END && entry.status === 'running') {
        this.finish(entry, mark.start, exitCodeOf(mark.arg))
        return
      }
    }
  }

  shellEnded(paneId: string, ring: RingReader): void {
    const entry = this.byPane.get(paneId)
    if (!entry || entry.status === 'closed') return
    const from = entry.outputStart
    if (from !== undefined && !this.frozen.has(entry.id)) {
      const slice = ring(from)
      const end = entry.outputEnd ?? slice.cursor
      const keep = Math.max(0, slice.data.length - (slice.cursor - end))
      this.frozen.set(entry.id, { ...slice, data: slice.data.slice(0, keep), cursor: end })
    }
    if (entry.status === 'starting' || entry.status === 'running') {
      this.finish(entry, this.frozen.get(entry.id)?.cursor ?? 0, undefined)
    }
  }

  paneClosed(paneId: string): void {
    const entry = this.byPane.get(paneId)
    if (!entry) return
    this.release(entry)
    this.byPane.delete(paneId)
    this.frozen.delete(entry.id)
    entry.status = 'closed'
  }

  workspaceClosed(workspaceId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (this.workspaceOf(entry) !== workspaceId) continue
      this.release(entry)
      this.byPane.delete(entry.paneId)
      this.frozen.delete(entry.id)
      this.entries.delete(entry.id)
    }
  }

  rerun(entry: ProcessEntry): void {
    this.release(entry)
    this.frozen.delete(entry.id)
    entry.status = 'starting'
    entry.exitCode = undefined
    entry.outputStart = undefined
    entry.outputEnd = undefined
    entry.startedAt = this.deps.now().toISOString()
    this.track(entry)
  }

  waitForExit(entry: ProcessEntry, timeoutMs: number): Promise<boolean> {
    const tracking = this.tracked.get(entry.paneId)
    if (!tracking || this.byPane.get(entry.paneId) !== entry) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        tracking.waiters.delete(done)
        resolve(true)
      }
      const timer = setTimeout(() => {
        tracking.waiters.delete(done)
        resolve(false)
      }, timeoutMs)
      tracking.waiters.add(done)
    })
  }

  isChild(ownerPaneId: string, paneId: string): boolean {
    return this.byPane.get(paneId)?.ownerPaneId === ownerPaneId
  }

  workspaceOf(entry: ProcessEntry): string {
    const live = entry.status === 'closed' ? undefined : this.deps.workspaceOfPane(entry.paneId)
    if (live) entry.workspaceId = live
    return entry.workspaceId
  }

  list(workspaceId: string | null): ProcessEntry[] {
    const all = [...this.entries.values()]
    return workspaceId === null ? all : all.filter((e) => this.workspaceOf(e) === workspaceId)
  }

  resolve(ref: string, workspaceId: string, everyWorkspace: boolean): ProcessEntry | undefined {
    const visible = (entry: ProcessEntry): boolean =>
      everyWorkspace || this.workspaceOf(entry) === workspaceId
    const byId = this.entries.get(ref)
    if (byId) return visible(byId) ? byId : undefined
    const named = [...this.entries.values()].filter((e) => e.name === ref).reverse()
    return named.find((e) => this.workspaceOf(e) === workspaceId) ?? named.find(visible)
  }

  output(entry: ProcessEntry, since: number): ProcessOutput | undefined {
    if (entry.outputStart === undefined) return { data: '', cursor: 0, dropped: false }
    const from = Math.max(since, entry.outputStart)
    const frozen = this.frozen.get(entry.id)
    const slice = frozen ? sliceFrom(frozen, from) : this.deps.ring(entry.paneId)?.(from)
    if (!slice) return undefined
    const end = Math.min(entry.outputEnd ?? slice.cursor, slice.cursor)
    const start = slice.cursor - slice.data.length
    const raw = slice.data.slice(0, Math.max(0, end - start))
    const { text, consumed } = plainTerminalText(raw)
    const finished = entry.outputEnd !== undefined
    return {
      data: text,
      cursor: finished ? end : start + consumed,
      dropped: slice.dropped,
    }
  }

  info(entry: ProcessEntry): ProcessInfo {
    return {
      id: entry.id,
      name: entry.name,
      cmd: entry.cmd,
      cwd: entry.cwd,
      status: entry.status,
      exitCode: entry.exitCode,
      paneId: entry.externalPaneId,
      startedAt: entry.startedAt,
    }
  }

  private track(entry: ProcessEntry): void {
    this.tracked.set(entry.paneId, { scanner: new PromptMarkScanner(), waiters: new Set() })
  }

  private release(entry: ProcessEntry): void {
    const tracking = this.tracked.get(entry.paneId)
    if (!tracking || this.byPane.get(entry.paneId) !== entry) return
    this.tracked.delete(entry.paneId)
    for (const wake of [...tracking.waiters]) wake()
  }

  private finish(entry: ProcessEntry, end: number, exitCode: number | undefined): void {
    entry.status = 'exited'
    entry.exitCode = exitCode
    if (entry.outputStart !== undefined) entry.outputEnd = Math.max(end, entry.outputStart)
    this.release(entry)
    this.deps.onChange?.(entry)
  }
}

export interface ProcessDeps {
  openTab: (req: TerminalOpenRequest) => Promise<string | null>
  ring: (paneId: string) => RingReader | undefined
  writePane: (paneId: string, data: string) => boolean
  endShell: (paneId: string) => void
  hasShell: (paneId: string) => boolean
  runInPane: (paneId: string, command: string) => boolean
  cwdOfPane: (paneId: string) => string | undefined
  agentArgv: (name: string) => string[] | null
  interruptGraceMs: number
  onChange?: (entry: ProcessEntry) => void
}

const NOT_FOUND = { ok: false as const, error: 'not-found' as const }
const NOT_OPENED = {
  ok: false as const,
  error: 'not-opened' as const,
  message: `${PRODUCT_DISPLAY_NAME} could not open a terminal tab`,
}
const UNKNOWN_AGENT = {
  ok: false as const,
  error: 'unknown-agent' as const,
  message: `${PRODUCT_DISPLAY_NAME} knows no agent by that name; start it with ostia process run instead`,
}
const CLOSED = {
  ok: false as const,
  error: 'closed' as const,
  message: 'its tab was closed; start it again with ostia process run',
}

function hasControlCharacters(text: string, allowed: string): boolean {
  for (const ch of text) {
    if ((ch < ' ' || ch === '\x7f') && !allowed.includes(ch)) return true
  }
  return false
}

function badRequest(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidParams, `bad-request: ${message}`)
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function commandOf(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('cmd')
  if (raw.length > PROCESS_COMMAND_MAX) throw badRequest('cmd is too long')
  if (hasControlCharacters(raw, '\n\t')) throw badRequest('cmd has control characters')
  return raw
}

function agentOf(raw: unknown): string {
  if (typeof raw !== 'string' || !MANAGER_AGENT_NAME.test(raw)) throw badRequest('agent')
  return raw
}

function promptOf(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('prompt')
  return raw.trim()
}

function nameOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw badRequest('name')
  const name = raw.trim()
  if (!name) return undefined
  if (name.length > PROCESS_NAME_MAX) throw badRequest('name is too long')
  if (hasControlCharacters(name, '')) throw badRequest('name has control characters')
  return name
}

function defaultName(cmd: string): string {
  return (cmd.trim().split(/\s+/)[0] ?? '').slice(0, PROCESS_NAME_MAX)
}

function cwdOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || !isAbsolute(raw)) throw badRequest('cwd must be absolute')
  return raw
}

export function registerProcessMethods(deps: ProcessDeps): ProcessRegistry {
  const registry = new ProcessRegistry({
    ring: deps.ring,
    workspaceOfPane: (paneId) => getByPaneId(paneId)?.workspaceId,
    now: () => new Date(),
    ...(deps.onChange ? { onChange: deps.onChange } : {}),
  })

  const everyWorkspace = (ctx: ControlMethodContext): boolean =>
    connHasCap(ctx.authed, 'all-workspaces')

  const find = (raw: unknown, ctx: ControlMethodContext): ProcessEntry | undefined => {
    const { id } = record(raw)
    return typeof id === 'string'
      ? registry.resolve(id, ctx.identity.workspaceId, everyWorkspace(ctx))
      : undefined
  }

  const interrupt = async (entry: ProcessEntry): Promise<boolean> => {
    if (entry.status !== 'running') return entry.status !== 'starting'
    deps.writePane(entry.paneId, INTERRUPT)
    return registry.waitForExit(entry, deps.interruptGraceMs)
  }

  const endShell = (entry: ProcessEntry): void => {
    const ring = deps.ring(entry.paneId)
    deps.endShell(entry.paneId)
    registry.shellEnded(entry.paneId, ring ?? (() => ({ data: '', cursor: 0, dropped: false })))
  }

  const runInTab = async (
    ctx: ControlMethodContext,
    cmd: string,
    name: string,
    givenCwd: string | undefined,
    givenWorkspace: string | undefined,
  ): Promise<{ id: string; name: string; paneId: string } | typeof NOT_OPENED> => {
    const home = ctx.identity.workspaceId
    const workspaceId = givenWorkspace ?? home
    if (!workspaceId) {
      throw badRequest(
        'workspace: a script token has no workspace of its own; pass --workspace <id|name> (ostia workspace list), which needs all-workspaces on the token',
      )
    }
    const here = workspaceId === home
    if (!here) {
      await ensureCaps(
        ctx.authed,
        ctx.identity,
        ['all-workspaces'],
        'process.run',
        `open a terminal in workspace ${workspaceId}`,
      )
    }
    const cwd = givenCwd ?? (here ? deps.cwdOfPane(ctx.identity.paneId) : undefined)
    const opened = await deps.openTab({
      command: cmd,
      workspaceId,
      ...(here ? { windowId: ctx.identity.windowId, afterPaneId: ctx.identity.paneId } : {}),
      backgroundTab: true,
      pinTitle: true,
      title: name,
      ...(cwd ? { cwd } : {}),
    })
    const pane = opened ? resolveExternal(opened) : undefined
    if (pane?.kind !== 'pane') return NOT_OPENED
    const entry = registry.add({
      name,
      cmd,
      cwd,
      workspaceId,
      ownerPaneId: ctx.identity.paneId,
      paneId: pane.paneId,
      externalPaneId: pane.externalId,
    })
    return { id: entry.id, name: entry.name, paneId: entry.externalPaneId }
  }

  const workspaceOf = (raw: unknown): string | undefined => {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'string' || !raw) throw badRequest('workspace')
    return raw
  }

  registerControlMethod('process.run', {
    cap: 'process',
    scripts: true,
    handler: (raw, ctx) => {
      const p = record(raw)
      const cmd = commandOf(p.cmd)
      return runInTab(
        ctx,
        cmd,
        nameOf(p.name) ?? defaultName(cmd),
        cwdOf(p.cwd),
        workspaceOf(p.workspace),
      )
    },
  })

  registerControlMethod('agent.run', {
    cap: 'process',
    scripts: true,
    handler: (raw, ctx) => {
      const p = record(raw)
      const agent = agentOf(p.agent)
      const argv = deps.agentArgv(agent)
      if (!argv) return UNKNOWN_AGENT
      const cmd = commandOf(quoteArgv([...argv, promptOf(p.prompt)]))
      return runInTab(ctx, cmd, nameOf(p.name) ?? agent, cwdOf(p.cwd), workspaceOf(p.workspace))
    },
  })

  registerTargetableMethod('process.list', {
    cap: 'process',
    handler: (_params, ctx) =>
      registry
        .list(everyWorkspace(ctx) ? null : ctx.identity.workspaceId)
        .map((entry) => registry.info(entry)),
  })

  registerTargetableMethod('process.info', {
    cap: 'process',
    handler: (params, ctx) => {
      const entry = find(params, ctx)
      return entry ? registry.info(entry) : NOT_FOUND
    },
  })

  registerTargetableMethod('process.output', {
    cap: 'process',
    handler: (params, ctx) => {
      const entry = find(params, ctx)
      if (!entry) return NOT_FOUND
      if (entry.status === 'closed') return CLOSED
      const since = Number(record(params).sinceCursor ?? 0)
      if (!Number.isFinite(since) || since < 0) throw badRequest('sinceCursor')
      return (
        registry.output(entry, since) ?? {
          ok: false,
          error: 'no-output',
          message: 'the terminal no longer holds this output',
        }
      )
    },
  })

  registerControlMethod('process.kill', {
    cap: 'process',
    handler: async (params, ctx) => {
      const entry = find(params, ctx)
      if (!entry) return NOT_FOUND
      if (entry.status === 'closed') return CLOSED
      if (entry.status === 'exited') return { ok: true, status: entry.status }
      if (!(await interrupt(entry))) endShell(entry)
      return { ok: true, status: entry.status, exitCode: entry.exitCode }
    },
  })

  registerControlMethod('process.restart', {
    cap: 'process',
    handler: async (params, ctx) => {
      const entry = find(params, ctx)
      if (!entry) return NOT_FOUND
      if (entry.status === 'closed') return CLOSED
      if (!deps.hasShell(entry.paneId)) {
        return {
          ok: false,
          error: 'no-shell',
          message: "its tab's shell has ended; start it again with ostia process run",
        }
      }
      if (entry.status === 'starting') return { id: entry.id, name: entry.name }
      if (!(await interrupt(entry))) {
        return {
          ok: false,
          error: 'still-running',
          message: 'the command did not stop on interrupt; stop it with ostia process kill',
        }
      }
      registry.rerun(entry)
      if (!deps.runInPane(entry.paneId, entry.cmd)) {
        return { ok: false, error: 'no-window', message: 'the tab has no window to run it in' }
      }
      return { id: entry.id, name: entry.name, paneId: entry.externalPaneId }
    },
  })

  return registry
}
