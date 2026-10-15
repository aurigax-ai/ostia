import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { CommandDescriptor, CommandResult } from '../../shared/types'
import { commandHelp, wantsHelp } from '../common/commandHelp'
import { buildCommandCall, parseCommandFlags, resolveWorkspaceRef } from '../common/crossWorkspace'
import { fail } from '../common/failure'

export async function runCommandList(conn: MessageConnection): Promise<void> {
  console.log(JSON.stringify(await conn.sendRequest('command.list'), null, 2))
}

export async function runRawCommand(conn: MessageConnection, cmd: string): Promise<void> {
  if (wantsHelp(process.argv[3])) {
    const list = await conn.sendRequest<CommandDescriptor[]>('command.list')
    const found = list.find((c) => c.id === cmd)
    if (found) console.log(commandHelp(found))
    else fail(`ostia: unknown command '${cmd}' (see: ostia commands)`)
    return
  }
  const flags = parseCommandFlags(process.argv.slice(3))
  const workspace = flags.workspace ? await resolveWorkspaceRef(conn, flags.workspace) : undefined
  const res = await conn.sendRequest<CommandResult>(
    'command.exec',
    buildCommandCall(cmd, flags, workspace),
  )
  if (!res.ok) return fail(`ostia: ${res.error?.message}`)
  console.log('ok')
  if (res.result !== undefined) console.log(JSON.stringify(res.result))
}
