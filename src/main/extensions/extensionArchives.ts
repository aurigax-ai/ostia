import { join } from 'node:path'
import {
  ARCHIVE_READS_DIR,
  type ArchiveRequest,
} from '@aurigax-ai/ostia-extension-sdk/contract/archiveReaders'
import { CancellationTokenSource } from 'vscode-jsonrpc/node'
import type { ArchiveReaderEntry, ArchiveReaderService } from '../files/archives/extensionReader'
import type { ExtensionHostDeps } from './extensionHostDeps'
import type { ExtensionProcesses } from './extensionProcesses'
import type { Runtime } from './extensionRuntime'

export const ARCHIVE_KILL_GRACE_MS = 5_000

export interface ExtensionArchivesHost {
  deps: Pick<ExtensionHostDeps, 'dataDir' | 'archiveKillGraceMs'>
  runtimes: Map<string, Runtime>
  active(rt: Runtime): boolean
  processes: Pick<ExtensionProcesses, 'connected' | 'recycle'>
}

export class ExtensionArchives implements ArchiveReaderService {
  constructor(private readonly host: ExtensionArchivesHost) {}

  private serving(rt: Runtime): boolean {
    return this.host.active(rt) && rt.state !== 'crashed'
  }

  readers(): ArchiveReaderEntry[] {
    return [...this.host.runtimes.values()]
      .filter((rt) => this.serving(rt))
      .sort(
        (a, b) =>
          Number(b.ext.builtin) - Number(a.ext.builtin) ||
          a.ext.manifest.id.localeCompare(b.ext.manifest.id),
      )
      .flatMap((rt) =>
        (rt.ext.manifest.contributes.archiveReaders ?? []).map((reader) => ({
          extId: rt.ext.manifest.id,
          reader,
        })),
      )
  }

  readDir(extId: string): string | null {
    const dataDir = this.host.deps.dataDir
    return dataDir ? join(dataDir, extId, ARCHIVE_READS_DIR) : null
  }

  async request(extId: string, request: ArchiveRequest, timeoutMs: number): Promise<unknown> {
    const rt = this.host.runtimes.get(extId)
    if (!rt || !this.serving(rt)) throw new Error('extension stopped')
    if (rt.restartTimer) throw new Error('extension restarting')
    const conn = await this.host.processes.connected(rt)
    const source = new CancellationTokenSource()
    const grace = this.host.deps.archiveKillGraceMs ?? ARCHIVE_KILL_GRACE_MS
    return new Promise((resolve, reject) => {
      let kill: ReturnType<typeof setTimeout> | null = null
      const timer = setTimeout(() => {
        source.cancel()
        kill = setTimeout(() => {
          this.host.processes.recycle(rt)
          reject(new Error(`${extId} archive request timed out`))
        }, grace)
      }, timeoutMs)
      const settle = (): void => {
        clearTimeout(timer)
        if (kill) clearTimeout(kill)
        source.dispose()
      }
      conn.sendRequest('ext.archive', request, source.token).then(
        (value) => {
          settle()
          resolve(value)
        },
        (error) => {
          settle()
          reject(error)
        },
      )
    })
  }
}
