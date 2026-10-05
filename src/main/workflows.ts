import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ipcMain } from 'electron'
import { parseAllDocuments, stringify } from 'yaml'
import {
  type Workflow,
  type WorkflowEntry,
  type WorkflowListing,
  type WorkflowProblem,
  type WorkflowSaveResult,
  type WorkflowSource,
  parseWorkflow,
  workflowDocument,
  workflowFileStem,
} from '../shared/workflows'
import { registerControlMethod } from './controlServer'
import { PROJECT_DIR } from './jsonStore'
import { resolveSafe } from './pathGuard'

export const WORKFLOW_FILE_MAX_BYTES = 64 * 1024
export const WORKFLOW_FILES_MAX = 200
export const WORKFLOWS_PER_FILE_MAX = 50
const WORKFLOW_FILE = /\.ya?ml$/i
const SAVE_ATTEMPTS = 100

export interface ExtensionWorkflows {
  extId: string
  workflows: Workflow[]
}

export interface WorkflowSources {
  userDir: string
  workDir?: string
  extensions: ExtensionWorkflows[]
}

export function workspaceWorkflowsDir(workDir: string): string {
  return join(workDir, PROJECT_DIR, 'workflows')
}

function workspaceWorkflows(workDir: string): WorkflowListing {
  return readWorkflowDir(workspaceWorkflowsDir(workDir), 'workspace')
}

function isRealDir(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

export function parseWorkflowFile(text: string): Workflow[] | Error {
  const docs = parseAllDocuments(text)
  if (!Array.isArray(docs)) return new Error('not a YAML document stream')
  const out: Workflow[] = []
  for (const doc of docs) {
    if (doc.errors.length > 0) return new Error(doc.errors[0].message.split('\n')[0])
    let value: unknown
    try {
      value = doc.toJS({ maxAliasCount: 0 })
    } catch (err) {
      return err as Error
    }
    if (value === null || value === undefined) continue
    const items = Array.isArray(value) ? value : [value]
    for (const [i, item] of items.entries()) {
      const workflow = parseWorkflow(item)
      if (workflow instanceof Error) {
        return items.length > 1 ? new Error(`item ${i + 1}: ${workflow.message}`) : workflow
      }
      out.push(workflow)
    }
  }
  if (out.length > WORKFLOWS_PER_FILE_MAX) {
    return new Error(`more than ${WORKFLOWS_PER_FILE_MAX} workflows in one file`)
  }
  return out
}

function readFile(path: string): string | Error {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (err) {
    return err as Error
  }
  if (stat.isSymbolicLink()) return new Error('symbolic links are not read')
  if (!stat.isFile()) return new Error('not a regular file')
  if (stat.size > WORKFLOW_FILE_MAX_BYTES) {
    return new Error(`larger than ${WORKFLOW_FILE_MAX_BYTES / 1024} KiB`)
  }
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    return err as Error
  }
}

export function readWorkflowDir(dir: string, source: WorkflowSource): WorkflowListing {
  const listing: WorkflowListing = { workflows: [], problems: [] }
  if (!isRealDir(dir)) return listing
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((n) => WORKFLOW_FILE.test(n))
      .sort()
  } catch {
    return listing
  }
  if (names.length > WORKFLOW_FILES_MAX) {
    listing.problems.push({
      source,
      origin: basename(dir),
      error: `only the first ${WORKFLOW_FILES_MAX} files are read`,
    })
    names = names.slice(0, WORKFLOW_FILES_MAX)
  }
  for (const name of names) {
    const text = readFile(join(dir, name))
    const parsed = text instanceof Error ? text : parseWorkflowFile(text)
    if (parsed instanceof Error) {
      listing.problems.push({ source, origin: name, error: parsed.message })
      continue
    }
    for (const w of parsed) listing.workflows.push({ ...w, source, origin: name })
  }
  return listing
}

export function loadWorkflows(sources: WorkflowSources): WorkflowListing {
  const parts: WorkflowListing[] = []
  if (sources.workDir) parts.push(workspaceWorkflows(sources.workDir))
  parts.push(readWorkflowDir(sources.userDir, 'user'))
  const workflows: WorkflowEntry[] = parts.flatMap((p) => p.workflows)
  const problems: WorkflowProblem[] = parts.flatMap((p) => p.problems)
  for (const ext of sources.extensions) {
    for (const w of ext.workflows) workflows.push({ ...w, source: 'extension', origin: ext.extId })
  }
  return { workflows, problems }
}

export function saveWorkflow(userDir: string, raw: unknown): WorkflowSaveResult {
  const workflow = parseWorkflow(raw)
  if (workflow instanceof Error) return { ok: false, error: workflow.message }
  try {
    mkdirSync(userDir, { recursive: true, mode: 0o700 })
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  if (!isRealDir(userDir)) return { ok: false, error: 'the workflows folder is not a directory' }
  const text = stringify(workflowDocument(workflow), { lineWidth: 0 })
  const stem = workflowFileStem(workflow.name)
  for (let n = 1; n <= SAVE_ATTEMPTS; n++) {
    const file = n === 1 ? `${stem}.yaml` : `${stem}-${n}.yaml`
    try {
      writeFileSync(join(userDir, file), text, { flag: 'wx', mode: 0o600 })
      return { ok: true, file }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { ok: false, error: (err as Error).message }
      }
    }
  }
  return { ok: false, error: 'too many workflows with this name' }
}

export interface WorkflowDeps {
  userDir: string
  roots: () => string[]
  workDirForWorkspace: (workspaceId?: string) => string | undefined
  extensionWorkflows: () => ExtensionWorkflows[]
}

function listFor(deps: WorkflowDeps, workspaceId: string | null | undefined): WorkflowListing {
  const workDir = deps.workDirForWorkspace(workspaceId ?? undefined)
  const safe = workDir ? resolveSafe(workDir, deps.roots()) : null
  return loadWorkflows({
    userDir: deps.userDir,
    workDir: safe ?? undefined,
    extensions: deps.extensionWorkflows(),
  })
}

export function registerWorkflowIpc(deps: WorkflowDeps): void {
  ipcMain.handle('workflows:list', (_e, workspaceId: unknown) =>
    listFor(deps, typeof workspaceId === 'string' ? workspaceId : null),
  )
  ipcMain.handle('workflows:save', (_e, doc: unknown) => saveWorkflow(deps.userDir, doc))
}

export function registerWorkflowMethods(deps: WorkflowDeps): void {
  registerControlMethod('workflow.list', {
    cap: 'read-board',
    handler: (_params, ctx) => listFor(deps, ctx.identity.workspaceId),
  })
}
