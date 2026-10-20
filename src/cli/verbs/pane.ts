import type { MessageConnection } from 'vscode-jsonrpc/node'
import { type PaneStatus, statusLine } from '../../shared/panes/paneStatus'
import { parseArgs, parseTimeoutSeconds } from '../common/args'
import { resolveWorkspaceRef } from '../common/crossWorkspace'
import { commandLabel } from '../common/failure'
import { tsvLine } from '../common/lineField'
import { usageOf, verbUsageOf } from '../common/usageTable'

interface PaneInputParams {
  pane: string
  text?: string
  keys?: string[]
  paste?: boolean
  force?: boolean
}

export type PaneCall =
  | { method: 'pane.input'; params: PaneInputParams; stdin?: true; json: boolean }
  | { method: 'pane.read'; params: { pane: string; lines?: number }; json: boolean }
  | { method: 'pane.rename'; params: { pane: string; title: string } }
  | { method: 'pane.wait'; params: PaneWaitParams; json: boolean }
  | { method: 'pane.status'; params: { panes: string[] }; json: boolean }
  | {
      method: 'pane.watch'
      params: { panes?: string[]; until?: string[]; off?: true }
      json: boolean
    }
  | {
      method: 'pane.transcript'
      params: { pane: string; turns?: number; full?: true }
      json: boolean
    }
  | { method: 'pane.wake'; params: PaneWakeParams; json: boolean }
  | { method: 'pane.hibernate'; params: { panes: string[] }; json: boolean }
  | { method: 'pane.close'; params: { panes?: string[] }; json: boolean }
  | { method: 'pane.list'; params: Record<string, never>; json: boolean }
  | { method: 'pane.moveTo'; params: PaneMoveParams; json: boolean }

interface PaneInputResult {
  paneId: string
  responded: boolean
  turnStarted: boolean
  running: boolean
}

export function inputLine(result: PaneInputResult): string {
  if (result.turnStarted) return `ok: ${result.paneId} started a turn`
  const state = result.running ? 'a command is running' : 'no command is running'
  return result.responded
    ? `ok: ${result.paneId} showed new output; ${state}`
    : `sent; ${result.paneId} showed nothing yet (${state}): read it with ostia pane read`
}

interface PaneMoveParams {
  panes: string[]
  workspace?: string
  tab?: string
}

interface PaneWakeParams {
  panes: string[]
  timeoutMs?: number
}

interface PaneWakeResult {
  woke: string[]
  started?: true
  timedOut?: true
  closed?: string
}

interface PaneHibernateResult {
  hibernated: string[]
  skipped: Record<string, string>
}

interface PaneWaitParams {
  panes: string[]
  until?: string[]
  timeoutMs?: number
}

export type PaneWaitResult =
  | {
      reached: true
      paneId: string
      state: string
      message?: string
      exitCode?: number
      status?: PaneStatus
    }
  | { timedOut: true }
  | { closed: true; paneId: string }

const PANE_WAIT_EXIT = { reached: 0, timedOut: 3, closed: 4 } as const

const USAGE = usageOf('pane')

function timeoutFlag(raw: string | undefined): number | undefined {
  const seconds = parseTimeoutSeconds(raw)
  return seconds === undefined ? undefined : Math.round(seconds * 1000)
}

