import type { MessageConnection } from 'vscode-jsonrpc/node'
import { FlagError, parseArgs } from '../common/args'
import { resolveWorkspaceRef } from '../common/crossWorkspace'
import { usageOf } from '../common/usageTable'

interface PaneInputParams {
  pane: string
  text?: string
  keys?: string[]
  paste?: boolean
  force?: boolean
}

export type PaneCall =
  | { method: 'pane.input'; params: PaneInputParams; stdin?: true }
  | { method: 'pane.read'; params: { pane: string; lines?: number }; json: boolean }
  | { method: 'pane.rename'; params: { pane: string; title: string } }
  | { method: 'pane.wait'; params: PaneWaitParams; json: boolean }
  | { method: 'pane.wake'; params: PaneWakeParams; json: boolean }
  | { method: 'pane.hibernate'; params: { panes: string[] }; json: boolean }
  | { method: 'pane.close'; params: { panes?: string[] }; json: boolean }
  | { method: 'pane.list'; params: Record<string, never>; json: true }
  | { method: 'pane.moveTo'; params: PaneMoveParams; json: boolean }

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
  | { reached: true; paneId: string; state: string; message?: string }
  | { timedOut: true }
  | { closed: true; paneId: string }

const PANE_WAIT_EXIT = { reached: 0, timedOut: 3, closed: 4 } as const

const USAGE = usageOf('pane')

function readFlags(argv: string[]) {
  try {
    return parseArgs(argv, { values: { lines: '--lines' }, booleans: { json: '--json' } })
  } catch (err) {
    if (err instanceof FlagError && err.problem === 'unknown') throw new Error(USAGE)
    throw err
  }
}

function timeoutFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--timeout expects seconds, got '${raw}'`)
  }
  return Math.round(seconds * 1000)
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
    const { paneId, state, message } = result
    const line = json
      ? JSON.stringify({ paneId, state, message: message ?? null })
      : [paneId, state, ...(message ? [message] : [])].join('\t')
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

export function parsePaneArgs(argv: string[]): PaneCall {
  const [sub, pane, ...rest] = argv
  if (sub === 'list') {
    if (pane !== undefined) throw new Error(USAGE)
    return { method: 'pane.list', params: {}, json: true }
  }
  if (sub === 'close') return parseClose(argv.slice(1))
  if (!sub || !pane) throw new Error(USAGE)
  if (sub === 'wait') return parseWait([pane, ...rest])
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
      },
    })
    const { enter, paste, raw, force } = booleans
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
    }
  }
  if (sub === 'key') {
    if (rest.length === 0) throw new Error(USAGE)
    return { method: 'pane.input', params: { pane, keys: rest } }
  }
  if (sub === 'read') {
    const { positional, values, booleans } = readFlags(rest)
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
    console.error(
      err instanceof Error && err.message === USAGE
        ? USAGE
        : `ostia pane: ${err instanceof Error ? err.message : String(err)}`,
    )
    return 1
  }
  if (call.method === 'pane.input' && call.stdin) {
    const text = await readStdin()
    if (!text) {
      console.error('ostia pane send: nothing on stdin')
      return 1
    }
    call = { method: 'pane.input', params: { ...call.params, text } }
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
    console.log(JSON.stringify(await conn.sendRequest('pane.list'), null, 2))
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
    console.log(JSON.stringify(result, null, 2))
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
  } else if (
    call.method === 'pane.input' &&
    (result as { responded?: boolean }).responded === false
  ) {
    console.log(`sent; ${call.params.pane} showed nothing yet: read it with ostia pane read`)
  } else {
    console.log('ok')
  }
  return 0
}
