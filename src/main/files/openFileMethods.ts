import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { DIFF_TEXT_MAX } from '../../shared/extensions'
import type { ExtensionOpenFileRequest, ExtensionResult } from '../../shared/extensions'
import {
  type DiffFilesResult,
  type FileTarget,
  OPEN_DIFF_COMMAND,
  OPEN_FILES_COMMAND,
  OPEN_FILES_MAX,
  type OpenFilesResult,
  REVEAL_FOLDER_COMMAND,
  type RevealFolderResult,
  type WaitOutcome,
  openedPaneIds,
  parseFileTargets,
  parsePlacement,
} from '../../shared/files/openFiles'
import type { CommandResult, CommandTarget } from '../../shared/types'
import { targetOf } from '../attention/attention'
import { type ControlMethodContext, registerControlMethod } from '../control/controlServer'
import type { OpenFileGrants } from './openFileGrants'
import type { OpenWaits } from './openWaits'

export interface OpenFileDeps {
  grants: OpenFileGrants
  isSandboxed: (workspaceId: string) => boolean
  isScratch: (workspaceId: string) => boolean
  confineFolder: (path: string) => string | null
  waits: OpenWaits
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
}

function folderKind(path: string): 'directory' | 'other' | 'missing' {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'other'
  } catch {
    return 'missing'
  }
}

type DiffSide =
  | { ok: true; path: string; text: string }
  | { ok: false; error: string; path: string }

function readDiffSide(deps: OpenFileDeps, raw: string, workspaceId: string): DiffSide {
  const verdict = deps.grants.admit(raw, {
    sandboxed: deps.isSandboxed(workspaceId),
    remember: !deps.isScratch(workspaceId),
  })
  if (!verdict.ok) return { ok: false, error: verdict.error, path: verdict.path }
  let bytes: Buffer
  try {
    if (statSync(verdict.path).size > DIFF_TEXT_MAX) {
      return { ok: false, error: 'too-large', path: verdict.path }
    }
    bytes = readFileSync(verdict.path)
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    return { ok: false, error: missing ? 'not-found' : 'unreadable', path: verdict.path }
  }
  if (bytes.includes(0)) return { ok: false, error: 'binary', path: verdict.path }
  return { ok: true, path: verdict.path, text: bytes.toString('utf8') }
}

async function waitFor(
  deps: OpenFileDeps,
  ctx: ControlMethodContext,
  paneIds: string[],
): Promise<WaitOutcome> {
  const { windowId, workspaceId, paneId } = ctx.identity
  const wait = deps.waits.start({ windowId, workspaceId, callerPaneId: paneId, paneIds })
  const closed = ctx.conn.onClose(() => deps.waits.cancel(wait.id))
  try {
    return await wait.done
  } finally {
    closed.dispose()
  }
}

export function registerOpenFileMethods(deps: OpenFileDeps): void {
  registerControlMethod('file.open', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx): Promise<OpenFilesResult> => {
      const request = params as {
        files?: unknown
        background?: unknown
        placement?: unknown
        wait?: unknown
      } | null
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
      if (files.length === 0) return { ok: true, results }
      const wait = request?.wait === true
      const placement = parsePlacement(request?.placement)
      const res = await deps.execCommand(targetOf(ctx.identity), OPEN_FILES_COMMAND, {
        files,
        ...(request?.background === true ? { background: true } : {}),
        ...(placement ? { placement } : {}),
        ...(wait ? { wait: true } : {}),
      })
      if (!res.ok) return { ok: false, error: res.error.code, message: res.error.message }
      if (!wait) return { ok: true, results }
      return { ok: true, results, waited: await waitFor(deps, ctx, openedPaneIds(res.result)) }
    },
  })

  registerControlMethod('file.diff', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx): Promise<DiffFilesResult> => {
      const request = params as {
        original?: unknown
        modified?: unknown
        background?: unknown
        wait?: unknown
      } | null
      if (typeof request?.original !== 'string' || typeof request.modified !== 'string') {
        return { ok: false, error: 'invalid-args', message: 'expected two files' }
      }
      const { workspaceId } = ctx.identity
      const original = readDiffSide(deps, request.original, workspaceId)
      if (!original.ok) return original
      const modified = readDiffSide(deps, request.modified, workspaceId)
      if (!modified.ok) return modified
      const res = await deps.execCommand(targetOf(ctx.identity), OPEN_DIFF_COMMAND, {
        title: `${basename(original.path)} ↔ ${basename(modified.path)}`,
        original: original.text,
        modified: modified.text,
        path: modified.path,
        ...(request.background === true ? { background: true } : {}),
      })
      if (!res.ok) return { ok: false, error: res.error.code, message: res.error.message }
      if (request.wait !== true) return { ok: true }
      return { ok: true, waited: await waitFor(deps, ctx, openedPaneIds(res.result)) }
    },
  })

  registerControlMethod('file.reveal', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx): Promise<RevealFolderResult> => {
      const raw = (params as { path?: unknown } | null)?.path
      if (typeof raw !== 'string' || raw.length === 0) {
        return { ok: false, error: 'invalid-args', message: 'expected a folder path' }
      }
      if (deps.isSandboxed(ctx.identity.workspaceId)) return { ok: false, error: 'outside-sandbox' }
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
