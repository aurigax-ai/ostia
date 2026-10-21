import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { PhoneAgent } from '../panes/phoneAgent'
import { isInsidePath } from '../platform/pathGuard'
import { folderProblem } from '../sandbox/srtConfig'
import { isSameFolder } from '../workspaces/sameFolder'
import { loadPhoneWorkspaceRecord, savePhoneWorkspaceRecord } from './route'

export interface PhoneWorkspace {
  folder: string | null
  openNew: boolean
  agent: PhoneAgent
}

export type PhoneWorkspaceProblem =
  | 'missing'
  | 'home'
  | 'above-home'
  | 'ostia-data'
  | 'scratch-or-artifacts'

export interface PhoneWorkspacePaths {
  home: string
  dataDirs: readonly string[]
  closedRoots: readonly string[]
  defaultFolder: string
}

export const DEFAULT_FOLDER_NAME = 'remote-workspace'

const DEFAULT: PhoneWorkspace = { folder: null, openNew: true, agent: 'claude' }

export function ownFolder(defaultFolder: string): string {
  try {
    return join(realpathSync(dirname(defaultFolder)), basename(defaultFolder))
  } catch {
    return defaultFolder
  }
}

export function folderOf(phone: PhoneWorkspace, paths: PhoneWorkspacePaths): string {
  if (phone.folder !== null) return phone.folder
  mkdirSync(paths.defaultFolder, { recursive: true, mode: 0o700 })
  return paths.defaultFolder
}

function agentOf(value: unknown): PhoneAgent | null {
  return value === 'claude' || value === 'codex' ? value : null
}

export function loadPhoneWorkspace(): PhoneWorkspace {
  const raw = loadPhoneWorkspaceRecord()
  if (typeof raw !== 'object' || raw === null) return DEFAULT
  const { folder, openNew, agent } = raw as Record<string, unknown>
  return {
    folder: typeof folder === 'string' && isAbsolute(folder) ? folder : null,
    openNew: typeof openNew === 'boolean' ? openNew : DEFAULT.openNew,
    agent: agentOf(agent) ?? DEFAULT.agent,
  }
}

function checkFolder(
  folder: string,
  paths: PhoneWorkspacePaths,
): { real: string } | { problem: PhoneWorkspaceProblem } {
  let real: string
  try {
    real = realpathSync(folder)
    if (!statSync(real).isDirectory()) return { problem: 'missing' }
  } catch {
    return { problem: 'missing' }
  }
  if (real === ownFolder(paths.defaultFolder)) return { real }
  const problem = folderProblem(real, paths)
  if (problem) return { problem }
  const closed = paths.closedRoots.some((root) => {
    try {
      const rootReal = realpathSync(root)
      return isInsidePath(rootReal, real) || isInsidePath(real, rootReal)
    } catch {
      return false
    }
  })
  return closed ? { problem: 'scratch-or-artifacts' } : { real }
}

export function folderRefusal(
  folder: string,
  paths: PhoneWorkspacePaths,
): PhoneWorkspaceProblem | null {
  const checked = checkFolder(folder, paths)
  return 'problem' in checked ? checked.problem : null
}

export function phoneWorkspaceDefaults(paths: PhoneWorkspacePaths): {
  set: boolean
  agent: PhoneAgent
} {
  const phone = loadPhoneWorkspace()
  return { set: phone.openNew && !folderRefusal(folderOf(phone, paths), paths), agent: phone.agent }
}

export type PhoneWorkspaceSet =
  | { ok: true; value: PhoneWorkspace }
  | { ok: false; error: PhoneWorkspaceProblem | 'invalid' }

export function setPhoneWorkspace(raw: unknown, paths: PhoneWorkspacePaths): PhoneWorkspaceSet {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'invalid' }
  const { folder, openNew, agent } = raw as Record<string, unknown>
  const chosen = agentOf(agent)
  if (!chosen || typeof openNew !== 'boolean') return { ok: false, error: 'invalid' }
  if (folder !== null && (typeof folder !== 'string' || !isAbsolute(folder))) {
    return { ok: false, error: 'invalid' }
  }
  if (folder !== null) {
    const problem = folderRefusal(folder, paths)
    if (problem) return { ok: false, error: problem }
  }
  const real = folder === null ? null : realpathSync(folder)
  const value: PhoneWorkspace = {
    folder: real === ownFolder(paths.defaultFolder) ? null : real,
    openNew,
    agent: chosen,
  }
  savePhoneWorkspaceRecord(value)
  return { ok: true, value }
}

export interface PhoneWorkspaceOpen {
  paths: () => PhoneWorkspacePaths
  workspaces: () => Promise<{ workspaceId: string; kind: string; workDir: string }[]>
  open: (folder: string) => Promise<string | null>
}

export function isPhoneFolder(workDir: string, folder: string | null, home: string): boolean {
  return folder !== null && isSameFolder(workDir, folder, home)
}

const opening = new Map<string, Promise<string | null>>()

async function findOrOpen(real: string, deps: PhoneWorkspaceOpen, home: string) {
  const open = (await deps.workspaces()).find(
    (w) => w.kind !== 'scratch' && isPhoneFolder(w.workDir, real, home),
  )
  return open ? open.workspaceId : await deps.open(real)
}

export async function phoneWorkspaceId(deps: PhoneWorkspaceOpen): Promise<string | null> {
  const phone = loadPhoneWorkspace()
  if (!phone.openNew) return null
  const paths = deps.paths()
  const checked = checkFolder(folderOf(phone, paths), paths)
  if ('problem' in checked) return null
  const pending = opening.get(checked.real)
  if (pending) return pending
  const next = findOrOpen(checked.real, deps, paths.home).finally(() => {
    opening.delete(checked.real)
  })
  opening.set(checked.real, next)
  return next
}
