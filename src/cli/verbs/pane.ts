import type { MessageConnection } from 'vscode-jsonrpc/node'
import { FlagError, parseArgs } from '../common/args'
import { resolveWorkspaceRef } from '../common/crossWorkspace'

export interface PaneInputParams {
  pane: string
  text?: string
  keys?: string[]
  paste?: boolean
  force?: boolean
  confirm?: boolean
}

export type PaneCall =
  | { method: 'pane.input'; params: PaneInputParams; stdin?: true }
  | { method: 'pane.read'; params: { pane: string; lines?: number }; json: boolean }
  | { method: 'pane.rename'; params: { pane: string; title: string } }
  | { method: 'pane.wait'; params: PaneWaitParams; json: boolean }
  | { method: 'pane.wake'; params: PaneWakeParams; json: boolean }
  | { method: 'pane.close'; params: { panes: string[] }; json: boolean }
  | { method: 'pane.moveTo'; params: { panes: string[]; workspace: string }; json: boolean }

interface PaneWakeParams {
  panes: string[]
  wait?: true
  timeoutMs?: number
}

interface PaneWakeResult {
  woke: string[]
  started?: true
  timedOut?: true
  closed?: string
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

const USAGE = [
  'usage: ostia pane send <pane> [--enter] [--paste|--raw] [--force] [--confirm]',
  '                        [--] <text…|->',
  '       ostia pane key <pane> <key>…',
  '       ostia pane read <pane> [--lines N] [--json]',
  '       ostia pane rename <pane> <title…> | --clear',
  '       ostia pane wait <pane>… [--until done|waiting|idle|exited]… [--timeout <s>] [--json]',
  '       ostia pane wake <pane>… [--wait [--timeout <s>]] [--json]',
  '       ostia pane close <pane>… [--json]',
  '       ostia pane move <pane>… --workspace <id|name> [--json]',
  '<pane> is a paneId or a process id or name (ostia process ls); list panes with',
  'ostia pane.list (JSON: paneId, kind, title, cwd, running, agent, agentState, hibernated, …)',
].join('\n')

const PANE_LIST_HINT = 'list panes with ostia pane.list (JSON), not ostia pane list'

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
  if (positional.length === 0) throw new Error(USAGE)
  return { method: 'pane.close', params: { panes: positional }, json: booleans.json }
}

function parseMove(argv: string[]): PaneCall {
  const { positional, values, booleans } = parseArgs(argv, {
    values: { workspace: '--workspace' },
    booleans: { json: '--json' },
  })
  if (positional.length === 0 || !values.workspace) throw new Error(USAGE)
  return {
    method: 'pane.moveTo',
    params: { panes: positional, workspace: values.workspace },
    json: booleans.json,
  }
}

function parseWake(argv: string[]): PaneCall {
  const { positional, values, booleans } = parseArgs(argv, {
    values: { timeout: '--timeout' },
    booleans: { wait: '--wait', json: '--json' },
  })
  if (positional.length === 0) throw new Error(USAGE)
  if (values.timeout !== undefined && !booleans.wait) throw new Error('--timeout needs --wait')
  const timeoutMs = timeoutFlag(values.timeout)
  return {
    method: 'pane.wake',
    params: {
      panes: positional,
      ...(booleans.wait ? { wait: true as const } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
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
  if (sub === 'list') throw new Error(PANE_LIST_HINT)
  if (!sub || !pane) throw new Error(USAGE)
  if (sub === 'wait') return parseWait([pane, ...rest])
  if (sub === 'wake') return parseWake([pane, ...rest])
  if (sub === 'close') return parseClose([pane, ...rest])
  if (sub === 'move') return parseMove([pane, ...rest])
  if (sub === 'send') {
    const { positional: words, booleans } = parseArgs(rest, {
      booleans: {
        enter: '--enter',
        paste: '--paste',
        raw: '--raw',
        force: '--force',
        confirm: '--confirm',
      },
      unknown: 'keep',
    })
    const { enter, paste, raw, force, confirm } = booleans
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
        ...(confirm ? { confirm: true } : {}),
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

export function parseWorkspaceRenameArgs(argv: string[]): { workspace?: string; name: string } {
  const { positional, values, booleans } = parseArgs(argv, {
    values: { workspace: '--workspace' },
    booleans: { clear: '--clear' },
    unknown: 'keep',
  })
  const name = positional.join(' ').trim()
  if (booleans.clear === Boolean(name)) {
    throw new Error('usage: ostia workspace rename [--workspace <id>] <name…> | --clear')
  }
  return { ...(values.workspace ? { workspace: values.workspace } : {}), name }
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
    console.error(`ostia pane: ${err instanceof Error ? err.message : String(err)}`)
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
    const workspace = await resolveWorkspaceRef(conn, call.params.workspace)
    const result = await conn.sendRequest<{ moved: string[] }>(call.method, {
      ...call.params,
      workspace,
    })
    console.log(call.json ? JSON.stringify(result) : result.moved.join('\n'))
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
  } else if (call.method === 'pane.close') {
    const { closed } = result as { closed: string[] }
    console.log(call.json ? JSON.stringify(result) : closed.join('\n'))
  } else if (call.method === 'pane.input' && call.params.confirm) {
    const responded = (result as { responded?: boolean }).responded === true
    console.log(responded ? 'ok' : 'sent, but the pane printed nothing back')
    return responded ? 0 : 2
  } else {
    console.log('ok')
  }
  return 0
}
