import type { MessageConnection } from 'vscode-jsonrpc/node'
import { parseArgs } from '../common/args'
import { failUsage, failWith } from '../common/failure'
import { tsvLine } from '../common/lineField'

interface AccountRow {
  number: number
  email: string | null
  current: boolean
}

type SwitchAnswer =
  | { ok: true; number: number; email: string | null }
  | { ok: false; error: string }

const DEFAULT_LABEL = 'default'

export async function runAccountVerb(conn: MessageConnection): Promise<void> {
  const [verb, ...rest] = process.argv.slice(3)
  const { positional, booleans } = parseArgs(rest, { booleans: { json: '--json' } })
  if (verb === 'list' && positional.length === 0) {
    const { accounts } = await conn.sendRequest<{ accounts: AccountRow[] }>('account.list')
    if (booleans.json) {
      console.log(JSON.stringify({ accounts }))
      return
    }
    for (const row of accounts) {
      console.log(
        tsvLine([String(row.number), row.email ?? DEFAULT_LABEL, row.current ? 'current' : '']),
      )
    }
    return
  }
  if (verb === 'switch' && positional.length === 1 && !booleans.json) {
    const answer = await conn.sendRequest<SwitchAnswer>('account.switch', { target: positional[0] })
    if (!answer.ok) {
      failWith(`${answer.error}: no account '${positional[0]}'; run ostia account list`)
      return
    }
    console.log(`${answer.number}\t${answer.email ?? DEFAULT_LABEL}`)
    return
  }
  failUsage('account')
}
