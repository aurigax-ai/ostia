import { statSync } from 'node:fs'
import type { ExtensionOpenFileRequest, ExtensionResult } from '../shared/extensions'
import {
  type FileTarget,
  OPEN_FILES_COMMAND,
  OPEN_FILES_MAX,
  type OpenFilesResult,
  REVEAL_FOLDER_COMMAND,
  type RevealFolderResult,
  parseFileTargets,
} from '../shared/openFiles'
import type { CommandResult, CommandTarget } from '../shared/types'
import { targetOf } from './attention'
import { registerControlMethod } from './controlServer'
import type { OpenFileGrants } from './openFileGrants'

export interface OpenFileDeps {
  grants: OpenFileGrants
  isSandboxed: (workspaceId: string) => boolean
  isScratch: (workspaceId: string) => boolean
  confineFolder: (path: string) => string | null
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
}

function folderKind(path: string): 'directory' | 'other' | 'missing' {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'other'
  } catch {
    return 'missing'
  }
}

export function registerOpenFileMethods(deps: OpenFileDeps): void {
  registerControlMethod('file.open', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx): Promise<OpenFilesResult> => {
      const request = params as { files?: unknown; background?: unknown } | null
      const targets = parseFileTargets(request?.files)
      if (!targets) {
        return {
          ok: false,
          error: 'invalid-args',
          message: `expected 1 to ${OPEN_FILES_MAX} files`,
        }
      }
      const { workspaceId } = ctx.identity
      const options = {
        sandboxed: deps.isSandboxed(workspaceId),
        remember: !deps.isScratch(workspaceId),
      }
      const results = targets.map((target) => deps.grants.admit(target.path, options))
      const files: FileTarget[] = targets.flatMap((target, i) => {
        const verdict = results[i]
        return verdict.ok ? [{ ...target, path: verdict.path }] : []
      })
      if (files.length > 0) {
        const res = await deps.execCommand(targetOf(ctx.identity), OPEN_FILES_COMMAND, {
          files,
          ...(request?.background === true ? { background: true } : {}),
        })
        if (!res.ok) return { ok: false, error: res.error.code, message: res.error.message }
      }
      return { ok: true, results }
    },
  })

  registerControlMethod('file.reveal', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx): Promise<RevealFolderResult> => {
      const raw = (params as { path?: unknown } | null)?.path
      if (typeof raw !== 'string' || raw.length === 0) {
        return { ok: false, error: 'invalid-args', message: 'expected a folder path' }
      }
      const path = deps.confineFolder(raw)
      if (!path) return { ok: false, error: 'outside-home' }
      const kind = folderKind(path)
      if (kind !== 'directory') {
        return { ok: false, error: kind === 'missing' ? 'not-found' : 'not-a-directory' }
      }
      const res = await deps.execCommand(targetOf(ctx.identity), REVEAL_FOLDER_COMMAND, { path })
      if (!res.ok) return { ok: false, error: res.error.code, message: res.error.message }
      return { ok: true, path }
    },
  })
}

export interface ExtensionOpenFileDeps {
  grants: OpenFileGrants
  windowOf: (workspaceId: string) => string | undefined
  execCommand: OpenFileDeps['execCommand']
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export async function openFileForExtension(
  deps: ExtensionOpenFileDeps,
  req: ExtensionOpenFileRequest,
): Promise<ExtensionResult> {
  const windowId = deps.windowOf(req.workspaceId)
  if (!windowId) return { ok: false, error: 'unknown-workspace' }
  const path = deps.grants.confine(req.path)
  if (!path) return { ok: false, error: 'outside-roots', message: req.path }
  if (!isRegularFile(path)) return { ok: false, error: 'not-a-file', message: path }
  const file: FileTarget = { path }
  if (req.line) {
    file.line = req.line
    if (req.column) file.column = req.column
  }
  const res = await deps.execCommand(
    { windowId, workspaceId: req.workspaceId, paneId: null },
    OPEN_FILES_COMMAND,
    { files: [file] },
  )
  return res.ok ? { ok: true } : { ok: false, error: res.error.code, message: res.error.message }
}
