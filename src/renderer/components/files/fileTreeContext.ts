import type { RemoteFileError } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import type { FsEntry } from '@shared/files/filesApi'
import { useMemo } from 'react'
import { useDict } from '@/lib/app/useDict'
import {
  childPath,
  type ExcludeMatcher,
  excludeMatcher,
  type NestedEntry,
  nestEntries,
  nestingRules,
  sortEntries,
} from '@/lib/files/fileTree'
import { followedFolder, treeRoot } from '@/lib/files/revealFolder'
import type { FileTreeSettings } from '@/lib/settings/fileTreeSettings'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

export interface TreeFocus {
  workspaceId: string | null
  cwd: string
  activeFile: string | null
  reveal: string | null
}

export type ListFiles = (path: string) => Promise<FsEntry[]>

export interface TreeContext {
  focus: TreeFocus
  root: string
  remote: boolean
  list: ListFiles
  emptyText: string
  settings: FileTreeSettings
  isExcluded: ExcludeMatcher
  nest: (entries: FsEntry[]) => NestedEntry[]
  visible: (entries: FsEntry[], path: string) => FsEntry[]
  setExcluded: (path: string, hidden: boolean) => void
}

export function useTreeFocus(): TreeFocus {
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  useWorkspacesStore((s) => s.workspaces.find((c) => c.id === workspaceId)?.workDir)
  useLayoutStore((s) => (workspaceId ? s.byWorkspace[workspaceId] : undefined))
  const shown = useFileTreeStore((s) => s.shown)
  const { cwd, activeFile } = followedFolder(workspaceId)
  return { workspaceId, cwd: treeRoot(workspaceId, cwd, shown), activeFile, reveal: null }
}

function setExcluded(path: string, hidden: boolean): void {
  const { files, setFiles } = useSettingsStore.getState()
  const exclude = hidden
    ? [...files.exclude.filter((p) => p !== path), path]
    : files.exclude.filter((p) => p !== path)
  setFiles({ exclude })
}

class RemoteListError extends Error {
  constructor(readonly code: RemoteFileError) {
    super(code)
  }
}

const listLocal: ListFiles = (path) => window.ostia.fs.list(path)

const listRemote: ListFiles = async (path) => {
  const listing = await window.ostia.remoteFiles.list(path)
  if (!listing.ok) throw new RemoteListError(listing.error)
  return listing.entries
}

export function listingError(err: unknown): RemoteFileError {
  return err instanceof RemoteListError ? err.code : 'failed'
}

export function useTreeContext(focus: TreeFocus, remoteRoot?: string): TreeContext {
  const d = useDict()
  const settings = useSettingsStore((s) => s.files)
  const root = remoteRoot ?? focus.cwd
  const remote = remoteRoot !== undefined
  const emptyText = remote ? d.remoteFolders.empty : d.rail.noFolder
  return useMemo(() => {
    const isExcluded = excludeMatcher(settings.exclude)
    const rules = settings.nesting.enabled ? nestingRules(settings.nesting.patterns) : []
    const visible = (entries: FsEntry[], path: string): FsEntry[] =>
      sortEntries(
        settings.showExcluded
          ? entries
          : entries.filter((e) => !isExcluded(childPath(path, e.name), root)),
        settings.sortOrder,
        settings.sortBy,
      )
    return {
      focus,
      root,
      remote,
      list: remote ? listRemote : listLocal,
      emptyText,
      settings,
      isExcluded,
      nest: (entries) => nestEntries(entries, rules),
      visible,
      setExcluded,
    }
  }, [focus, root, remote, emptyText, settings])
}
