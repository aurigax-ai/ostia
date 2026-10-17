import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open, opendir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type FolderReads,
  PROTECTED_FOLDERS,
  type ProtectedFolder,
  folderReadOfError,
  folderReadOfLs,
} from './folderAccess'

const FULL_DISK_ACCESS_PROBE = '/Library/Application Support/com.apple.TCC/TCC.db'

const KEPT_PROBE_WAIT_MS = 5000
const KEPT_PROBE_POLL_MS = 50

export async function hasFullDiskAccess(file: string = FULL_DISK_ACCESS_PROBE): Promise<boolean> {
  try {
    const handle = await open(file, 'r')
    await handle.close()
    return true
  } catch {
    return false
  }
}

export async function readFoldersInMain(home: string): Promise<FolderReads> {
  const reads: FolderReads = {}
  for (const folder of PROTECTED_FOLDERS) {
    try {
      const dir = await opendir(join(home, folder))
      try {
        await dir.read()
      } finally {
        await dir.close()
      }
      reads[folder] = 'ok'
    } catch (err) {
      reads[folder] = folderReadOfError(err)
    }
  }
  return reads
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function keptProbeScript(home: string, out: string): string {
  const partial = shellQuote(`${out}.partial`)
  const err = shellQuote(`${out}.err`)
  const lines = ['umask 077', `: > ${partial}`]
  for (const folder of PROTECTED_FOLDERS) {
    lines.push(
      `/bin/ls -A ${shellQuote(join(home, folder))} >/dev/null 2>${err}; s=$?`,
      `printf '%s\\t%s\\t' ${folder} "$s" >> ${partial}`,
      `tr '\\t\\n' '  ' < ${err} >> ${partial}`,
      `echo >> ${partial}`,
    )
  }
  lines.push(`rm -f ${err}`, `mv -f ${partial} ${shellQuote(out)}`)
  return lines.join('; ')
}

export function parseKeptProbe(text: string): FolderReads {
  const reads: FolderReads = {}
  const known = new Set<string>(PROTECTED_FOLDERS)
  for (const line of text.split('\n')) {
    const [folder, status, ...rest] = line.split('\t')
    if (!folder || !known.has(folder) || status === undefined || !/^\d+$/.test(status)) continue
    reads[folder as ProtectedFolder] = folderReadOfLs(Number(status), rest.join('\t'))
  }
  return reads
}

export interface KeptProbeDeps {
  dir: string
  home: string
  runShell: (script: string) => Promise<boolean>
  waitMs?: number
}

export async function readFoldersInKeptShells(deps: KeptProbeDeps): Promise<FolderReads | null> {
  const out = join(deps.dir, `folder-probe-${randomUUID()}`)
  try {
    if (!(await deps.runShell(keptProbeScript(deps.home, out)))) return null
    const end = Date.now() + (deps.waitMs ?? KEPT_PROBE_WAIT_MS)
    while (!existsSync(out)) {
      if (Date.now() >= end) return null
      await sleep(KEPT_PROBE_POLL_MS)
    }
    return parseKeptProbe(await readFile(out, 'utf8'))
  } catch {
    return null
  } finally {
    await Promise.all(
      [out, `${out}.partial`, `${out}.err`].map((file) => rm(file, { force: true })),
    ).catch(() => undefined)
  }
}
