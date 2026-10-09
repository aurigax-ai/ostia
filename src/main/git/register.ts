import { ipcMain } from 'electron'
import type { Capability } from '../../shared/capabilities'
import type { ChangeArea, GitFailure, GitPathsRequest } from '../../shared/git'
import { registerControlMethod } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'
import { AREAS, type GitCaller, type GitCommands } from './commands'
import { parseScope } from './scope'
import type { GitService } from './service'

const READ_BOARD: Capability = 'read-board'
const NOT_OWNED: GitFailure = { ok: false, error: 'not-owned' }

export interface GitMethodsDeps {
  commands: GitCommands
  callerOf: (identity: PaneIdentity) => GitCaller
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

function text(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw ? raw : undefined
}

export function pathsRequest(raw: unknown): GitPathsRequest {
  const r = record(raw)
  const paths = Array.isArray(r.paths)
    ? r.paths.filter((p): p is string => typeof p === 'string' && p !== '')
    : []
  return { paths, all: r.all === true }
}

function stagedArea(raw: Record<string, unknown>): ChangeArea | undefined {
  return raw.staged === true ? 'staged' : undefined
}

export function registerGitMethods(deps: GitMethodsDeps): void {
  const { commands, callerOf } = deps
  const method = (
    name: string,
    run: (caller: GitCaller, params: Record<string, unknown>) => unknown,
  ): void => {
    registerControlMethod(`git.${name}`, {
      cap: READ_BOARD,
      handler: (params, ctx) => run(callerOf(ctx.identity), record(params)),
    })
  }
  method('status', (caller) => commands.status(caller))
  method('changes', (caller) => commands.changes(caller))
  method('diff', (caller, p) => commands.diff(caller, text(p.path), stagedArea(p)))
  method('open', (caller, p) => commands.open(caller, text(p.path), stagedArea(p)))
  method('log', (caller, p) => commands.log(caller, p.limit, p.text === true))
  method('blame', (caller, p) => commands.blame(caller, text(p.path), p.text === true))
  method('stage', (caller, p) => commands.changeIndex(caller, 'stage', pathsRequest(p)))
  method('unstage', (caller, p) => commands.changeIndex(caller, 'unstage', pathsRequest(p)))
  method('commit', (caller, p) => commands.commit(caller, p.message))
}

export interface GitIpcDeps {
  commands: GitCommands
  service: GitService
  ownerWindow: (workspaceId: string) => string | undefined
  workDirOf: (workspaceId: string) => string | undefined
}

export function registerGitIpc(deps: GitIpcDeps): void {
  const { commands, service } = deps
  const owned = <T>(
    channel: string,
    run: (caller: GitCaller, ...args: unknown[]) => Promise<T>,
  ): void => {
    ipcMain.handle(channel, (e, workspaceId: unknown, ...args: unknown[]) => {
      if (
        typeof workspaceId !== 'string' ||
        deps.ownerWindow(workspaceId) !== String(e.sender.id)
      ) {
        return NOT_OWNED
      }
      return run({ workspaceId, workDir: deps.workDirOf(workspaceId) }, ...args)
    })
  }
  const area = (raw: unknown): ChangeArea | undefined => AREAS.find((a) => a === raw)

  ipcMain.on('git:watch', (e, workspaceIds: unknown) => {
    service.watch(String(e.sender.id), workspaceIds)
  })
  owned('git:changes', (caller) => commands.changes(caller))
  owned('git:graph', (caller, limit) => commands.graph(caller, limit))
  owned('git:commit-files', (caller, sha) => commands.commitFiles(caller, sha))
  owned('git:blame', (caller, file) => commands.blame(caller, text(file), false))
  owned('git:open-change', (caller, path, where) => commands.open(caller, text(path), area(where)))
  owned('git:open-commit-file', (caller, sha, path) => commands.openCommitFile(caller, sha, path))
  owned('git:stage', (caller, req) => commands.changeIndex(caller, 'stage', pathsRequest(req)))
  owned('git:unstage', (caller, req) => commands.changeIndex(caller, 'unstage', pathsRequest(req)))
  owned('git:commit', (caller, message) => commands.commit(caller, message))
  owned('git:discard', (caller, req) => commands.discard(caller, pathsRequest(req)))
  owned('git:set-scope', async (caller, raw) => {
    const scope = parseScope(raw)
    if (!scope) return { ok: false, error: 'invalid-args', message: 'scope' } satisfies GitFailure
    return commands.setScope(caller, scope)
  })
}
