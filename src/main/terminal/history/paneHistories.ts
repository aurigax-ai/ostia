import { hash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { rm, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScrollbackHistory } from '../../../shared/terminal/scrollbackHistory'
import type { AppLog } from '../../diagnostics/appLog'
import {
  type HistoryFeed,
  historyWorkerScript,
  type SpillClient,
  type SpillPressure,
  startSpillWorker,
} from './historyFeed'
import { newHistoryKey } from './historyRecords'
import { PaneHistory } from './paneHistory'

export const HISTORY_DIR = 'scrollback'
export const FREE_SPACE_FLOOR = 2 * 1024 * 1024 * 1024
const MIB = 1024 * 1024
const RUN_DIR = /^(\d+)-[0-9a-f]+$/

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function sweepHistoryRoot(root: string, ownPid = process.pid): void {
  if (!existsSync(root)) return
  if (process.platform !== 'win32') chmodSync(root, 0o700)
  for (const name of readdirSync(root)) {
    const run = RUN_DIR.exec(name)
    const pid = run ? Number(run[1]) : Number.NaN
    if (run && (pid === ownPid || pidAlive(pid))) continue
    rmSync(join(root, name), { recursive: true, force: true })
  }
}

function paneFolder(paneId: string): string {
  return hash('sha256', paneId).slice(0, 24)
}

export interface PaneHistoriesDeps {
  root: string
  setting: () => ScrollbackHistory
  startSpill: () => SpillClient
  freeBytes?: (dir: string) => Promise<number>
  onFailed?: (paneId: string, reason: string) => void
  segmentBytes?: number
}

async function statfsFree(dir: string): Promise<number> {
  const stats = await statfs(dir)
  return stats.bavail * stats.bsize
}

export function appSpillWorker(appPath: string): () => SpillClient {
  return () => startSpillWorker(historyWorkerScript(appPath))
}

export class PaneHistories {
  private readonly key = newHistoryKey()
  private readonly runDir: string
  private readonly panes = new Map<string, PaneHistory>()
  private spill: SpillClient | null = null
  private generation = 0
  private readonly disposing = new Set<Promise<void>>()
  private readonly closing = new Map<string, Promise<void>>()

  constructor(private readonly deps: PaneHistoriesDeps) {
    sweepHistoryRoot(deps.root)
    this.runDir = join(deps.root, `${process.pid}-${randomBytes(4).toString('hex')}`)
  }

  get(paneId: string): PaneHistory | undefined {
    return this.panes.get(paneId)
  }

  forPane(paneId: string): PaneHistory | null {
    const existing = this.panes.get(paneId)
    if (existing?.live) return existing
    if (existing) {
      this.retire(existing)
      this.panes.delete(paneId)
    }
    if (this.deps.setting() === 'off') return null
    const history = new PaneHistory({
      dir: join(this.runDir, `${paneFolder(paneId)}-${this.generation++}`),
      key: this.key,
      limitBytes: () => this.limitBytes(),
      ensureSpace: (asking) => this.ensureSpace(asking),
      onFailed: (reason) => this.deps.onFailed?.(paneId, reason),
      segmentBytes: this.deps.segmentBytes,
    })
    this.panes.set(paneId, history)
    return history
  }

  feedFor(
    paneId: string,
    cols: number,
    rows: number,
    pressure: SpillPressure | null = null,
  ): HistoryFeed | null {
    const history = this.forPane(paneId)
    if (!history) return null
    if (!this.spill?.alive) this.spill = this.deps.startSpill()
    const feed = this.spill.open(history, cols, rows, pressure)
    return {
      ...feed,
      close: () => {
        const closed = feed.close()
        this.closing.set(paneId, closed)
        void closed.then(() => {
          if (this.closing.get(paneId) === closed) this.closing.delete(paneId)
        })
        return closed
      },
    }
  }

  settled(paneId: string): Promise<void> {
    return this.closing.get(paneId) ?? Promise.resolve()
  }

  drop(paneId: string): void {
    const history = this.panes.get(paneId)
    this.panes.delete(paneId)
    if (history) this.retire(history)
  }

  async removeAll(): Promise<void> {
    for (const history of this.panes.values()) this.retire(history)
    this.panes.clear()
    await Promise.all(this.disposing)
    await rm(this.runDir, { recursive: true, force: true })
  }

  private retire(history: PaneHistory): void {
    const disposed = history.dispose().catch(() => undefined)
    this.disposing.add(disposed)
    void disposed.then(() => this.disposing.delete(disposed))
  }

  private limitBytes(): number | null {
    const setting = this.deps.setting()
    if (setting === 'unlimited') return null
    if (setting === 'off') return 0
    return setting * MIB
  }

  private async ensureSpace(asking: PaneHistory): Promise<boolean> {
    if (this.deps.setting() === 'off') return false
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 })
    const freeBytes = this.deps.freeBytes ?? statfsFree
    for (;;) {
      if ((await freeBytes(this.runDir)) >= FREE_SPACE_FLOOR) return true
      const largest = [...this.panes.values()]
        .filter((h) => h.droppable)
        .sort((a, b) => b.bytes - a.bytes)[0]
      if (!largest) return false
      largest.dropOldestSegment()
      if (largest === asking && !asking.droppable) return false
    }
  }
}

export async function removeHistories(
  histories: PaneHistories | null,
  appLog: AppLog | null,
): Promise<void> {
  try {
    await histories?.removeAll()
  } catch (err) {
    appLog?.warn('history-remove-failed', {
      code: (err as NodeJS.ErrnoException).code ?? 'unknown',
    })
  }
}
