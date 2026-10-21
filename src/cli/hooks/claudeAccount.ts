import type { MessageConnection } from 'vscode-jsonrpc/node'
import { fail } from '../common/failure'

export async function runClaudeAccountVerb(conn: MessageConnection): Promise<void> {
  const [verb, ...rest] = process.argv.slice(3)
  if (verb !== 'start') {
    fail('ostia claude-account: usage: claude-account start [-- <claude args>]')
    return
  }
  const args = rest[0] === '--' ? rest.slice(1) : rest
  const { dir } = await conn.sendRequest<{ dir: string }>('claudeAccount.start', { args })
  if (dir.startsWith('/')) console.log(dir)
}
