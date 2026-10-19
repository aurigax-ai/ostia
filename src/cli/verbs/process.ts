import { resolve as resolvePath } from 'node:path'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { FlagError, parseArgs } from '../common/args'
import { resolveWorkspaceRef } from '../common/crossWorkspace'
import {
  type ErrResult,
  describeErrResult,
  fail,
  failUsage,
  failVerb,
  failWith,
  isErrResult,
} from '../common/failure'
import { readAllStdin } from '../common/stdinText'
import { usageOf } from '../common/usageTable'

interface ProcInfo {
  id: string
  name: string
  cmd: string
  cwd?: string
  status: 'starting' | 'running' | 'exited' | 'closed'
  exitCode?: number
  paneId: string
  startedAt: string
}

function processStatus(p: ProcInfo): string {
  return p.status === 'exited' && p.exitCode !== undefined ? `exited(${p.exitCode})` : p.status
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
}

function printStart(verb: string, res: StartAnswer): void {
  console.log(JSON.stringify(res))
  if (res.status !== 'failed' && res.status !== 'timed-out') return
  fail(`ostia ${verb}: ${res.name} (${res.paneId}) ${res.status}: ${res.reason ?? ''}`)
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
  })
}

export async function runAgentVerb(conn: MessageConnection): Promise<void> {
  let parsed: ReturnType<typeof parseAgentArgs>
  try {
    parsed = parseAgentArgs(process.argv.slice(4))
  } catch (err) {
    if (err instanceof FlagError) throw new Error(`${err.message}\n${usageOf('agent')}`)
    throw err
  }
  const { values: flags, positional } = parsed
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
  printStart('agent run', res)
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
      console.log('(no tracked processes)')
      return
    }
    for (const p of list) {
      console.log(`${p.id}\t${p.name}\t${processStatus(p)}\t${p.paneId}\t${p.cmd}`)
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
