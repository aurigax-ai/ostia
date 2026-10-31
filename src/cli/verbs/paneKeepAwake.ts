import type { MessageConnection } from 'vscode-jsonrpc/node'
import { shortId } from '../../shared/panes/paneStatus'
import { parseArgs } from '../common/args'
import { usageOf } from '../common/usageTable'

const USAGE = usageOf('pane')

export type PaneKeepAwakeCall = {
  method: 'pane.keepAwake'
  params: { on: boolean }
  json: boolean
}

export function parseKeepAwake(argv: string[]): PaneKeepAwakeCall {
  const { positional, booleans } = parseArgs(argv, {
    booleans: { off: '--off', json: '--json' },
  })
  if (positional.length > 0) throw new Error(USAGE)
  return { method: 'pane.keepAwake', params: { on: !booleans.off }, json: booleans.json }
}

export function keepAwakeLine(result: { paneId: string; keepAwake: boolean }): string {
  return `${shortId(result.paneId)} ${result.keepAwake ? 'kept awake' : 'no longer kept awake'}`
}

export async function runPaneKeepAwake(
  conn: MessageConnection,
  call: PaneKeepAwakeCall,
): Promise<number> {
  const result = await conn.sendRequest<{ paneId: string; keepAwake: boolean }>(
    call.method,
    call.params,
  )
  console.log(call.json ? JSON.stringify(result) : keepAwakeLine(result))
  return 0
}
