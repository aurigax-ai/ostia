export const PROTECTED_FOLDERS = ['Downloads', 'Documents', 'Desktop'] as const

export type ProtectedFolder = (typeof PROTECTED_FOLDERS)[number]

export type FolderRead = 'ok' | 'denied' | 'other'

export type FolderReads = Partial<Record<ProtectedFolder, FolderRead>>

const TCC_DENIED = 'Operation not permitted'

export function folderReadOfError(err: unknown): FolderRead {
  if (typeof err !== 'object' || err === null) return 'other'
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (code === 'EPERM') return 'denied'
  if (code === undefined && typeof message === 'string' && message.includes(TCC_DENIED)) {
    return 'denied'
  }
  return 'other'
}

export function folderReadOfLs(exitCode: number, stderr: string): FolderRead {
  if (exitCode === 0) return 'ok'
  return stderr.includes(TCC_DENIED) ? 'denied' : 'other'
}

export class FolderAccessMonitor {
  private readonly readable = new Set<ProtectedFolder>()
  private readonly reported = new Set<string>()

  observe(rounds: readonly FolderReads[]): ProtectedFolder[] | null {
    for (const reads of rounds) {
      for (const folder of PROTECTED_FOLDERS) {
        if (reads[folder] === 'ok') this.readable.add(folder)
      }
    }
    const blocked = PROTECTED_FOLDERS.filter(
      (folder) => this.readable.has(folder) && rounds.some((reads) => reads[folder] === 'denied'),
    )
    if (blocked.length === 0) return null
    const key = blocked.join('\0')
    if (this.reported.has(key)) return null
    this.reported.add(key)
    return blocked
  }
}
