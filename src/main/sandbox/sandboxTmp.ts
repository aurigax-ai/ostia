import { hash } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { processAlive } from '../platform/processAlive'
import type { KeptSandboxHosts } from './sandboxHosts'
import { SSH_AGENT_SOCKET_NAME } from './srtConfig'

const INSTANCE_TMP_NAME = /^\d+$/

function instanceTmpNames(tmpRoot: string): string[] {
  try {
    return readdirSync(tmpRoot).filter((name) => INSTANCE_TMP_NAME.test(name))
  } catch {
    return []
  }
}

interface SandboxTmpDeps {
  tmpRoot: string
  pid?: number
  processAlive?: (pid: number) => boolean
  kept?: KeptSandboxHosts
}

export class SandboxTmpDirs {
  private readonly tmpDirs = new Map<string, string>()
  private readonly pid: number
  private readonly instanceTmp: string

  constructor(private readonly deps: SandboxTmpDeps) {
    this.pid = deps.pid ?? process.pid
    this.instanceTmp = join(deps.tmpRoot, String(this.pid))
  }

  tmpDir(workspaceId: string): string {
    const chosen = this.tmpDirs.get(workspaceId)
    if (chosen) return chosen
    const short = hash('sha256', workspaceId).slice(0, 10)
    const kept = this.deps.kept
    const dir = join(kept?.enabled() ? kept.tmpRoot : this.instanceTmp, short)
    this.tmpDirs.set(workspaceId, dir)
    return dir
  }

  pluginsDir(workspaceId: string): string {
    const tmpDir = this.tmpDir(workspaceId)
    return join(dirname(tmpDir), `${basename(tmpDir)}-plugins`)
  }

  pluginsData(workspaceId: string): string {
    return join(this.tmpDir(workspaceId), 'plugin-data')
  }

  adoptKeptTmp(workspaceId: string, dir: string): void {
    this.tmpDirs.set(workspaceId, dir)
  }

  sshAgentSocket(workspaceId: string): string {
    return join(this.tmpDir(workspaceId), SSH_AGENT_SOCKET_NAME)
  }

  remove(workspaceId: string): void {
    rmSync(this.tmpDir(workspaceId), { recursive: true, force: true })
    rmSync(this.pluginsDir(workspaceId), { recursive: true, force: true })
    this.tmpDirs.delete(workspaceId)
  }

  clearTmp(includingKept = true): void {
    rmSync(this.instanceTmp, { recursive: true, force: true })
    if (includingKept && this.deps.kept) {
      rmSync(this.deps.kept.tmpRoot, { recursive: true, force: true })
    }
  }

  sweepKeptTmp(liveWorkspaceIds: readonly string[]): string[] {
    const kept = this.deps.kept
    if (!kept) return []
    const live = new Set(liveWorkspaceIds.flatMap((id) => [this.tmpDir(id), this.pluginsDir(id)]))
    const removed: string[] = []
    let names: string[] = []
    try {
      names = readdirSync(kept.tmpRoot)
    } catch {
      return []
    }
    for (const name of names) {
      const dir = join(kept.tmpRoot, name)
      if (live.has(dir)) continue
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    }
    return removed
  }

  sweepTmp(): string[] {
    const alive = this.deps.processAlive ?? processAlive
    const removed: string[] = []
    for (const name of instanceTmpNames(this.deps.tmpRoot)) {
      const pid = Number(name)
      if (pid === this.pid || alive(pid)) continue
      const dir = join(this.deps.tmpRoot, name)
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    }
    return removed
  }
}
