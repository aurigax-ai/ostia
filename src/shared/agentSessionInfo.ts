export interface AgentSessionInfo {
  title: string | null
  model: string | null
  contextTokens: number | null
  contextWindow: number | null
  cwd: string | null
  branch: string | null
  version: string | null
  mode: string | null
  effort: string | null
}

export const EMPTY_SESSION_INFO: AgentSessionInfo = {
  title: null,
  model: null,
  contextTokens: null,
  contextWindow: null,
  cwd: null,
  branch: null,
  version: null,
  mode: null,
  effort: null,
}

const FIELD_MAX = 200

type Json = Record<string, unknown>

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, FIELD_MAX) : null
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null

function records(lines: readonly string[]): Json[] {
  const out: Json[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (isRecord(value)) out.push(value)
    } catch {}
  }
  return out
}

export function claudeSessionInfo(lines: readonly string[]): AgentSessionInfo {
  const info: AgentSessionInfo = { ...EMPTY_SESSION_INFO }
  let customTitle: string | null = null
  for (const entry of records(lines)) {
    const type = entry.type
    if (type === 'ai-title') info.title = text(entry.aiTitle) ?? info.title
    else if (type === 'custom-title') customTitle = text(entry.customTitle) ?? customTitle
    else if (type === 'permission-mode') info.mode = text(entry.permissionMode) ?? info.mode
    if (entry.isSidechain === true) continue
    if (type !== 'user' && type !== 'assistant') continue
    info.cwd = text(entry.cwd) ?? info.cwd
    info.branch = text(entry.gitBranch) ?? info.branch
    info.version = text(entry.version) ?? info.version
    if (type !== 'assistant' || !isRecord(entry.message)) continue
    info.model = text(entry.message.model) ?? info.model
    info.effort = text(entry.effort) ?? info.effort
    const usage = entry.message.usage
    if (!isRecord(usage)) continue
    const parts = [
      usage.input_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_read_input_tokens,
    ].map(count)
    if (parts.some((n) => n !== null)) {
      info.contextTokens = parts.reduce<number>((sum, n) => sum + (n ?? 0), 0)
    }
  }
  if (customTitle) info.title = customTitle
  return info
}

export function codexSessionInfo(lines: readonly string[]): AgentSessionInfo {
  const info: AgentSessionInfo = { ...EMPTY_SESSION_INFO }
  for (const entry of records(lines)) {
    const payload = entry.payload
    if (!isRecord(payload)) continue
    if (entry.type === 'session_meta') {
      info.cwd = text(payload.cwd) ?? info.cwd
      info.version = text(payload.cli_version) ?? info.version
      info.contextWindow = count(payload.context_window) ?? info.contextWindow
      if (isRecord(payload.git)) info.branch = text(payload.git.branch) ?? info.branch
    } else if (entry.type === 'turn_context') {
      info.model = text(payload.model) ?? info.model
      info.cwd = text(payload.cwd) ?? info.cwd
      info.effort = text(payload.effort) ?? info.effort
      info.mode = text(payload.approval_policy) ?? info.mode
    } else if (entry.type === 'event_msg' && payload.type === 'token_count') {
      const usage = isRecord(payload.info) ? payload.info : null
      if (!usage) continue
      info.contextWindow = count(usage.model_context_window) ?? info.contextWindow
      const last = usage.last_token_usage
      if (isRecord(last)) info.contextTokens = count(last.input_tokens) ?? info.contextTokens
    }
  }
  return info
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}
