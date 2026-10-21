import type { MessageConnection } from 'vscode-jsonrpc/node'
import { shortId } from '../../shared/panes/paneStatus'
import { parseArgs } from '../common/args'
import { tsvLine } from '../common/lineField'
import { usageOf } from '../common/usageTable'

const USAGE = usageOf('pane')

interface PaneNameParams {
  name?: string
  desc?: string
  clear?: true
}

export type PaneNameCall = { method: 'pane.name'; params: PaneNameParams; json: boolean }

export function parseName(argv: string[]): PaneNameCall {
  const { positional, values, booleans } = parseArgs(argv, {
    values: { desc: '--desc' },
    booleans: { clear: '--clear', json: '--json' },
  })
  if (booleans.clear) {
    if (positional.length > 0 || values.desc !== undefined) throw new Error(USAGE)
    return { method: 'pane.name', params: { clear: true }, json: booleans.json }
  }
  if (positional.length !== 1) throw new Error(USAGE)
  return {
    method: 'pane.name',
    params: { name: positional[0], ...(values.desc === undefined ? {} : { desc: values.desc }) },
    json: booleans.json,
  }
}

export function nameLine(result: { paneId: string; name?: string; desc?: string }): string {
  return result.name
    ? tsvLine([shortId(result.paneId), result.name, ...(result.desc ? [result.desc] : [])])
    : `${shortId(result.paneId)} has no name`
}

export async function runPaneName(conn: MessageConnection, call: PaneNameCall): Promise<number> {
  const result = await conn.sendRequest<{ paneId: string; name?: string; desc?: string }>(
    call.method,
    call.params,
  )
  console.log(call.json ? JSON.stringify(result) : nameLine(result))
  return 0
}
