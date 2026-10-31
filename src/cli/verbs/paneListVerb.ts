import type { MessageConnection } from 'vscode-jsonrpc/node'
import { shortId } from '../../shared/panes/paneStatus'
import { parseArgs } from '../common/args'
import { resolveWorkspaceRef } from '../common/crossWorkspace'
import { failWith } from '../common/failure'
import { tsvLine } from '../common/lineField'
import { usageOf } from '../common/usageTable'

const USAGE = usageOf('pane')

interface PaneListFilter {
  here?: true
  mine?: true
  workspace?: string
  states?: string[]
  kind?: string
}

const LIST_STATES = [
  'idle',
  'running',
  'working',
  'waiting',
  'done',
  'error',
  'hibernated',
  'waking',
] as const

export type PaneListCall = { method: 'pane.list'; params: PaneListFilter; json: boolean }

export function parseList(argv: string[]): PaneListCall {
  const { positional, values, lists, booleans } = parseArgs(argv, {
    values: { workspace: '--workspace', kind: '--kind' },
    lists: { state: '--state' },
    booleans: { here: '--here', mine: '--mine', json: '--json' },
  })
  if (
    positional.length > 0 ||
    (booleans.here && values.workspace !== undefined) ||
    (booleans.mine && (booleans.here || values.workspace !== undefined))
  ) {
    throw new Error(USAGE)
  }
  const unknown = lists.state.find((state) => !(LIST_STATES as readonly string[]).includes(state))
  if (unknown) throw new Error(`--state expects one of ${LIST_STATES.join(', ')}, got '${unknown}'`)
  return {
    method: 'pane.list',
    params: {
      ...(booleans.here ? { here: true as const } : {}),
      ...(booleans.mine ? { mine: true as const } : {}),
      ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
      ...(lists.state.length > 0 ? { states: lists.state } : {}),
      ...(values.kind === undefined ? {} : { kind: values.kind }),
    },
    json: booleans.json,
  }
}

export interface ListedPane {
  paneId: string
  workspaceId: string
  kind: string
  title: string
  name?: string
  description?: string
  running: boolean
  agentState?: string
  hibernated?: true
  keepAwake?: true
  waking?: true
  owner?: string
  finished?: boolean
  finishedSince?: number
}

function listedState(pane: ListedPane): string {
  return pane.hibernated
    ? 'hibernated'
    : pane.waking
      ? 'waking'
      : (pane.agentState ?? (pane.running ? 'running' : 'idle'))
}

export function paneLine(pane: ListedPane): string {
  return tsvLine([
    shortId(pane.paneId),
    pane.workspaceId,
    pane.kind,
    listedState(pane),
    pane.title,
    pane.owner ?? '-',
    pane.finished ? 'yes' : 'no',
    ...(pane.name ? [pane.name, ...(pane.description ? [pane.description] : [])] : []),
    ...(pane.keepAwake ? ['keep-awake'] : []),
  ])
}

export function filterPanes(
  panes: readonly ListedPane[],
  filter: { workspaceId?: string; states?: string[]; kind?: string },
): ListedPane[] {
  return panes.filter(
    (pane) =>
      (filter.workspaceId === undefined || pane.workspaceId === filter.workspaceId) &&
      (filter.kind === undefined || pane.kind === filter.kind) &&
      (filter.states === undefined || filter.states.includes(listedState(pane))),
  )
}

export async function runPaneList(conn: MessageConnection, call: PaneListCall): Promise<number> {
  const { here, mine, workspace, states, kind } = call.params
  const home = here
    ? (await conn.sendRequest<{ workspaceId?: string }>('whoami')).workspaceId
    : undefined
  if (here && !home) {
    failWith('no-pane: --here needs a pane; pass --workspace <id|name> instead')
    return 1
  }
  const workspaceId = workspace ? await resolveWorkspaceRef(conn, workspace) : home
  const panes = filterPanes(
    await conn.sendRequest<ListedPane[]>('pane.list', mine ? { mine: true } : undefined),
    {
      workspaceId,
      states,
      kind,
    },
  )
  if (call.json) console.log(JSON.stringify(panes))
  else if (panes.length === 0) console.error('(no panes match)')
  else console.log(panes.map(paneLine).join('\n'))
  return 0
}
