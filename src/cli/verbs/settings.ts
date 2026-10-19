import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { CommandResult } from '../../shared/control/commands'
import { parseArgs } from '../common/args'
import { failUsage, failVerb, failWith } from '../common/failure'

export async function runSettingsVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]

  if (sub === 'get') {
    const key = process.argv[4]
    const res = await conn.sendRequest<CommandResult>('command.exec', {
      id: 'settings.get',
      args: key ? { key } : undefined,
    })
    if (res.ok) {
      console.log(JSON.stringify(res.result ?? null))
    } else {
      failWith(res.error?.message ?? 'failed')
    }
  } else if (sub === 'set') {
    const { positional, booleans } = parseArgs(process.argv.slice(4), {
      booleans: { dryRun: '--dry-run' },
      unknown: 'keep',
    })
    const { dryRun } = booleans
    const [key, rawValue] = positional
    if (!key || rawValue === undefined) {
      failVerb('missing arguments')
      return
    }
    let value: unknown
    try {
      value = JSON.parse(rawValue)
    } catch {
      value = rawValue
    }
    await printSettingsCommand(conn, 'settings.set', { key, value, ...(dryRun ? { dryRun } : {}) })
  } else if (sub === 'unset') {
    const key = process.argv[4]
    if (!key) {
      failVerb('missing arguments')
      return
    }
    await printSettingsCommand(conn, 'settings.unset', { key })
  } else if (sub === 'schema') {
    const key = process.argv[4]
    await printSettingsCommand(conn, 'settings.schema', key ? { key } : undefined)
  } else {
    failUsage('settings')
  }
}

async function printSettingsCommand(
  conn: MessageConnection,
  id: string,
  args: Record<string, unknown> | undefined,
): Promise<void> {
  const res = await conn.sendRequest<CommandResult>('command.exec', { id, args })
  if (res.ok) {
    console.log(JSON.stringify(res.result ?? null))
  } else {
    failWith(res.error?.message ?? 'failed')
  }
}
