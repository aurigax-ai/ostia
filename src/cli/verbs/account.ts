import type { MessageConnection } from 'vscode-jsonrpc/node'
import { parseArgs } from '../common/args'
import { failUsage, failWith } from '../common/failure'
import { tsvLine } from '../common/lineField'

interface AccountRow {
  number: number
  email: string | null
  current: boolean
  enabled: boolean
  session: number | null
  weekly: number | null
}

type ListAnswer = { ok: true; accounts: AccountRow[] } | { ok: false; error: string }

type SwitchAnswer =
  | { ok: true; number: number; email: string | null }
  | { ok: false; error: string }

const DEFAULT_LABEL = 'default'

function rowState(row: AccountRow): string {
  if (row.current) return 'current'
  return row.enabled ? '' : 'off'
}

function percentText(percent: number | null): string {
  return percent === null ? '' : `${percent}%`
}

function isolatedText(error: string): string {
  const kind = { scratch: 'a scratch', manager: 'the manager' }[error] ?? 'a sandboxed'
  return `${kind} pane has only the default account`
}

function switchProblem(error: string, target: string): string {
  if (error === 'unknown-account') return `no account '${target}'; run ostia account list`
  if (error === 'account-off')
    return `'${target}' is turned off; the human turns it on in Settings › Claude accounts`
  if (error === 'not-approved') return 'the human did not approve the switch'
  if (error === 'sandboxed' || error === 'scratch' || error === 'manager')
    return isolatedText(error)
  return 'the account could not be switched'
}

export async function runAccountVerb(conn: MessageConnection): Promise<void> {
  const [verb, ...rest] = process.argv.slice(3)
  const { positional, booleans } = parseArgs(rest, { booleans: { json: '--json' } })
  if (verb === 'list' && positional.length === 0) {
    const listed = await conn.sendRequest<ListAnswer>('account.list')
    if (!listed.ok) {
      failWith(`${listed.error}: ${isolatedText(listed.error)}`)
      return
    }
    const { accounts } = listed
    if (booleans.json) {
      console.log(JSON.stringify({ accounts }))
      return
    }
    for (const row of accounts) {
      console.log(
        tsvLine([
          String(row.number),
          row.email ?? DEFAULT_LABEL,
          rowState(row),
          percentText(row.session),
          percentText(row.weekly),
        ]),
      )
    }
    return
  }
  if (verb === 'switch' && positional.length === 1 && !booleans.json) {
    const answer = await conn.sendRequest<SwitchAnswer>('account.switch', { target: positional[0] })
    if (!answer.ok) {
      failWith(`${answer.error}: ${switchProblem(answer.error, positional[0])}`)
      return
    }
    console.log(`${answer.number}\t${answer.email ?? DEFAULT_LABEL}`)
    return
  }
  failUsage('account')
}
