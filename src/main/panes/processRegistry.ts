import { PromptMarkScanner, plainTerminalText } from '../terminal/terminalText'

const COMMAND_START = 'C'
const COMMAND_END = 'D'

type ProcessStatus = 'starting' | 'running' | 'exited' | 'closed'

export type StartOutcome = 'started' | 'exited' | 'failed' | 'timed-out'

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
  splitTab?: string
  start?: StartOutcome
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
  splitTab?: string
  start?: StartOutcome
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
  splitTab?: string
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
  private readonly workersTabs = new Map<string, string>()
  private readonly adopted = new Map<string, string>()
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
      ...(input.splitTab ? { splitTab: input.splitTab } : {}),
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
      ...(kept.splitTab ? { splitTab: kept.splitTab } : {}),
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

  rememberWorkersTab(callerPaneId: string, name: string): void {
    this.workersTabs.set(callerPaneId, name)
  }

  workersTabOf(callerPaneId: string): string | undefined {
    return this.workersTabs.get(callerPaneId)
  }

  paneClosed(paneId: string): void {
    this.workersTabs.delete(paneId)
    this.adopted.delete(paneId)
    for (const [child, owner] of this.adopted) if (owner === paneId) this.adopted.delete(child)
    const entry = this.byPane.get(paneId)
    if (!entry) return
    this.release(entry)
    this.byPane.delete(paneId)
    this.frozen.delete(entry.id)
    entry.status = 'closed'
  }

  workspaceClosed(workspaceId: string): void {
    for (const [child, owner] of this.adopted) {
      if (
        this.deps.workspaceOfPane(child) === workspaceId ||
        this.deps.workspaceOfPane(owner) === workspaceId
      ) {
        this.adopted.delete(child)
      }
    }
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
    return (
      this.byPane.get(paneId)?.ownerPaneId === ownerPaneId ||
      this.adopted.get(paneId) === ownerPaneId
    )
  }

  adoptChild(ownerPaneId: string, paneId: string): void {
    this.adopted.set(paneId, ownerPaneId)
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

  openedBy(ownerPaneId: string): string[] {
    return [...this.entries.values()]
      .filter((e) => e.ownerPaneId === ownerPaneId && e.status !== 'closed')
      .map((e) => e.paneId)
  }

  resolve(
    ref: string,
    workspaceId: string,
    reaches: (workspaceId: string) => boolean,
  ): ProcessEntry | undefined {
    const visible = (entry: ProcessEntry): boolean => {
      const owner = this.workspaceOf(entry)
      return owner === workspaceId || reaches(owner)
    }
    const byId = this.entries.get(ref)
    if (byId) return visible(byId) ? byId : undefined
    const named = [...this.entries.values()].filter((e) => e.name === ref).reverse()
    return named.find((e) => this.workspaceOf(e) === workspaceId) ?? named.find(visible)
  }

  livePanes(
    ref: string,
    workspaceId: string,
    reaches: (workspaceId: string) => boolean,
  ): ProcessEntry[] {
    const seen = (entry: ProcessEntry): boolean => {
      const owner = this.workspaceOf(entry)
      return owner === workspaceId || reaches(owner)
    }
    const byId = this.entries.get(ref)
    if (byId) return byId.status !== 'closed' && seen(byId) ? [byId] : []
    const named = [...this.entries.values()]
      .filter((e) => e.name === ref && e.status !== 'closed')
      .reverse()
    const own = named.filter((e) => this.workspaceOf(e) === workspaceId)
    return own.length > 0 ? own : named.filter(seen)
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
      ...(entry.splitTab ? { splitTab: entry.splitTab } : {}),
      ...(entry.start ? { start: entry.start } : {}),
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
