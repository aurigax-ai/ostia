import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
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
}

const DEFAULT: PhoneWorkspace = { folder: null, openNew: false, agent: 'claude' }

function agentOf(value: unknown): PhoneAgent | null {
  return value === 'claude' || value === 'codex' ? value : null
}

export function loadPhoneWorkspace(): PhoneWorkspace {
  const raw = loadPhoneWorkspaceRecord()
  if (typeof raw !== 'object' || raw === null) return DEFAULT
  const { folder, openNew, agent } = raw as Record<string, unknown>
  return {
    folder: typeof folder === 'string' && isAbsolute(folder) ? folder : null,
    openNew: openNew === true,
    agent: agentOf(agent) ?? DEFAULT.agent,
  }
}

export function folderRefusal(
  folder: string,
  paths: PhoneWorkspacePaths,
): PhoneWorkspaceProblem | null {
  let real: string
  try {
    real = realpathSync(folder)
    if (!statSync(real).isDirectory()) return 'missing'
  } catch {
    return 'missing'
  }
  const problem = folderProblem(real, paths)
  if (problem) return problem
  const closed = paths.closedRoots.some((root) => {
    try {
      const rootReal = realpathSync(root)
      return isInsidePath(rootReal, real) || isInsidePath(real, rootReal)
    } catch {
      return false
    }
  })
  return closed ? 'scratch-or-artifacts' : null
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
  const value: PhoneWorkspace = {
    folder: folder === null ? null : realpathSync(folder),
    openNew: folder !== null && openNew,
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

export async function phoneWorkspaceId(deps: PhoneWorkspaceOpen): Promise<string | null> {
  const { folder, openNew } = loadPhoneWorkspace()
  if (!folder || !openNew) return null
  const paths = deps.paths()
  if (folderRefusal(folder, paths)) return null
  const open = (await deps.workspaces()).find(
    (w) => w.kind !== 'scratch' && isPhoneFolder(w.workDir, folder, paths.home),
  )
  return open ? open.workspaceId : await deps.open(folder)
}
