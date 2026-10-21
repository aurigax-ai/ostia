import type { Dirent } from 'node:fs'
import { opendir, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isRemotePath } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { ipcMain } from 'electron'
import type { FsEntry } from '../../shared/files/filesApi'
import { expandHome } from '../platform/pathGuard'
import {
  leadsIntoSandbox,
  type SandboxReadRules,
  sandboxEntries,
  visibleInSandbox,
} from '../sandbox/visibility'

export const COMPLETION_ENTRIES_MAX = 10_000

export interface CompletionPane {
  owners: { has: (senderId: string) => boolean }
  localPrompt: boolean
  rules: SandboxReadRules | null
}

export type CompletionPaneLookup = (paneId: string) => CompletionPane | null

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

async function shellFolder(dir: string, rules: SandboxReadRules | null): Promise<string | null> {
  const lexical = resolve(expandHome(dir))
  if (!rules) return lexical
  const real = await realOrNull(lexical)
  if (real === null) return null
  return visibleInSandbox(real, rules) || leadsIntoSandbox(real, rules) ? real : null
}

async function firstEntries(dir: string): Promise<Dirent[]> {
  const entries: Dirent[] = []
  try {
    for await (const entry of await opendir(dir)) {
      entries.push(entry)
      if (entries.length >= COMPLETION_ENTRIES_MAX) break
    }
  } catch {
    return []
  }
  return entries
}

async function linksToFolder(path: string, rules: SandboxReadRules | null): Promise<boolean> {
  try {
    if (rules) {
      const target = await realOrNull(path)
      if (target === null || !visibleInSandbox(target, rules)) return false
    }
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function listFolder(dir: string, rules: SandboxReadRules | null): Promise<FsEntry[]> {
  const folder = await shellFolder(dir, rules)
  if (folder === null) return []
  const read = await firstEntries(folder)
  const shown = rules ? sandboxEntries(folder, read, rules) : read
  const entries = await Promise.all(
    shown.map(async (entry) => ({
      name: entry.name,
      dir: entry.isSymbolicLink()
        ? await linksToFolder(join(folder, entry.name), rules)
        : entry.isDirectory(),
    })),
  )
  return entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
}

export async function completionPaths(
  paneOf: CompletionPaneLookup,
  senderId: string,
  paneId: unknown,
  dir: unknown,
): Promise<FsEntry[]> {
  if (typeof paneId !== 'string' || typeof dir !== 'string') return []
  if (dir === '' || dir.includes('\0') || isRemotePath(dir)) return []
  const pane = paneOf(paneId)
  if (!pane?.owners.has(senderId) || !pane.localPrompt) return []
  return listFolder(dir, pane.rules)
}

export function registerPathCompletionIpc(paneOf: CompletionPaneLookup): void {
  ipcMain.handle('pty:list-dir', (e, paneId: unknown, dir: unknown) =>
    completionPaths(paneOf, String(e.sender.id), paneId, dir),
  )
}
