import type { MessageConnection } from 'vscode-jsonrpc/node'
import { CONTROL_MESSAGE_ENVELOPE, CONTROL_MESSAGE_MAX } from '../../shared/control/messageLimit'
import { wantsHelp } from '../common/commandHelp'
import { fail, failUsage } from '../common/failure'
import { tsvLine } from '../common/lineField'
import { readStdinUpTo, StdinTooLarge } from '../common/stdinText'
import { findNoun, topUsage } from '../common/usageTable'

interface ExtCommandInfo {
  id: string
  title: string
  usage?: string
  stdin: boolean
}

interface ExtInfo {
  id: string
  name: string
  status: string
  verb?: string
  commands: ExtCommandInfo[]
}

type ExtResult =
  | { ok: true; text?: string; data?: unknown }
  | { ok: false; error: string; message?: string; data?: unknown }

export async function runExtList(conn: MessageConnection): Promise<void> {
  if (process.argv[3] !== 'list') return failUsage('ext')
  const list = await conn.sendRequest<ExtInfo[]>('ext.list')
  for (const ext of list) {
    console.log(tsvLine([ext.id, ext.status, ext.name]))
    for (const cmd of ext.commands)
      console.log(`  ${tsvLine([`ostia ${ext.verb ?? ext.id} ${cmd.usage ?? cmd.id}`, cmd.title])}`)
  }
}

function extUsage(ext: ExtInfo): string {
  const word = ext.verb ?? ext.id
  const lines = ext.commands.map((c) => `  ostia ${word} ${c.usage ?? c.id}\n      ${c.title}`)
  return [`usage: ostia ${word} <command>   ${ext.name}`, ...lines].join('\n')
}

export async function runExtCommand(
  conn: MessageConnection,
  extId: string,
  command: string | undefined,
  argv: string[],
): Promise<void> {
  const list = await conn.sendRequest<ExtInfo[]>('ext.list')
  const ext = list.find((e) => e.id === extId) ?? list.find((e) => e.verb === extId)
  const backing = findNoun(extId)?.extension
  if (!ext && backing) return fail(`ostia ${extId}: the ${backing} extension is not enabled`)
  if (!ext) {
    fail(topUsage())
    return
  }
  if (!command || (ext.verb && extId !== ext.verb)) {
    fail(extUsage(ext))
    return
  }
  const cmd = ext.commands.find((c) => c.id === command)
  if (!cmd || wantsHelp(command)) {
    if (cmd) console.log(extUsage(ext))
    else console.error(extUsage(ext))
    process.exitCode = cmd ? 0 : 1
    return
  }
  const args: { argv: string[]; stdin?: string } = { argv }
  if (cmd.stdin) {
    try {
      args.stdin = await readStdinUpTo(CONTROL_MESSAGE_MAX - CONTROL_MESSAGE_ENVELOPE)
    } catch (err) {
      if (err instanceof StdinTooLarge) return fail(`ostia ${extId} ${command}: ${err.message}`)
      throw err
    }
  }
  const res = await conn.sendRequest<ExtResult>('ext.invoke', { extId: ext.id, command, args })
  if (!res.ok) {
    const detail = res.message ? `${res.error}: ${res.message}` : res.error
    if (res.data !== undefined) console.log(JSON.stringify(res.data, null, 2))
    fail(`ostia ${extId} ${command}: ${detail}`)
  } else if (res.text !== undefined) {
    if (res.text) console.log(res.text)
  } else if (res.data !== undefined) {
    console.log(JSON.stringify(res.data, null, 2))
  } else {
    console.log('ok')
  }
}
