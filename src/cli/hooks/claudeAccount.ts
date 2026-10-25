import type { MessageConnection } from 'vscode-jsonrpc/node'
import { fail } from '../common/failure'

export async function runClaudeAccountVerb(conn: MessageConnection): Promise<void> {
  const [verb, ...rest] = process.argv.slice(3)
  if (verb !== 'start' || rest.length > 0) {
    fail('ostia claude-account: usage: claude-account start')
    return
  }
  const { dir } = await conn.sendRequest<{ dir: string }>('claudeAccount.start', {})
  if (dir.startsWith('/')) console.log(dir)
}
