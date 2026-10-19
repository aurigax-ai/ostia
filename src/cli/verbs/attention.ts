import type { MessageConnection } from 'vscode-jsonrpc/node'
import { parseArgs } from '../common/args'
import { fail, failUsage } from '../common/failure'
import { readAllStdin } from '../common/stdinText'
import { STATE_VERBS, messageFromStdin } from '../hooks/offlineAttention'

export async function runStateVerb(conn: MessageConnection): Promise<void> {
  const { positional, values } = parseArgs(process.argv.slice(3), {
    values: { pane: '--pane' },
    unknown: 'keep',
  })
  const paneId = values.pane
  const [state, rawMessage] = positional
  if (!state || !STATE_VERBS.includes(state)) return failUsage('state')
  const message = rawMessage === '-' ? messageFromStdin(await readAllStdin()) : rawMessage
  const res = await conn.sendRequest<{ ok: boolean; error?: string; message?: string }>(
    'pane.setAttention',
    { state, message, paneId },
  )
  if (res.ok) {
    console.log('ok')
  } else {
    fail(`ostia state: ${res.error ?? 'failed'}${res.message ? ` (${res.message})` : ''}`)
  }
}

export async function runNotify(conn: MessageConnection): Promise<void> {
  const [title, body] = process.argv.slice(3)
  const res = await conn.sendRequest<{ ok: boolean; error?: string }>('notify', { title, body })
  if (res.ok) console.log('ok')
  else fail(`ostia notify: ${res.error ?? 'failed'}`)
}
