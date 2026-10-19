import { isAbsolute, resolve } from 'node:path'
import type { FileOpResult } from '../../shared/files/fileOps'
import type { FileOps } from './fileOps'

export interface FileGuardDeps {
  fileOps: Pick<
    FileOps,
    'create' | 'rename' | 'move' | 'copy' | 'trash' | 'importInto' | 'draggable'
  >
  windowOfWorkspace: (workspaceId: string) => string | undefined
  sandboxRefusal: (workspaceId: string, path: string) => string | null
}

type Refusal = Extract<FileOpResult, { ok: false }>

const OUTSIDE: Refusal = { ok: false, error: 'outside' }
const SANDBOXED: Refusal = { ok: false, error: 'sandboxed' }

function refusal(
  deps: FileGuardDeps,
  senderId: string,
  workspaceId: unknown,
  targets: unknown,
): Refusal | null {
  if (typeof workspaceId !== 'string') return OUTSIDE
  if (deps.windowOfWorkspace(workspaceId) !== senderId) return OUTSIDE
  const list = Array.isArray(targets) ? targets : [targets]
  const paths: string[] = []
  for (const target of list) {
    if (typeof target !== 'string' || !isAbsolute(target)) return OUTSIDE
    paths.push(resolve(target))
  }
  return paths.some((path) => deps.sandboxRefusal(workspaceId, path) !== null) ? SANDBOXED : null
}

export interface GuardedFileOps {
  create: (
    senderId: string,
    workspaceId: unknown,
    dir: unknown,
    name: unknown,
    kind: unknown,
  ) => Promise<FileOpResult>
  rename: (
    senderId: string,
    workspaceId: unknown,
    path: unknown,
    name: unknown,
  ) => Promise<FileOpResult>
  move: (
    senderId: string,
    workspaceId: unknown,
    paths: unknown,
    dir: unknown,
  ) => Promise<FileOpResult>
  copy: (
    senderId: string,
    workspaceId: unknown,
    paths: unknown,
    dir: unknown,
  ) => Promise<FileOpResult>
  trash: (senderId: string, workspaceId: unknown, paths: unknown) => Promise<FileOpResult>
  importInto: (
    senderId: string,
    workspaceId: unknown,
    paths: unknown,
    dir: unknown,
    move: unknown,
  ) => Promise<FileOpResult>
  draggable: (senderId: string, workspaceId: unknown, path: unknown) => Promise<string | null>
}

export function guardFileOps(deps: FileGuardDeps): GuardedFileOps {
  const { fileOps } = deps
  const asList = (paths: unknown): unknown[] => (Array.isArray(paths) ? paths : [paths])
  return {
    create: async (senderId, workspaceId, dir, name, kind) =>
      refusal(deps, senderId, workspaceId, dir) ?? fileOps.create(dir, name, kind),
    rename: async (senderId, workspaceId, path, name) =>
      refusal(deps, senderId, workspaceId, path) ?? fileOps.rename(path, name),
    move: async (senderId, workspaceId, paths, dir) =>
      refusal(deps, senderId, workspaceId, [...asList(paths), dir]) ?? fileOps.move(paths, dir),
    copy: async (senderId, workspaceId, paths, dir) =>
      refusal(deps, senderId, workspaceId, dir) ?? fileOps.copy(paths, dir),
    trash: async (senderId, workspaceId, paths) =>
      refusal(deps, senderId, workspaceId, paths) ?? fileOps.trash(paths),
    importInto: async (senderId, workspaceId, paths, dir, move) =>
      refusal(deps, senderId, workspaceId, dir) ?? fileOps.importInto(paths, dir, move === true),
    draggable: async (senderId, workspaceId, path) =>
      refusal(deps, senderId, workspaceId, path) === null ? fileOps.draggable(path) : null,
  }
}
