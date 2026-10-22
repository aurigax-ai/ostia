import { resolve as resolvePath } from 'node:path'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { shortId } from '../../shared/panes/paneStatus'
import { parseArgs } from '../common/args'
import { resolveWorkspaceRef } from '../common/crossWorkspace'
import {
  describeErrResult,
  type ErrResult,
  fail,
  failUsage,
  failVerb,
  failWith,
  isErrResult,
} from '../common/failure'
import { tsvLine } from '../common/lineField'
import { readAllStdin } from '../common/stdinText'

interface ProcInfo {
  id: string
  name: string
  cmd: string
  cwd?: string
  status: 'starting' | 'running' | 'exited' | 'closed'
  exitCode?: number
  hint?: string
  paneId: string
  startedAt: string
}

function processStatus(p: ProcInfo): string {
  return p.status === 'exited' && p.exitCode !== undefined ? `exited(${p.exitCode})` : p.status
}

export function processHintLine(p: Pick<ProcInfo, 'name' | 'hint'>): string | null {
  return p.hint ? `${p.name}: ${p.hint}` : null
}

function numberFlag(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(n)) {
    throw new Error(`--${name} expects a number, got '${raw}'`)
  }
  return n
}

interface StartAnswer {
  name: string
  paneId: string
  status?: string
  reason?: string
  turnStarted?: boolean
  session?: string
}

function agentStartLine(res: StartAnswer): string {
  if (res.status !== 'started') return `${res.name} ${shortId(res.paneId)} ${res.status}`
  const turn =
    res.turnStarted === undefined
      ? 'started; turn unknown (hooks off)'
      : res.turnStarted
        ? 'started a turn'
        : 'started; no turn yet'
  const session = res.session ? `; session ${res.session}` : ''
  return `${res.name} ${shortId(res.paneId)} ${turn}${session}`
}

function printStart(verb: string, res: StartAnswer, json = true): void {
  const failed = res.status === 'failed' || res.status === 'timed-out'
  console.log(json || failed ? JSON.stringify(res) : agentStartLine(res))
  if (!failed) return
  fail(
    `ostia ${verb}: ${res.name} (${shortId(res.paneId)}) ${res.status}: ${res.reason ?? ''}. See what it printed: ostia pane read ${shortId(res.paneId)}`,
  )
}

function parseAgentArgs(argv: readonly string[]) {
  return parseArgs(argv, {
    values: {
      name: '--name',
      cwd: '--cwd',
      workspace: '--workspace',
      tab: '--tab',
      model: '--model',
    },
    booleans: { json: '--json' },
  })
}

export async function runAgentVerb(conn: MessageConnection): Promise<void> {
  const { values: flags, positional, booleans } = parseAgentArgs(process.argv.slice(4))
  const [agent, given] = positional
  if (process.argv[3] !== 'run' || !agent || given === undefined) return failUsage('agent')
  const prompt = given === '-' ? await readAllStdin() : given
  const res = await conn.sendRequest<StartAnswer | ErrResult>('agent.run', {
    agent,
    prompt,
    name: flags.name,
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.cwd ? { cwd: resolvePath(flags.cwd) } : {}),
    ...(flags.workspace ? { workspace: await resolveWorkspaceRef(conn, flags.workspace) } : {}),
    ...(flags.tab !== undefined ? { tab: flags.tab } : {}),
  })
  if (isErrResult(res)) {
    failWith(describeErrResult(res))
    return
  }
  printStart('agent run', res, booleans.json)
}

export async function runProcessVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const rawArgs = process.argv.slice(4)

  if (sub === 'run') {
    const { values: flags, positional } = parseArgs(rawArgs, {
      values: { name: '--name', cwd: '--cwd', workspace: '--workspace', tab: '--tab' },
    })
    const cmd = positional[0]
    if (!cmd) return failUsage('process')
    const res = await conn.sendRequest<StartAnswer | ErrResult>('process.run', {
      cmd,
      name: flags.name,
      ...(flags.workspace
        ? {
            workspace: await resolveWorkspaceRef(conn, flags.workspace),
            ...(flags.cwd ? { cwd: resolvePath(flags.cwd) } : {}),
          }
        : { cwd: resolvePath(flags.cwd ?? '.') }),
      ...(flags.tab !== undefined ? { tab: flags.tab } : {}),
    })
    if (isErrResult(res)) {
      failWith(describeErrResult(res))
      return
    }
    printStart('process run', res)
  } else if (sub === 'list') {
    const { positional, booleans } = parseArgs(rawArgs, { booleans: { json: '--json' } })
    if (positional.length > 0) return failVerb('unexpected arguments')
    const list = await conn.sendRequest<ProcInfo[] | ErrResult>('process.list')
    if (!Array.isArray(list)) {
      const reason = isErrResult(list) ? describeErrResult(list) : 'unexpected response'
      failWith(reason)
      return
    }
    if (booleans.json) {
      console.log(JSON.stringify(list))
      return
    }
    if (list.length === 0) {
      console.error('(no tracked processes)')
      return
    }
    for (const p of list) {
      console.log(tsvLine([p.id, p.name, processStatus(p), p.paneId, p.cmd]))
      const hint = processHintLine(p)
      if (hint) console.error(hint)
    }
  } else if (sub === 'logs') {
    const { values, positional } = parseArgs(rawArgs, { values: { since: '--since' } })
    const id = positional[0]
    if (!id) return failUsage('process')
    const sinceCursor = numberFlag(values.since, 'since')
    const res = await conn.sendRequest<
      { data: string; cursor: number; dropped: boolean } | ErrResult
    >('process.output', { id, sinceCursor })
    if (isErrResult(res)) {
      failWith(describeErrResult(res))
      return
    }
    if (res.data) process.stdout.write(res.data)
    console.error(`(cursor=${res.cursor}${res.dropped ? ', dropped' : ''})`)
  } else if (sub === 'kill') {
    const id = rawArgs[0]
    if (!id) return failUsage('process')
    const res = await conn.sendRequest<{ ok: true } | ErrResult>('process.kill', { id })
    if (isErrResult(res)) {
      failWith(describeErrResult(res))
      return
    }
    console.log('ok')
  } else if (sub === 'restart') {
    const id = rawArgs[0]
    if (!id) return failUsage('process')
    const res = await conn.sendRequest<{ id: string } | ErrResult>('process.restart', { id })
    if (isErrResult(res)) {
      failWith(describeErrResult(res))
      return
    }
    console.log(JSON.stringify(res))
  } else {
    failUsage('process')
  }
}
