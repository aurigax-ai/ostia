import {
  type SavedAttention,
  attentionFileFor,
  isKeptAttentionState,
  writeSavedAttention,
} from '../../main/tmux/attentionFile'
import { type EnvSource, readEnv } from '../../shared/appEnv'
import { claudeAttention, isClaudeAttentionEvent } from '../../shared/claudeAttention'
import { parseArgs } from '../common/args'

export const STATE_VERBS = ['waiting', 'done', 'working', 'error', 'clear']

export function messageFromStdin(raw: string): string {
  const text = raw.trim()
  if (!text.startsWith('{')) return text
  try {
    const parsed = JSON.parse(text) as { message?: unknown; tool_name?: unknown }
    if (typeof parsed.message === 'string') return parsed.message
    return typeof parsed.tool_name === 'string'
      ? `Needs your permission to use ${parsed.tool_name}`
      : ''
  } catch {
    return text
  }
}

type OfflineAttention = { save?: SavedAttention | null } | null

export async function offlineAttention(
  args: readonly string[],
  readStdin: () => Promise<string>,
): Promise<OfflineAttention> {
  const [verb, ...rest] = args
  if (verb === 'claude-hook') {
    const event = rest[0]
    if (!isClaudeAttentionEvent(event)) return null
    const attention = claudeAttention(event, await readStdin())
    if (!attention) return {}
    return {
      save: {
        state: attention.state,
        ...(attention.message ? { message: attention.message } : {}),
      },
    }
  }
  if (verb !== 'state') return null
  const { positional, values } = parseArgs([...rest], {
    values: { pane: '--pane' },
    unknown: 'keep',
  })
  const [state, rawMessage] = positional
  if (values.pane || !state || !STATE_VERBS.includes(state)) return null
  if (!isKeptAttentionState(state)) return { save: null }
  const message = rawMessage === '-' ? messageFromStdin(await readStdin()) : rawMessage
  return { save: { state, ...(message ? { message } : {}) } }
}

export async function saveAttentionOffline(
  args: readonly string[],
  readStdin: () => Promise<string>,
  env: EnvSource = process.env,
): Promise<boolean> {
  const tokenFile = readEnv('TOKEN_FILE', env)
  if (!tokenFile) return false
  const attention = await offlineAttention(args, readStdin)
  if (!attention) return false
  if (attention.save === undefined) return true
  try {
    writeSavedAttention(attentionFileFor(tokenFile), attention.save)
    return true
  } catch {
    return false
  }
}
