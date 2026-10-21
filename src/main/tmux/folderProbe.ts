import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, opendir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type FolderReads,
  folderReadOfCommand,
  folderReadOfError,
  PROTECTED_FOLDERS,
  type ProtectedFolder,
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

const KEPT_PROBE_PREFIX = 'folder-probe-'
const KEPT_PROBE_REPORT = 'report'

export function keptProbeScript(home: string, probeDir: string): string {
  const dir = shellQuote(probeDir)
  const partial = shellQuote(join(probeDir, `${KEPT_PROBE_REPORT}.partial`))
  const err = shellQuote(join(probeDir, 'err'))
  const lines = ['umask 077', `[ -d ${dir} ] || exit 0`, `: > ${partial} || exit 0`]
  for (const folder of PROTECTED_FOLDERS) {
    const path = shellQuote(join(home, folder))
    lines.push(
      `/usr/bin/find ${path} -mindepth 1 -maxdepth 1 -print -quit >/dev/null 2>${err}; s=$?`,
      `printf '%s\\t%s\\t' ${folder} "$s" >> ${partial}`,
      `tr '\\t\\n' '  ' < ${err} >> ${partial}`,
      `echo >> ${partial}`,
    )
  }
  lines.push(
    `rm -f ${err}`,
    `[ -d ${dir} ] && mv -f ${partial} ${shellQuote(join(probeDir, KEPT_PROBE_REPORT))}`,
  )
  return lines.join('; ')
}

export async function sweepKeptProbes(dir: string): Promise<void> {
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(KEPT_PROBE_PREFIX))
      .map((name) => rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined)),
  )
}

export function parseKeptProbe(text: string): FolderReads {
  const reads: FolderReads = {}
  const known = new Set<string>(PROTECTED_FOLDERS)
  for (const line of text.split('\n')) {
    const [folder, status, ...rest] = line.split('\t')
    if (!folder || !known.has(folder) || status === undefined || !/^\d+$/.test(status)) continue
    reads[folder as ProtectedFolder] = folderReadOfCommand(Number(status), rest.join('\t'))
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
  const probeDir = join(deps.dir, `${KEPT_PROBE_PREFIX}${randomUUID()}`)
  const out = join(probeDir, KEPT_PROBE_REPORT)
  try {
    await mkdir(probeDir, { mode: 0o700 })
    if (!(await deps.runShell(keptProbeScript(deps.home, probeDir)))) return null
    const end = Date.now() + (deps.waitMs ?? KEPT_PROBE_WAIT_MS)
    while (!existsSync(out)) {
      if (Date.now() >= end) return null
      await sleep(KEPT_PROBE_POLL_MS)
    }
    return parseKeptProbe(await readFile(out, 'utf8'))
  } catch {
    return null
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
