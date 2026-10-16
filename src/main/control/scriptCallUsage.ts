import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type {
  ScriptTokenCallOutcome,
  ScriptTokenCallTarget,
} from '../../shared/permissions/scriptTokens'
import { resolveExternal } from './idRegistry'

const METHOD_NAME = /^[\w.-]{1,80}$/
const WORKSPACE_REF = /^[\w.:@-]{1,100}$/
const ERROR_CODE = /^([a-z][a-z0-9-]{0,40})(?::|$)/
const CAP_NAME = /^[a-z][a-z-]{0,40}$/

function fields(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {}
}

export function calledMethod(name: string, params: unknown): string {
  if (name !== 'command.exec') return name
  const id = fields(params).id
  return typeof id === 'string' && METHOD_NAME.test(id) ? id : name
}

export function calledTarget(params: unknown): ScriptTokenCallTarget {
  const p = fields(params)
  const paneRef = [p.pane, p.paneId, fields(p.args).paneId].find((v) => typeof v === 'string')
  const pane = typeof paneRef === 'string' ? resolveExternal(paneRef) : undefined
  if (pane?.kind === 'pane') return { workspaceId: pane.workspaceId, paneId: pane.externalId }
  const workspace = [fields(p.target).workspaceId, p.workspace, p.workspaceId].find(
    (v): v is string => typeof v === 'string' && WORKSPACE_REF.test(v),
  )
  return workspace ? { workspaceId: workspace } : {}
}

type CallOutcome = { outcome: ScriptTokenCallOutcome; code?: string }

function codeOf(message: string): string {
  return ERROR_CODE.exec(message)?.[1] ?? 'error'
}

export function resultOutcome(result: unknown): CallOutcome {
  const r = fields(result)
  if (r.ok !== false) return { outcome: 'ok' }
  const code = fields(r.error).code
  return { outcome: 'error', code: typeof code === 'string' ? codeOf(code) : 'error' }
}

export function errorOutcome(err: unknown): CallOutcome | null {
  const message = err instanceof Error ? err.message : String(err)
  if (message === 'unknown identity') return null
  const code = codeOf(message)
  if (code !== 'needs-elevation') return { outcome: 'error', code }
  const cap = message.slice(code.length + 1).trim()
  if (!CAP_NAME.test(cap)) return { outcome: 'missing-permission', code }
  return {
    outcome: cap === 'all-workspaces' ? 'out-of-scope' : 'missing-permission',
    code: `${code}: ${cap}`,
  }
}
