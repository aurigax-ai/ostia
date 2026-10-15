import { execFile } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import { parseProcStat } from './procfs'

const TOOL_TIMEOUT_MS = 3000
const TOOL_MAX_OUTPUT = 64 * 1024

export type ToolRun = (bin: string, args: string[]) => Promise<string>

const DELETED_SUFFIX = ' (deleted)'

function folderOf(path: string | undefined): string | null {
  if (path?.startsWith('/') !== true) return null
  return path.endsWith(DELETED_SUFFIX) ? path.slice(0, -DELETED_SUFFIX.length) : path
}

export async function linuxForegroundCwd(
  shellPid: number,
  procRoot = '/proc',
): Promise<string | null> {
  const stat = parseProcStat(await readFile(`${procRoot}/${shellPid}/stat`, 'utf8').catch(() => ''))
  if (!stat || stat.tpgid <= 0) return null
  return folderOf(await readlink(`${procRoot}/${stat.tpgid}/cwd`).catch(() => undefined))
}

export async function darwinForegroundCwd(shellPid: number, run: ToolRun): Promise<string | null> {
  const tpgid = Number((await run('/bin/ps', ['-o', 'tpgid=', '-p', String(shellPid)])).trim())
  if (!Number.isInteger(tpgid) || tpgid <= 0) return null
  const out = await run('/usr/sbin/lsof', ['-a', '-p', String(tpgid), '-d', 'cwd', '-Fn'])
  return folderOf(
    out
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1),
  )
}

function toolOutput(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: TOOL_TIMEOUT_MS, maxBuffer: TOOL_MAX_OUTPUT, encoding: 'utf8' },
      (error, stdout) => resolve(error ? '' : stdout),
    )
  })
}

export function foregroundCwd(shellPid: number): Promise<string | null> {
  if (process.platform === 'linux') return linuxForegroundCwd(shellPid)
  if (process.platform === 'darwin') return darwinForegroundCwd(shellPid, toolOutput)
  return Promise.resolve(null)
}