function parseWait(argv: string[]): PaneCall {
  const { positional, values, lists, booleans } = parseArgs(argv, {
    values: { timeout: '--timeout' },
    lists: { until: '--until' },
    booleans: { json: '--json' },
  })
  if (positional.length === 0) throw new Error(USAGE)
  const timeoutMs = timeoutFlag(values.timeout)
  return {
    method: 'pane.wait',
    params: {
      panes: positional,
      ...(lists.until.length > 0 ? { until: lists.until } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    json: booleans.json,
  }
}

function parseStatus(argv: string[]): PaneCall {
  const { positional, booleans } = parseArgs(argv, { booleans: { json: '--json' } })
  if (positional.length === 0) throw new Error(USAGE)
  return { method: 'pane.status', params: { panes: positional }, json: booleans.json }
}

function parseTranscript(argv: string[]): PaneCall {
  const { positional, values, booleans } = parseArgs(argv, {
    values: { turns: '--turns' },
    booleans: { full: '--full', json: '--json' },
  })
  const [pane, ...extra] = positional
  if (!pane || extra.length > 0 || (booleans.full && values.turns !== undefined)) {
    throw new Error(USAGE)
  }
  const turns = values.turns === undefined ? undefined : Number(values.turns)
  if (turns !== undefined && (!Number.isInteger(turns) || turns < 1)) {
    throw new Error('--turns must be a positive integer')
  }
  return {
    method: 'pane.transcript',
    params: {
      pane,
      ...(turns === undefined ? {} : { turns }),
      ...(booleans.full ? { full: true as const } : {}),
    },
    json: booleans.json,
  }
}

function parseWatch(argv: string[]): PaneCall {
  const { positional, lists, booleans } = parseArgs(argv, {
    lists: { until: '--until' },
    booleans: { off: '--off', json: '--json' },
  })
  if (booleans.off && lists.until.length > 0) throw new Error(USAGE)
  if (!booleans.off && positional.length === 0) throw new Error(USAGE)
  return {
    method: 'pane.watch',
    params: {
      ...(positional.length > 0 ? { panes: positional } : {}),
      ...(lists.until.length > 0 ? { until: lists.until } : {}),
      ...(booleans.off ? { off: true as const } : {}),
    },
    json: booleans.json,
  }
}

function parseClose(argv: string[]): PaneCall {
  const { positional, booleans } = parseArgs(argv, { booleans: { json: '--json' } })
  return {
    method: 'pane.close',
    params: positional.length > 0 ? { panes: positional } : {},
    json: booleans.json,
  }
}

function parseHibernate(argv: string[]): PaneCall {
  const { positional, booleans } = parseArgs(argv, { booleans: { json: '--json' } })
  if (positional.length === 0) throw new Error(USAGE)
  return { method: 'pane.hibernate', params: { panes: positional }, json: booleans.json }
}

export function hibernateOutcome(
  result: PaneHibernateResult,
  json: boolean,
): { line: string; code: number } {
  const skipped = Object.entries(result.skipped)
  if (json) return { line: JSON.stringify(result), code: skipped.length > 0 ? 2 : 0 }
  const lines = [
    ...result.hibernated,
    ...skipped.map(([paneId, reason]) => `ostia pane hibernate: ${paneId} skipped (${reason})`),
  ]
  return { line: lines.join('\n'), code: skipped.length > 0 ? 2 : 0 }
}

function parseMove(argv: string[]): PaneCall {
  const { positional, values, booleans } = parseArgs(argv, {
    values: { workspace: '--workspace', tab: '--tab' },
    booleans: { json: '--json' },
  })
  if (positional.length === 0 || (!values.workspace && !values.tab)) throw new Error(USAGE)
  return {
    method: 'pane.moveTo',
    params: {
      panes: positional,
      ...(values.workspace ? { workspace: values.workspace } : {}),
      ...(values.tab ? { tab: values.tab } : {}),
    },
    json: booleans.json,
  }
}

function parseWake(argv: string[]): PaneCall {
  const { positional, values, booleans } = parseArgs(argv, {
    values: { timeout: '--timeout' },
    booleans: { json: '--json' },
  })
  if (positional.length === 0) throw new Error(USAGE)
  const timeoutMs = timeoutFlag(values.timeout)
  return {
    method: 'pane.wake',
    params: { panes: positional, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    json: booleans.json,
  }
}

export function wakeOutcome(result: PaneWakeResult, json: boolean): { line: string; code: number } {
  if (result.timedOut) {
    return {
      line: json ? JSON.stringify(result) : 'ostia pane wake: timed out',
      code: PANE_WAIT_EXIT.timedOut,
    }
  }
  if (result.closed) {
    return {
      line: json ? JSON.stringify(result) : `ostia pane wake: ${result.closed} closed`,
      code: PANE_WAIT_EXIT.closed,
    }
  }
  return {
    line: json ? JSON.stringify(result) : result.woke.join('\n'),
    code: PANE_WAIT_EXIT.reached,
  }
}

export function waitOutcome(result: PaneWaitResult, json: boolean): { line: string; code: number } {
  if ('reached' in result) {
    const { paneId, state, message, exitCode, status } = result
    const line = json
      ? JSON.stringify({
          paneId,
          state,
          message: message ?? null,
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(status ? { status } : {}),
        })
      : status
        ? statusLine(status)
        : tsvLine([paneId, state, ...(message ? [message] : [])])
    return { line, code: PANE_WAIT_EXIT.reached }
  }
  if ('closed' in result) {
    const line = json
      ? JSON.stringify({ paneId: result.paneId, state: 'closed', message: null })
      : `ostia pane wait: ${result.paneId} closed`
    return { line, code: PANE_WAIT_EXIT.closed }
  }
  return {
    line: json ? JSON.stringify({ timedOut: true }) : 'ostia pane wait: timed out',
    code: PANE_WAIT_EXIT.timedOut,
  }
}

interface ListedPane {
  paneId: string
  workspaceId: string
  kind: string
  title: string
  running: boolean
  agentState?: string
  hibernated?: true
  waking?: true
}

export function paneLine(pane: ListedPane): string {
  const state = pane.hibernated
    ? 'hibernated'
    : pane.waking
      ? 'waking'
      : (pane.agentState ?? (pane.running ? 'running' : 'idle'))
  return tsvLine([pane.paneId, pane.workspaceId, pane.kind, state, pane.title])
}

export function parsePaneArgs(argv: string[]): PaneCall {
  const [sub, pane, ...rest] = argv
  if (sub === 'list') {
    const { positional, booleans } = parseArgs(argv.slice(1), { booleans: { json: '--json' } })
    if (positional.length > 0) throw new Error(USAGE)
    return { method: 'pane.list', params: {}, json: booleans.json }
  }
  if (sub === 'close') return parseClose(argv.slice(1))
  if (sub === 'watch' && pane === '--off' && rest.length === 0) return parseWatch(argv.slice(1))
  if (!sub || !pane) throw new Error(USAGE)
  if (sub === 'wait') return parseWait([pane, ...rest])
  if (sub === 'status') return parseStatus([pane, ...rest])
  if (sub === 'watch') return parseWatch([pane, ...rest])
  if (sub === 'transcript') return parseTranscript([pane, ...rest])
  if (sub === 'wake') return parseWake([pane, ...rest])
  if (sub === 'hibernate') return parseHibernate([pane, ...rest])
  if (sub === 'move') return parseMove([pane, ...rest])
  if (sub === 'send') {
    const { positional: words, booleans } = parseArgs(rest, {
      booleans: {
        enter: '--enter',
        paste: '--paste',
        raw: '--raw',
        force: '--force',
        json: '--json',
      },
    })
    const { enter, paste, raw, force, json } = booleans
    if ((words.length === 0 && !enter) || (paste && raw)) throw new Error(USAGE)
    const stdin = words.length === 1 && words[0] === '-'
    return {
      method: 'pane.input',
      params: {
        pane,
        ...(words.length > 0 && !stdin ? { text: words.join(' ') } : {}),
        ...(enter ? { keys: ['enter'] } : {}),
        ...(paste || raw ? { paste } : {}),
        ...(force ? { force: true } : {}),
      },
      ...(stdin ? { stdin: true as const } : {}),
      json,
    }
  }
  if (sub === 'key') {
    const { positional: keys, booleans } = parseArgs(rest, { booleans: { json: '--json' } })
    if (keys.length === 0) throw new Error(USAGE)
    return { method: 'pane.input', params: { pane, keys }, json: booleans.json }
  }
  if (sub === 'read') {
    const { positional, values, booleans } = parseArgs(rest, {
      values: { lines: '--lines' },
      booleans: { json: '--json' },
    })
    if (positional.length > 0) throw new Error(USAGE)
    if (values.lines === undefined) {
      return { method: 'pane.read', params: { pane }, json: booleans.json }
    }
    const lines = Number(values.lines)
    if (!Number.isInteger(lines) || lines < 1) {
      throw new Error('--lines must be a positive integer')
    }
    return { method: 'pane.read', params: { pane, lines }, json: booleans.json }
  }
  if (sub === 'rename') {
    const { positional, booleans } = parseArgs(rest, {
      booleans: { clear: '--clear' },
      unknown: 'keep',
    })
    const title = positional.join(' ').trim()
    if (booleans.clear === Boolean(title)) throw new Error(USAGE)
    return { method: 'pane.rename', params: { pane, title } }
  }
  throw new Error(USAGE)
}

export async function runPaneVerb(
  conn: MessageConnection,
  argv: string[],
  readStdin: () => Promise<string>,
): Promise<number> {
  let call: PaneCall
  try {
    call = parsePaneArgs(argv)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const usage = verbUsageOf('pane', argv[0])
    console.error(message === USAGE ? usage : `${commandLabel()}: ${message}\n${usage}`)
    return 1
  }
  if (call.method === 'pane.input' && call.stdin) {
    const text = await readStdin()
    if (!text) {
      console.error('ostia pane send: nothing on stdin')
      return 1
    }
    call = { method: 'pane.input', params: { ...call.params, text }, json: call.json }
  }
  if (call.method === 'pane.moveTo') {
    const { workspace } = call.params
    const result = await conn.sendRequest<{ moved: string[] }>(call.method, {
      ...call.params,
      ...(workspace ? { workspace: await resolveWorkspaceRef(conn, workspace) } : {}),
    })
    console.log(call.json ? JSON.stringify(result) : result.moved.join('\n'))
    return 0
  }
  if (call.method === 'pane.list') {
    const panes = await conn.sendRequest<ListedPane[]>('pane.list')
    console.log(call.json ? JSON.stringify(panes) : panes.map(paneLine).join('\n'))
    return 0
  }
  if (call.method === 'pane.transcript') {
    const result = await conn.sendRequest<{
      agent: string
      turns: number
      text: string
      truncated?: true
    }>(call.method, call.params)
    console.log(call.json ? JSON.stringify(result) : result.text)
    if (result.truncated && !call.json) {
      console.error('(older turns are not shown: the transcript is larger than the window read)')
    }
    return 0
  }
  if (call.method === 'pane.watch') {
    const result = await conn.sendRequest<{
      watching: { pane: string; until: string[]; open: boolean }[]
    }>(call.method, call.params)
    console.log(
      call.json
        ? JSON.stringify(result)
        : result.watching.length === 0
          ? '(watching nothing)'
          : result.watching.map((w) => tsvLine([w.pane, `until ${w.until.join(', ')}`])).join('\n'),
    )
    return 0
  }
  if (call.method === 'pane.status') {
    const result = await conn.sendRequest<{ panes: PaneStatus[] }>(call.method, call.params)
    console.log(call.json ? JSON.stringify(result) : result.panes.map(statusLine).join('\n'))
    return 0
  }
  if (call.method === 'pane.wait') {
    const result = await conn.sendRequest<PaneWaitResult>(call.method, call.params)
    const { line, code } = waitOutcome(result, call.json)
    if (code === PANE_WAIT_EXIT.reached || call.json) console.log(line)
    else console.error(line)
    return code
  }
  const result = await conn.sendRequest<unknown>(call.method, call.params)
  if (call.method === 'pane.read' && !call.json) {
    console.log((result as { text: string }).text)
  } else if (call.method === 'pane.read') {
    console.log(JSON.stringify(result))
  } else if (call.method === 'pane.wake') {
    const { line, code } = wakeOutcome(result as PaneWakeResult, call.json)
    if (code === PANE_WAIT_EXIT.reached || call.json) console.log(line)
    else console.error(line)
    return code
  } else if (call.method === 'pane.hibernate') {
    const { line, code } = hibernateOutcome(result as PaneHibernateResult, call.json)
    if (code === 0 || call.json) console.log(line)
    else console.error(line)
    return code
  } else if (call.method === 'pane.close') {
    const { closed } = result as { closed: string[] }
    console.log(call.json ? JSON.stringify(result) : closed.join('\n'))
  } else if (call.method === 'pane.input') {
    console.log(call.json ? JSON.stringify(result) : inputLine(result as PaneInputResult))
  } else {
    console.log('ok')
  }
  return 0
}
