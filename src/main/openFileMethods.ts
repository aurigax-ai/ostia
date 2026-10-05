import { statSync } from 'node:fs'
import type { ExtensionOpenFileRequest, ExtensionResult } from '../shared/extensions'
import {
  type FileTarget,
  OPEN_FILES_COMMAND,
  OPEN_FILES_MAX,
  type OpenFilesResult,
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
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
}

export function registerOpenFileMethods(deps: OpenFileDeps): void {
  registerControlMethod('file.open', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx): Promise<OpenFilesResult> => {
      const targets = parseFileTargets((params as { files?: unknown } | null)?.files)
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
        const res = await deps.execCommand(targetOf(ctx.identity), OPEN_FILES_COMMAND, { files })
        if (!res.ok) return { ok: false, error: res.error.code, message: res.error.message }
      }
      return { ok: true, results }
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
