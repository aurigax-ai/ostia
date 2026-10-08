#!/usr/bin/env node
import { statSync } from 'node:fs'
import { type Socket, createConnection } from 'node:net'
import { resolve as resolvePath } from 'node:path'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import { controlInfoPath, readControlSocket } from '../main/controlDiscovery'
import { RESUMABLE_AGENTS, isResumableAgent, resumeFromHookPayload } from '../shared/agentResume'
import { CLAUDE_WORK_EVENTS, claudeWorkReport, isClaudeWorkEvent } from '../shared/agentWork'
import { readEnv } from '../shared/appEnv'
import { ARTIFACTS_ENV } from '../shared/artifacts'
import {
  CLAUDE_ATTENTION_EVENTS,
  claudeAttention,
  isClaudeAttentionEvent,
} from '../shared/claudeAttention'
import type {
  DiffFilesResult,
  FileTarget,
  OpenFilesResult,
  OpenPlacement,
  RevealFolderResult,
} from '../shared/openFiles'
import { SCRIPT_TOKEN_PREFIX } from '../shared/scriptTokens'
import type { CommandDescriptor, CommandResult } from '../shared/types'
import type { WorkflowEntry, WorkflowListing } from '../shared/workflows'
import { runAgentHook } from './agentHook'
import { FlagError, type ParsedArgs, parseArgs } from './args'
import { runAskVerb } from './ask'
import { runBrowse } from './browse'
import {
  BUS_ASLEEP_HINT,
  BUS_QUEUED_HINT,
  type BusSendOk,
  type SentMessage,
  busWaitTimeoutMs,
  runBusHook,
  sentLines,
} from './bus'
import { runCmuxImportVerb } from './cmuxImport'
import { commandHelp, wantsHelp } from './commandHelp'
import { runGitVerb, runPortsVerb } from './coreBoards'
import { buildCommandCall, parseCommandFlags, resolveWorkspaceRef } from './crossWorkspace'
import { describeFailure } from './failure'
import {
  type FileProbe,
  type OpenTarget,
  diffRefusalLine,
  fileWord,
  isClaimedWord,
  openTarget,
  parseFileArg,
  placementOf,
  refusalLine,
  revealRefusalLine,
} from './fileArgs'
import { runManagerVerb } from './manager'
import { STATE_VERBS, messageFromStdin, saveAttentionOffline } from './offlineAttention'
import { parseWorkspaceRenameArgs, runPaneVerb } from './pane'
import { paneToken } from './paneToken'
import { runPermissionHook } from './permissionHook'
import { runPortalCommand } from './portal'
import { TTY_NOTICE, captureStdin } from './stdinCapture'
import { runTokenVerb } from './token'
import { buildVersionAt } from './version'
import { isOfflineViewVerb, runOfflineViewVerb, runViewVerb } from './view'

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

async function readSecretFromStdin(promptLabel: string): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write(`${promptLabel} (input hidden): `)
    return await readLineNoEcho()
  }
  return await readAllStdin()
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')))
    process.stdin.on('error', reject)
  })
}

function readLineNoEcho(): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let input = ''
    let settled = false
    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      stdin.removeListener('data', onData)
      stdin.removeListener('error', onError)
      stdin.removeListener('close', onClose)
      stdin.removeListener('end', onClose)
      process.removeListener('SIGINT', onSigint)
      stdin.setRawMode?.(false)
      stdin.pause()
      run()
    }
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish(() => {
            process.stderr.write('\n')
            resolve(input)
          })
          return
        }
        if (ch === '\u0004') {
          finish(() => {
            process.stderr.write('\n')
            resolve(input)
          })
          return
        }
        if (ch === '\u0003') {
          finish(() => {
            process.stderr.write('\n')
            reject(new Error('aborted'))
          })
          return
        }
        if (ch === '\u007f' || ch === '\b') {
          input = input.slice(0, -1)
        } else {
          input += ch
        }
      }
    }
    const onError = (err: Error): void => finish(() => reject(err))
    const onClose = (): void =>
      finish(() => reject(new Error('stdin closed before a value was entered')))
    const onSigint = (): void =>
      finish(() => {
        process.stderr.write('\n')
        reject(new Error('aborted'))
      })
    stdin.on('data', onData)
    stdin.on('error', onError)
    stdin.on('close', onClose)
    stdin.on('end', onClose)
    process.on('SIGINT', onSigint)
  })
}

interface VaultOk {
  ok: true
}
interface VaultErr {
  ok: false
  error: string
  message?: string
}
interface VaultGetResult {
  value: string
}
interface VaultListResult {
  keys: string[]
}

function describeVaultError(res: VaultErr): string {
  return res.message ? `${res.error}: ${res.message}` : res.error
}

async function runSecretVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  if (sub === 'ls') {
    const list =
      await conn.sendRequest<{ name: string; source: string; kind: string }[]>('secret.list')
    for (const s of list) console.log(`${s.source}\t${s.kind}\t${s.name}`)
  } else if (sub === 'get') {
    const { positional, values } = parseArgs(process.argv.slice(4), {
      values: { reason: '--reason' },
    })
    const target = positional[0]
    const reason = values.reason ?? ''
    if (!target) {
      console.error('ostia secret get: missing <name>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: boolean; value?: string; error?: string }>(
      'secret.get',
      { name: target, reason },
    )
    if (res.ok && res.value !== undefined) {
      process.stdout.write(res.value)
    } else {
      console.error(`ostia: ${res.error ?? 'failed'}`)
      process.exitCode = 1
    }
  } else {
    console.error(`ostia secret: unknown subcommand '${sub ?? ''}' (try: ls, get)`)
    process.exitCode = 1
  }
}

async function runSandboxVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const value = process.argv[4]
  if (sub === 'request-domain') {
    if (!value) {
      console.error('ostia sandbox request-domain: missing <host>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{
      ok: boolean
      domain?: string
      error?: string
      reason?: string
    }>('sandbox.request-domain', { host: value })
    if (res.ok) {
      console.log(`allowed: ${res.domain}`)
    } else {
      console.error(`ostia: ${res.error}${res.reason ? ` (${res.reason})` : ''}`)
      process.exitCode = 1
    }
  } else if (sub === 'expose') {
    if (!value) {
      console.error('ostia sandbox expose: missing <port>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{
      ok: boolean
      port?: number
      notice?: string
      error?: string
    }>('sandbox.expose', { port: value })
    if (res.ok && res.notice) {
      console.log(
        `port ${res.port} is reachable on this computer already; forwarding is not needed on macOS`,
      )
    } else if (res.ok) {
      console.log(`exposed: 127.0.0.1:${res.port}`)
    } else {
      console.error(`ostia: ${res.error}`)
      process.exitCode = 1
    }
  } else {
    console.error(`ostia sandbox: unknown subcommand '${sub ?? ''}' (try: request-domain, expose)`)
    process.exitCode = 1
  }
}

async function runVaultVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const { positional: rest, booleans } = parseArgs(process.argv.slice(4), {
    booleans: { global: '--global' },
  })
  const scope: 'project' | 'global' = booleans.global ? 'global' : 'project'

  if (sub === 'set') {
    const key = rest[0]
    if (!key) {
      console.error('ostia vault set: missing <KEY>')
      process.exitCode = 1
      return
    }
    const value = await readSecretFromStdin(`Enter value for ${key}`)
    const res = await conn.sendRequest<VaultOk | VaultErr>('vault.set', { key, value, scope })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`ostia: vault set failed (${describeVaultError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'get') {
    const key = rest[0]
    if (!key) {
      console.error('ostia vault get: missing <KEY>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<VaultGetResult | VaultErr>('vault.get', { key, scope })
    if ('value' in res) {
      console.log(res.value)
    } else {
      console.error(`ostia: vault get failed (${describeVaultError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'ls') {
    const res = await conn.sendRequest<VaultListResult | VaultErr>('vault.list', { scope })
    if ('keys' in res) {
      for (const k of res.keys) console.log(k)
    } else {
      console.error(`ostia: vault ls failed (${describeVaultError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'rm') {
    const key = rest[0]
    if (!key) {
      console.error('ostia vault rm: missing <KEY>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<VaultOk | VaultErr>('vault.delete', { key, scope })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`ostia: vault rm failed (${describeVaultError(res)})`)
      process.exitCode = 1
    }
  } else {
    console.error(`ostia vault: unknown subcommand '${sub ?? ''}' (try: set, get, ls, rm)`)
    process.exitCode = 1
  }
}

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
  commands: ExtCommandInfo[]
}

type ExtResult =
  | { ok: true; text?: string; data?: unknown }
  | { ok: false; error: string; message?: string; data?: unknown }

async function runExtList(conn: MessageConnection): Promise<void> {
  const list = await conn.sendRequest<ExtInfo[]>('ext.list')
  for (const ext of list) {
    console.log(`${ext.id}\t${ext.status}\t${ext.name}`)
    for (const cmd of ext.commands)
      console.log(`  ostia ${ext.id} ${cmd.usage ?? cmd.id}\t${cmd.title}`)
  }
}

async function runExtCommand(
  conn: MessageConnection,
  extId: string | undefined,
  command: string | undefined,
  argv: string[],
): Promise<void> {
  if (!extId || !command) {
    console.error('usage: ostia ext <extId> <command> [args...]   (see: ostia ext ls)')
    process.exitCode = 1
    return
  }
  const list = await conn.sendRequest<ExtInfo[]>('ext.list')
  const ext = list.find((e) => e.id === extId)
  if (!ext) {
    console.error(`ostia: unknown command or extension '${extId}' (see: ostia ext ls)`)
    process.exitCode = 1
    return
  }
  const cmd = ext.commands.find((c) => c.id === command)
  if (!cmd) {
    const known = ext.commands.map((c) => c.id).join(', ')
    console.error(`ostia ${extId}: unknown subcommand '${command}' (try: ${known})`)
    process.exitCode = 1
    return
  }
  const args: { argv: string[]; stdin?: string } = { argv }
  if (cmd.stdin) args.stdin = await readAllStdin()
  const res = await conn.sendRequest<ExtResult>('ext.invoke', { extId, command, args })
  if (!res.ok) {
    const detail = res.message ? `${res.error}: ${res.message}` : res.error
    if (res.data !== undefined) console.log(JSON.stringify(res.data, null, 2))
    console.error(`ostia: ${extId} ${command} failed (${detail})`)
    process.exitCode = 1
  } else if (res.text !== undefined) {
    if (res.text) console.log(res.text)
  } else if (res.data !== undefined) {
    console.log(JSON.stringify(res.data, null, 2))
  } else {
    console.log('ok')
  }
}

const CORE_VERBS = new Set([
  'whoami',
  'manager',
  'commands',
  'info',
  'cwd',
  'pane.list',
  'workspace.list',
  'workspace',
  'notify',
  'ask',
  'state',
  'resume-token',
  'claude-hook',
  'permission-hook',
  'agent-hook',
  'open',
  'diff',
  'docs',
  'process',
  'pane',
  'token',
  'vault',
  'sandbox',
  'secret',
  'bus',
  'settings',
  'browse',
  'gateway',
  'ext',
  'workflow',
  'view',
  'git',
  'ports',
])

const FILE_PROBE: FileProbe = {
  cwd: process.cwd(),
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  isDir: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
}

async function opensAsFile(conn: MessageConnection, word: string): Promise<boolean> {
  const kind = fileWord(word, FILE_PROBE)
  if (kind !== 'name') return kind === 'path'
  const [extensions, commands] = await Promise.all([
    conn.sendRequest<{ id: string }[]>('ext.list').catch(() => []),
    conn.sendRequest<{ id: string }[]>('command.list').catch(() => []),
  ])
  return !isClaimedWord(word, {
    extensionIds: extensions.map((e) => e.id),
    commandIds: commands.map((c) => c.id),
  })
}

interface OpenHow {
  background: boolean
  placement: OpenPlacement | undefined
  wait: boolean
}

async function openFilesIn(
  conn: MessageConnection,
  files: FileTarget[],
  how: OpenHow,
): Promise<string[]> {
  if (files.length === 0) return []
  const res = await conn.sendRequest<OpenFilesResult>('file.open', {
    files,
    ...(how.background ? { background: true } : {}),
    ...(how.placement ? { placement: how.placement } : {}),
    ...(how.wait ? { wait: true } : {}),
  })
  if (!res.ok) return [`ostia open: ${res.message}`]
  const refused = res.results.flatMap((r) => (r.ok ? [] : [refusalLine(r.path, r.error)]))
  if (how.wait && res.waited !== 'closed' && refused.length < res.results.length) {
    return [...refused, WAIT_ENDED]
  }
  return refused
}

async function revealFolderIn(conn: MessageConnection, path: string): Promise<string[]> {
  const res = await conn.sendRequest<RevealFolderResult>('file.reveal', { path })
  return res.ok ? [] : [revealRefusalLine(path, res.error, res.message)]
}

async function openUrlIn(
  conn: MessageConnection,
  url: string,
  background: boolean,
): Promise<string[]> {
  const res = await conn.sendRequest<{ ok: boolean; error?: string; message?: string }>(
    'browse.open',
    { url, ...(background ? { background: true } : {}) },
  )
  return res.ok ? [] : [`ostia: ${url}: ${res.message ?? res.error ?? 'failed'}`]
}

async function newWorkspaceIn(conn: MessageConnection, targets: OpenTarget[]): Promise<string[]> {
  if (targets.length !== 1 || targets[0].kind !== 'folder') return ['ostia -n: takes one folder']
  const res = await conn.sendRequest<CommandResult>('command.exec', {
    id: 'workspace.new',
    args: { dir: targets[0].path },
  })
  return res.ok ? [] : [`ostia -n: ${res.error.message}`]
}

const WAIT_ENDED = 'ostia: the wait ended before the tab was closed'

function fail(message: string): void {
  console.error(message)
  process.exitCode = 1
}

async function runOpenFiles(conn: MessageConnection, args: string[]): Promise<void> {
  let parsed: ParsedArgs<'name' | 'split', never, 'background' | 'wait' | 'tab' | 'fresh'>
  try {
    parsed = parseArgs(args, {
      values: { name: '--name', split: '--split' },
      booleans: {
        background: '-b, --background',
        wait: '-w, --wait',
        tab: '--tab',
        fresh: '-n, --new',
      },
    })
  } catch (err) {
    if (!(err instanceof FlagError)) throw err
    return fail(`ostia open: ${err.message}`)
  }
  const targets = parsed.positional.map((word) => openTarget(word, FILE_PROBE))
  if (targets.length === 0) return fail('ostia open: missing <path>')
  const { background, wait, tab, fresh } = parsed.booleans
  if (fresh) {
    const problems = await newWorkspaceIn(conn, targets)
    for (const line of problems) console.error(line)
    if (problems.length > 0) process.exitCode = 1
    else console.log('ok')
    return
  }
  const placed = placementOf({ tab, split: parsed.values.split, wait })
  if (!placed.ok) return fail(`ostia open: ${placed.message}`)
  const fromStdin = targets.filter((t) => t.kind === 'stdin').length
  if (fromStdin > 1) return fail('ostia open: only one - reads stdin')
  if (parsed.values.name !== undefined && fromStdin === 0) {
    return fail('ostia open: --name goes with -')
  }
  const problems: string[] = []
  const files: FileTarget[] = []
  for (const target of targets) {
    if (target.kind === 'file') files.push(target.file)
    if (target.kind !== 'stdin') continue
    if (process.stdin.isTTY) console.error(TTY_NOTICE)
    const captured = await captureStdin({
      dir: readEnv(ARTIFACTS_ENV),
      name: parsed.values.name,
      stream: process.stdin,
      now: new Date(),
    })
    if (captured.ok) files.push({ path: captured.path })
    else problems.push(captured.message)
  }
  if (wait && files.length === 0 && problems.length === 0) {
    return fail('ostia open: --wait needs a file')
  }
  for (const target of targets) {
    if (target.kind === 'folder') problems.push(...(await revealFolderIn(conn, target.path)))
    if (target.kind === 'url') problems.push(...(await openUrlIn(conn, target.url, background)))
  }
  problems.push(
    ...(await openFilesIn(conn, files, { background, placement: placed.placement, wait })),
  )
  for (const line of problems) console.error(line)
  if (problems.length > 0) process.exitCode = 1
  else if (!wait) console.log('ok')
}

async function runDiffFiles(conn: MessageConnection, args: string[]): Promise<void> {
  let parsed: ParsedArgs<never, never, 'background' | 'wait'>
  try {
    parsed = parseArgs(args, {
      booleans: { background: '-b, --background', wait: '-w, --wait' },
    })
  } catch (err) {
    if (!(err instanceof FlagError)) throw err
    return fail(`ostia diff: ${err.message}`)
  }
  if (parsed.positional.length !== 2) return fail('ostia diff: takes two files: ostia diff <a> <b>')
  const [original, modified] = parsed.positional.map((word) => parseFileArg(word, FILE_PROBE).path)
  const { background, wait } = parsed.booleans
  const res = await conn.sendRequest<DiffFilesResult>('file.diff', {
    original,
    modified,
    ...(background ? { background: true } : {}),
    ...(wait ? { wait: true } : {}),
  })
  if (!res.ok) return fail(diffRefusalLine(res.path, res.error, res.message))
  if (wait && res.waited !== 'closed') return fail(WAIT_ENDED)
  if (!wait) console.log('ok')
}

interface BusOk {
  ok: true
  id?: string
}
interface BusSentResult {
  messages: SentMessage[]
}
interface BusErr {
  ok: false
  error: string
  message?: string
}
interface BusMessage {
  id: string
  from: string
  to: string
  text: string
  ts: string
  seenAt?: string
}
interface BusInboxResult {
  messages: BusMessage[]
}
interface BusWaitResult {
  messages: BusMessage[]
  timedOut: boolean
}
interface BusHandoff {
  id: string
  from: string
  to: string
  task: string
  summary: string
  state: string
  context?: { artifacts?: string[]; workDir?: string }
  ts: string
  updatedAt: string
}
interface BusHandoffsResult {
  handoffs: BusHandoff[]
}

function describeBusError(res: BusErr): string {
  return res.message ? `${res.error}: ${res.message}` : res.error
}

async function runBusVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const rawArgs = process.argv.slice(4)

  if (sub === 'send') {
    const [to, text] = rawArgs
    if (!to || text === undefined) {
      console.error('ostia bus send: missing <toExternalId> "<msg>"')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BusSendOk | BusErr>('bus.send', { to, text })
    if (res.ok) {
      console.log(JSON.stringify(res))
      if (res.asleep) console.error(BUS_ASLEEP_HINT)
      else if (res.delivered === 'queued') console.error(BUS_QUEUED_HINT)
    } else {
      console.error(`ostia: bus send failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'inbox') {
    const { drain } = parseArgs(rawArgs, { booleans: { drain: '--drain' } }).booleans
    const res = await conn.sendRequest<BusInboxResult | BusErr>('bus.inbox', { drain })
    if ('messages' in res) {
      console.log(JSON.stringify(res.messages))
    } else {
      console.error(`ostia: bus inbox failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'sent') {
    const res = await conn.sendRequest<BusSentResult | BusErr>('bus.sent')
    if ('messages' in res) {
      if (rawArgs.includes('--json')) console.log(JSON.stringify(res.messages))
      else for (const line of sentLines(res.messages)) console.log(line)
    } else {
      console.error(`ostia: bus sent failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'hook') {
    process.exitCode = await runBusHook(rawArgs, {
      context: () => conn.sendRequest<{ text?: string | null }>('bus.context'),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    })
  } else if (sub === 'wait') {
    const { values } = parseArgs(rawArgs, { values: { timeout: '--timeout' } })
    const timeoutMs = busWaitTimeoutMs(values.timeout)
    const res = await conn.sendRequest<BusWaitResult | BusErr>('bus.wait', { timeoutMs })
    if ('messages' in res) {
      console.log(JSON.stringify(res))
    } else {
      console.error(`ostia: bus wait failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'handoff') {
    const { values: flags, positional } = parseArgs(rawArgs, {
      values: { task: '--task', summary: '--summary' },
    })
    const to = positional[0]
    if (!to || !flags.task || !flags.summary) {
      console.error('ostia bus handoff: missing <to> --task "..." --summary "..."')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BusSendOk | BusErr>('bus.handoff', {
      to,
      task: flags.task,
      summary: flags.summary,
    })
    if (res.ok) {
      console.log(JSON.stringify(res))
      if (res.delivered === 'queued') console.error(BUS_QUEUED_HINT)
    } else {
      console.error(`ostia: bus handoff failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'claim') {
    const id = rawArgs[0]
    if (!id) {
      console.error('ostia bus claim: missing <id>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BusOk | BusErr>('bus.claim', { id })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`ostia: bus claim failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'handoffs') {
    const { all } = parseArgs(rawArgs, { booleans: { all: '--all' } }).booleans
    const res = await conn.sendRequest<BusHandoffsResult | BusErr>('bus.handoffs', { all })
    if ('handoffs' in res) {
      console.log(JSON.stringify(res.handoffs))
    } else {
      console.error(`ostia: bus handoffs failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'done') {
    const id = rawArgs[0]
    if (!id) {
      console.error('ostia bus done: missing <id>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BusOk | BusErr>('bus.update', { id, state: 'completed' })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`ostia: bus done failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else {
    console.error(
      `ostia bus: unknown subcommand '${sub ?? ''}' (try: send, inbox, sent, wait, handoff, claim, handoffs, done)`,
    )
    process.exitCode = 1
  }
}

interface GatewayOk {
  ok: true
}
interface GatewayErr {
  ok: false
  error: string
  message?: string
}
interface GatewayStatusResult {
  running: boolean
  host: string | null
  port: number | null
  fingerprint: string | null
  deviceCount: number
}
interface GatewayPairResult {
  v: number
  host: string | null
  port: number | null
  fingerprint: string | null
  pairCode: string
  name: string
}
interface GatewayDevice {
  deviceId: string
  name: string
  pubkey: string
  caps: string[]
  createdAt: string
}
interface GatewayDevicesResult {
  devices: GatewayDevice[]
}

function describeGatewayError(res: GatewayErr): string {
  return res.message ? `${res.error}: ${res.message}` : res.error
}

async function runGatewayVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]

  if (sub === 'pair') {
    const res = await conn.sendRequest<GatewayPairResult | GatewayErr>('gateway.pair', {})
    if (isErrResult(res)) {
      console.error(`ostia: gateway pair failed (${describeGatewayError(res)})`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(res, null, 2))
    console.log(`\nostia-pair://${Buffer.from(JSON.stringify(res)).toString('base64url')}`)
    console.log('\n(scan the JSON above as a QR from the phone, or paste the ostia-pair:// URI)')
  } else if (sub === 'status') {
    const res = await conn.sendRequest<GatewayStatusResult | GatewayErr>('gateway.status', {})
    if (isErrResult(res)) {
      console.error(`ostia: gateway status failed (${describeGatewayError(res)})`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(res))
  } else if (sub === 'devices') {
    const res = await conn.sendRequest<GatewayDevicesResult>('gateway.devices', {})
    if (res.devices.length === 0) {
      console.log('(no paired devices)')
      return
    }
    for (const d of res.devices) {
      console.log(`${d.deviceId}\t${d.name}\t${d.caps.join(',')}\t${d.createdAt}`)
    }
  } else if (sub === 'revoke') {
    const deviceId = process.argv[4]
    if (!deviceId) {
      console.error('ostia gateway revoke: missing <deviceId>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<GatewayOk | GatewayErr>('gateway.revoke', { deviceId })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`ostia: gateway revoke failed (${describeGatewayError(res)})`)
      process.exitCode = 1
    }
  } else {
    console.error(
      `ostia gateway: unknown subcommand '${sub ?? ''}' (try: pair, status, devices, revoke)`,
    )
    process.exitCode = 1
  }
}

function numberFlag(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(n)) {
    throw new Error(`--${name} expects a number, got '${raw}'`)
  }
  return n
}

interface ErrResult {
  ok: false
  error: string
  message?: string
}

function isErrResult(res: unknown): res is ErrResult {
  return typeof res === 'object' && res !== null && (res as { ok?: unknown }).ok === false
}

function describeErrResult(res: ErrResult): string {
  return res.message ? `${res.error}: ${res.message}` : res.error
}

const SPLIT_TAB_FLAGS = { splitTab: '--split-tab', split: '--split' } as const

function splitTabParams(flags: {
  splitTab?: string
  split?: string
}): { splitTab?: string; split?: string } | string {
  if (flags.split !== undefined && flags.splitTab === undefined) return '--split needs --split-tab'
  if (flags.split !== undefined && flags.split !== 'right' && flags.split !== 'down') {
    return `--split expects right or down, got '${flags.split}'`
  }
  return {
    ...(flags.splitTab !== undefined ? { splitTab: flags.splitTab } : {}),
    ...(flags.split !== undefined ? { split: flags.split } : {}),
  }
}

async function runAgentVerb(conn: MessageConnection): Promise<void> {
  const { values: flags, positional } = parseArgs(process.argv.slice(4), {
    values: { name: '--name', cwd: '--cwd', workspace: '--workspace', ...SPLIT_TAB_FLAGS },
    unknown: 'keep',
  })
  const [agent, given] = positional
  if (process.argv[3] !== 'run' || !agent || given === undefined) {
    console.error(
      'usage: ostia agent run <agent> [--name N] [--cwd DIR] [--workspace <id|name>] [--split-tab T [--split right|down]] <prompt|->',
    )
    process.exitCode = 1
    return
  }
  const splitTab = splitTabParams(flags)
  if (typeof splitTab === 'string') {
    console.error(`ostia agent run: ${splitTab}`)
    process.exitCode = 1
    return
  }
  const prompt = given === '-' ? await readAllStdin() : given
  const res = await conn.sendRequest<{ id: string; name: string; paneId: string } | ErrResult>(
    'agent.run',
    {
      agent,
      prompt,
      name: flags.name,
      ...(flags.cwd ? { cwd: resolvePath(flags.cwd) } : {}),
      ...(flags.workspace ? { workspace: await resolveWorkspaceRef(conn, flags.workspace) } : {}),
      ...splitTab,
    },
  )
  if (isErrResult(res)) {
    console.error(`ostia: agent run failed (${describeErrResult(res)})`)
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify(res))
}

async function runProcessVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const rawArgs = process.argv.slice(4)

  if (sub === 'run') {
    const { values: flags, positional } = parseArgs(rawArgs, {
      values: { name: '--name', cwd: '--cwd', workspace: '--workspace', ...SPLIT_TAB_FLAGS },
      unknown: 'keep',
    })
    const cmd = positional[0]
    if (!cmd) {
      console.error('ostia process run: missing "<cmd>"')
      process.exitCode = 1
      return
    }
    const splitTab = splitTabParams(flags)
    if (typeof splitTab === 'string') {
      console.error(`ostia process run: ${splitTab}`)
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ id: string; name: string; paneId: string } | ErrResult>(
      'process.run',
      {
        cmd,
        name: flags.name,
        ...(flags.workspace
          ? {
              workspace: await resolveWorkspaceRef(conn, flags.workspace),
              ...(flags.cwd ? { cwd: resolvePath(flags.cwd) } : {}),
            }
          : { cwd: resolvePath(flags.cwd ?? '.') }),
        ...splitTab,
      },
    )
    if (isErrResult(res)) {
      console.error(`ostia: process run failed (${describeErrResult(res)})`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(res))
  } else if (sub === 'ls') {
    const list = await conn.sendRequest<ProcInfo[] | ErrResult>('process.list')
    if (!Array.isArray(list)) {
      const reason = isErrResult(list) ? describeErrResult(list) : 'unexpected response'
      console.error(`ostia: process ls failed (${reason})`)
      process.exitCode = 1
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
    if (!id) {
      console.error('ostia process logs: missing <id|name>')
      process.exitCode = 1
      return
    }
    const sinceCursor = numberFlag(values.since, 'since')
    const res = await conn.sendRequest<
      { data: string; cursor: number; dropped: boolean } | ErrResult
    >('process.output', { id, sinceCursor })
    if (isErrResult(res)) {
      console.error(`ostia: process logs failed (${describeErrResult(res)})`)
      process.exitCode = 1
      return
    }
    if (res.data) process.stdout.write(res.data)
    console.error(`(cursor=${res.cursor}${res.dropped ? ', dropped' : ''})`)
  } else if (sub === 'kill') {
    const id = rawArgs[0]
    if (!id) {
      console.error('ostia process kill: missing <id|name>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true } | ErrResult>('process.kill', { id })
    if (isErrResult(res)) {
      console.error(`ostia: process kill failed (${describeErrResult(res)})`)
      process.exitCode = 1
      return
    }
    console.log('ok')
  } else if (sub === 'restart') {
    const id = rawArgs[0]
    if (!id) {
      console.error('ostia process restart: missing <id|name>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ id: string } | ErrResult>('process.restart', { id })
    if (isErrResult(res)) {
      console.error(`ostia: process restart failed (${describeErrResult(res)})`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(res))
  } else {
    console.error(
      `ostia process: unknown subcommand '${sub ?? ''}' (try: run, ls, logs, kill, restart)`,
    )
    process.exitCode = 1
  }
}

async function runSettingsVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]

  if (sub === 'get') {
    const key = process.argv[4]
    const res = await conn.sendRequest<CommandResult>('command.exec', {
      id: 'settings.get',
      args: key ? { key } : undefined,
    })
    if (res.ok) {
      console.log(JSON.stringify(res.result ?? null, null, 2))
    } else {
      console.error('ostia:', res.error?.message)
      process.exitCode = 1
    }
  } else if (sub === 'set') {
    const { positional, booleans } = parseArgs(process.argv.slice(4), {
      booleans: { dryRun: '--dry-run' },
      unknown: 'keep',
    })
    const { dryRun } = booleans
    const [key, rawValue] = positional
    if (!key || rawValue === undefined) {
      console.error('ostia settings set: missing <key> <value>')
      process.exitCode = 1
      return
    }
    let value: unknown
    try {
      value = JSON.parse(rawValue)
    } catch {
      value = rawValue
    }
    await printSettingsCommand(conn, 'settings.set', { key, value, ...(dryRun ? { dryRun } : {}) })
  } else if (sub === 'unset') {
    const key = process.argv[4]
    if (!key) {
      console.error('ostia settings unset: missing <key>')
      process.exitCode = 1
      return
    }
    await printSettingsCommand(conn, 'settings.unset', { key })
  } else if (sub === 'schema') {
    const key = process.argv[4]
    await printSettingsCommand(conn, 'settings.schema', key ? { key } : undefined)
  } else {
    console.error(
      `ostia settings: unknown subcommand '${sub ?? ''}' (try: get, set, unset, schema)`,
    )
    process.exitCode = 1
  }
}

async function printSettingsCommand(
  conn: MessageConnection,
  id: string,
  args: Record<string, unknown> | undefined,
): Promise<void> {
  const res = await conn.sendRequest<CommandResult>('command.exec', { id, args })
  if (res.ok) {
    console.log(JSON.stringify(res.result ?? null, null, 2))
  } else {
    console.error('ostia:', res.error?.message)
    process.exitCode = 1
  }
}

async function runStateVerb(conn: MessageConnection): Promise<void> {
  const { positional, values } = parseArgs(process.argv.slice(3), {
    values: { pane: '--pane' },
    unknown: 'keep',
  })
  const paneId = values.pane
  const [state, rawMessage] = positional
  if (!state || !STATE_VERBS.includes(state)) {
    console.error(`ostia state: expected one of ${STATE_VERBS.join('|')}`)
    process.exitCode = 1
    return
  }
  const message = rawMessage === '-' ? messageFromStdin(await readAllStdin()) : rawMessage
  const res = await conn.sendRequest<{ ok: boolean; error?: string; message?: string }>(
    'pane.setAttention',
    { state, message, paneId },
  )
  if (res.ok) {
    console.log('ok')
  } else {
    console.error(`ostia state: ${res.error ?? 'failed'}${res.message ? ` (${res.message})` : ''}`)
    process.exitCode = 1
  }
}

const WORKSPACE_USAGE =
  'ostia workspace: usage: workspace list [--json] | describe <text|-> | describe --clear | ' +
  'group <name> | ungroup | dir [path] | rename [--workspace <id>] <name…> | rename --clear | ' +
  'import-cmux [session-file] [--json]'

interface WorkspaceListing {
  workspaceId: string
  name: string
  state: string
  workDir: string
  groupId?: string
}

interface WorkspaceGroupListing {
  groupId: string
  name: string
}

async function runWorkspaceList(conn: MessageConnection, json: boolean): Promise<void> {
  const [workspaces, groups] = await Promise.all([
    conn.sendRequest<WorkspaceListing[]>('workspace.list'),
    conn.sendRequest<WorkspaceGroupListing[]>('workspace.groups'),
  ])
  if (json) {
    console.log(JSON.stringify({ workspaces, groups }, null, 2))
    return
  }
  const groupName = new Map(groups.map((g) => [g.groupId, g.name]))
  for (const w of workspaces) {
    const group = w.groupId ? (groupName.get(w.groupId) ?? '') : ''
    console.log([w.workspaceId, group || '-', w.name, w.state, w.workDir].join('\t'))
  }
}

async function runWorkspaceCommand(
  conn: MessageConnection,
  verb: string,
  id: string,
  args?: unknown,
): Promise<void> {
  const res = await conn.sendRequest<CommandResult>('command.exec', { id, args })
  if (res.ok) {
    console.log('ok')
  } else {
    console.error(`ostia workspace ${verb}: ${res.error?.message ?? 'failed'}`)
    process.exitCode = 1
  }
}

async function runWorkspaceVerb(conn: MessageConnection): Promise<void> {
  const [sub, ...rest] = process.argv.slice(3)
  if (sub === 'list') {
    await runWorkspaceList(conn, parseArgs(rest, { booleans: { json: '--json' } }).booleans.json)
    return
  }
  if (sub === 'group') {
    const name = rest.join(' ').trim()
    if (!name) {
      console.error('ostia workspace group: missing <name>')
      process.exitCode = 1
      return
    }
    await runWorkspaceCommand(conn, 'group', 'workspace.group', { name })
    return
  }
  if (sub === 'ungroup') {
    await runWorkspaceCommand(conn, 'ungroup', 'workspace.ungroup')
    return
  }
  if (sub === 'import-cmux') {
    process.exitCode = await runCmuxImportVerb(conn, rest, process.cwd())
    return
  }
  if (sub === 'dir') {
    const dir = resolvePath(rest[0] ?? '.')
    const res = await conn.sendRequest<CommandResult>('command.exec', {
      id: 'workspace.setFolder',
      args: { dir },
    })
    if (res.ok) {
      console.log(dir)
    } else {
      console.error(`ostia workspace dir: ${res.error?.message ?? 'failed'}`)
      process.exitCode = 1
    }
    return
  }
  if (sub === 'rename') {
    let params: { workspace?: string; name: string }
    try {
      params = parseWorkspaceRenameArgs(rest)
    } catch (err) {
      console.error(`ostia workspace rename: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
      return
    }
    await conn.sendRequest('workspace.rename', params)
    console.log('ok')
    return
  }
  if (sub !== 'describe') {
    console.error(WORKSPACE_USAGE)
    process.exitCode = 1
    return
  }
  const { positional, booleans } = parseArgs(rest, {
    booleans: { clear: '--clear' },
    unknown: 'keep',
  })
  const { clear } = booleans
  const raw = positional.join(' ')
  const text = clear ? '' : raw === '-' ? await readAllStdin() : raw
  if (!clear && !text.trim()) {
    console.error('ostia workspace describe: missing <text|-> (or --clear)')
    process.exitCode = 1
    return
  }
  const res = await conn.sendRequest<CommandResult>('command.exec', {
    id: 'workspace.describe',
    args: { text },
  })
  if (res.ok) {
    console.log('ok')
  } else {
    console.error(`ostia workspace describe: ${res.error?.message ?? 'failed'}`)
    process.exitCode = 1
  }
}

const WORKFLOW_USAGE = 'ostia workflow: usage: workflow list [--json] | show <name> [--json]'

function describeWorkflow(w: WorkflowEntry): string {
  const lines = [`name: ${w.name}`, `source: ${w.source} (${w.origin})`]
  if (w.description) lines.push(`description: ${w.description}`)
  if (w.tags.length > 0) lines.push(`tags: ${w.tags.join(', ')}`)
  lines.push(`command: ${w.command}`)
  if (w.arguments.length > 0) {
    lines.push('arguments:')
    for (const a of w.arguments) {
      const about = a.description ? ` — ${a.description}` : ''
      const fallback = a.defaultValue !== undefined ? ` (default: ${a.defaultValue})` : ''
      lines.push(`  ${a.name}${about}${fallback}`)
    }
  }
  if (w.shells) lines.push(`shells: ${w.shells.join(', ')}`)
  if (w.author) lines.push(`author: ${w.author}`)
  if (w.sourceUrl) lines.push(`source_url: ${w.sourceUrl}`)
  return lines.join('\n')
}

async function runWorkflowVerb(conn: MessageConnection): Promise<void> {
  const [sub, ...rest] = process.argv.slice(3)
  const { positional, booleans } = parseArgs(rest, {
    booleans: { json: '--json' },
    unknown: 'keep',
  })
  const { json } = booleans
  const name = positional.join(' ').trim()
  if (sub !== 'list' && !(sub === 'show' && name)) {
    console.error(WORKFLOW_USAGE)
    process.exitCode = 1
    return
  }
  const listing = await conn.sendRequest<WorkflowListing>('workflow.list')
  if (sub === 'list') {
    if (json) {
      console.log(JSON.stringify(listing, null, 2))
      return
    }
    for (const w of listing.workflows) {
      console.log([w.name, `${w.source}:${w.origin}`, w.command.replace(/\n/g, ' ')].join('\t'))
    }
    for (const p of listing.problems) {
      console.error(`ostia workflow: couldn't read ${p.source}:${p.origin}: ${p.error}`)
    }
    return
  }
  const matches = listing.workflows.filter((w) => w.name === name)
  if (matches.length === 0) {
    console.error(`ostia workflow show: no workflow named '${name}'`)
    process.exitCode = 1
    return
  }
  console.log(json ? JSON.stringify(matches, null, 2) : matches.map(describeWorkflow).join('\n\n'))
}

async function runClaudeHookVerb(conn: MessageConnection): Promise<void> {
  const event = process.argv[3]
  if (!isClaudeAttentionEvent(event) && !isClaudeWorkEvent(event)) {
    const events = [...new Set([...CLAUDE_ATTENTION_EVENTS, ...CLAUDE_WORK_EVENTS])]
    console.error(`ostia claude-hook: usage: claude-hook <${events.join('|')}>`)
    process.exitCode = 1
    return
  }
  const input = await readAllStdin()
  if (isClaudeWorkEvent(event)) {
    await conn.sendRequest('pane.reportWork', claudeWorkReport(event, input))
  }
  const attention = isClaudeAttentionEvent(event) ? claudeAttention(event, input) : null
  if (!attention) return
  const res = await conn.sendRequest<{ ok: boolean; error?: string }>('pane.setAttention', {
    state: attention.state,
    message: attention.message || undefined,
  })
  if (!res.ok) {
    console.error(`ostia claude-hook: ${res.error ?? 'failed'}`)
    process.exitCode = 1
  }
}

async function runResumeTokenVerb(conn: MessageConnection): Promise<void> {
  const [agent, raw] = process.argv.slice(3)
  if (!isResumableAgent(agent) || !raw) {
    console.error(`ostia resume-token: usage: resume-token <${RESUMABLE_AGENTS.join('|')}> <id|->`)
    process.exitCode = 1
    return
  }
  const session = resumeFromHookPayload(raw === '-' ? await readAllStdin() : raw)
  if (!session) {
    console.error('ostia resume-token: no agent session id found')
    process.exitCode = 1
    return
  }
  const res = await conn.sendRequest<{ ok: boolean; error?: string }>('pane.setResume', {
    agent,
    ...session,
  })
  if (res.ok) {
    console.log('ok')
  } else {
    console.error(`ostia resume-token: ${res.error ?? 'failed'}`)
    process.exitCode = 1
  }
}

const USAGE = `usage: ostia <command> [args]
       ostia --version

commands:
  whoami | commands | info | cwd | pane.list | workspace.list | docs
  notify <title> [body]
  ask "<question>" [--context <text|->] [--choice <label>]… [--multi] [--timeout <s>] [--json]
                            ask the human and wait for the answer (exit 2 dismissed, 3 timed
                            out, 4 pane closed)
  state <waiting|done|working|error|clear> [message|-] [--pane <externalId>]
  workspace describe <text|-> | --clear   one-line summary under this workspace in the sidebar
  workspace dir [path]      make this folder (default: the current one) the workspace's folder
  workspace list [--json]   every workspace with its sidebar group (--json adds the groups)
  workspace group <name> | ungroup   move this workspace into a sidebar group, or out of it
  workspace import-cmux [file] [--json]   recreate cmux's saved workspaces, splits and tabs
  resume-token <claude|codex> <id|->  remember how to resume this pane's agent after a restart
  workflow list [--json] | show <name> [--json]   saved command workflows (read-only)
  view list [--json] | open <name>   declarative views (~/.config/ostia/views/<name>.json)
  view validate <file> | schema      check a view file / print its JSON schema (no app needed)
  <target>... | open [-b|--background] [--tab | --split right|down] [-w|--wait] <target>...
                            show a file (file:line[:col] jumps), a folder (in the Files
                            panel), an http(s) URL (in a browser pane) or - (stdin, saved
                            into $OSTIA_ARTIFACTS; --name <file> names it). The new tab takes
                            focus only when this pane has it; -b never takes it.
                            --tab opens a tab beside this pane, --split a split of it.
                            --wait returns when the tab is closed (EDITOR="ostia --wait"):
                            exit 0 on a close, 1 when the wait ended any other way
  diff [-b] [-w|--wait] <a> <b>   compare two text files, read-only
  -n <dir>                  new workspace on that folder
  process run "<cmd>" [--name N] [--cwd DIR] [--workspace <id|name>]
              [--split-tab T [--split right|down]] | ls | logs | kill | restart <id|name>
                            run a command in a new terminal tab the human can watch;
                            the same --split-tab T puts them side by side in one tab
  agent run <agent> [--name N] [--cwd DIR] [--workspace <id|name>]
            [--split-tab T [--split right|down]] <prompt|->
                            start claude, codex or an agent the human configured in a new
                            terminal tab with that prompt; talk to it with ostia pane
  pane send <pane> <text> [--enter] | key <pane> <key>… | read <pane> [--lines N]
                            type into or read another terminal pane (asks the human unless
                            you opened it with ostia process run)
  pane wait <pane>… [--until done|waiting|idle|exited]… [--timeout <s>] [--json]
                            block until one of those panes' agents stops working; exit 0
                            reached, 3 timed out, 4 pane closed
  pane wake <pane>… [--wait [--timeout <s>]] [--json]
                            wake hibernated agent panes: each types its agent's resume
                            command at a fresh prompt (same asks as pane send); --wait
                            returns once their agents started: exit 0 started, 3 timed
                            out, 4 pane closed
  pane close <pane>… [--json]
                            close those panes at once, even while a command runs (a tab you
                            opened needs nothing more, any other asks for kill-pane)
  pane move <pane>… --workspace <id|name> [--json]
                            move those running tabs into another workspace of their window
                            (a tab you opened needs nothing more, any other asks for
                            type-other-pane; all-workspaces outside your reach)
  vault | bus | settings | browse | gateway | token <subcommand> ...
  ext ls | ext <extId> <command> [args...]
  <extId> <command> [args...]  an extension command, e.g. ostia ssh hosts
  git status | changes | diff | open | log | blame | stage | unstage | commit
                            the repository of your folder (see: ostia git)
  ports ls [--all]          listening ports and ssh hosts of your workspace
  <command.id> [json-args] [--workspace <id|name>]
                            run any registered command (see: ostia commands); --workspace runs
                            it in that workspace (needs all-workspaces)
  workspace.new [json-args] [--no-focus]   open a workspace without switching to it

run 'ostia docs' inside an Ostia pane for the full reference.`

function connectSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolveSocket, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolveSocket(socket)
    })
    socket.once('error', reject)
  })
}

async function main(): Promise<void> {
  const token = paneToken()
  const socketPath =
    readEnv('SOCKET') ??
    (token?.startsWith(SCRIPT_TOKEN_PREFIX) ? readControlSocket(controlInfoPath()) : undefined)
  const [cmd] = process.argv.slice(2)
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE)
    return
  }
  if (cmd === '--version') {
    const version = buildVersionAt(__dirname)
    if (version) console.log(version)
    else {
      console.error('ostia: build-info.json is missing')
      process.exitCode = 1
    }
    return
  }
  if (isOfflineViewVerb(process.argv.slice(2))) {
    process.exitCode = runOfflineViewVerb(process.argv.slice(2))
    return
  }
  if (!socketPath) {
    if (
      cmd &&
      fileWord(cmd, FILE_PROBE) === 'path' &&
      FILE_PROBE.isFile(parseFileArg(cmd, FILE_PROBE).path)
    ) {
      console.error('ostia: files open from a terminal inside Ostia (OSTIA_SOCKET unset)')
      process.exitCode = 1
      return
    }
    process.exitCode = await runPortalCommand(process.argv.slice(2), {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      cwd: process.cwd(),
    })
    return
  }
  let socket: Socket
  try {
    socket = await connectSocket(socketPath)
  } catch {
    if (await saveAttentionOffline(process.argv.slice(2), readAllStdin)) return
    console.error(`ostia: app not reachable at ${socketPath}`)
    process.exit(1)
  }
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  let done = false
  let connectionLost = false
  const onLost = (): void => {
    if (done || connectionLost) return
    connectionLost = true
    process.exitCode = 1
    conn.dispose()
  }
  socket.on('error', onLost)
  socket.on('close', onLost)
  conn.onClose(onLost)
  conn.listen()
  try {
    await conn.sendRequest('hello', { token })
    if (cmd === 'whoami') {
      const who = await conn.sendRequest('whoami')
      console.log(JSON.stringify(who, null, 2))
    } else if (cmd === 'commands') {
      const list = await conn.sendRequest('command.list')
      console.log(JSON.stringify(list, null, 2))
    } else if (cmd === 'info') {
      const info = await conn.sendRequest('pane.info')
      console.log(JSON.stringify(info, null, 2))
    } else if (cmd === 'cwd') {
      const res = await conn.sendRequest<{ cwd: string | null }>('cwd.get')
      console.log(res.cwd ?? '')
    } else if (cmd === 'pane.list') {
      const panes = await conn.sendRequest('pane.list')
      console.log(JSON.stringify(panes, null, 2))
    } else if (cmd === 'workspace.list') {
      const workspaces = await conn.sendRequest('workspace.list')
      console.log(JSON.stringify(workspaces, null, 2))
    } else if (cmd === 'notify') {
      const title = process.argv[3]
      const body = process.argv[4]
      const res = await conn.sendRequest<{ ok: boolean; error?: string }>('notify', { title, body })
      if (res.ok) {
        console.log('ok')
      } else {
        console.error(`ostia notify: ${res.error ?? 'failed'}`)
        process.exitCode = 1
      }
    } else if (cmd === 'ask') {
      process.exitCode = await runAskVerb(conn, process.argv.slice(3), readAllStdin)
    } else if (cmd === 'state') {
      await runStateVerb(conn)
    } else if (cmd === 'workspace') {
      await runWorkspaceVerb(conn)
    } else if (cmd === 'resume-token') {
      await runResumeTokenVerb(conn)
    } else if (cmd === 'claude-hook') {
      await runClaudeHookVerb(conn)
    } else if (cmd === 'permission-hook') {
      process.exitCode = await runPermissionHook(process.argv.slice(3), {
        readInput: readAllStdin,
        ask: (params) => conn.sendRequest('permission.ask', params),
        out: (line) => console.log(line),
        err: (line) => console.error(line),
      })
    } else if (cmd === 'agent-hook') {
      process.exitCode = await runAgentHook(process.argv.slice(3), {
        readInput: readAllStdin,
        invoke: (params) => conn.sendRequest('ext.invoke', params),
        out: (line) => console.log(line),
        err: (line) => console.error(line),
      })
    } else if (cmd === 'workflow') {
      await runWorkflowVerb(conn)
    } else if (cmd === 'git') {
      await runGitVerb(conn, process.argv.slice(3))
    } else if (cmd === 'ports') {
      await runPortsVerb(conn, process.argv.slice(3))
    } else if (cmd === 'view') {
      await runViewVerb(conn, process.argv.slice(3))
    } else if (cmd === 'open') {
      await runOpenFiles(conn, process.argv.slice(3))
    } else if (cmd === 'diff') {
      await runDiffFiles(conn, process.argv.slice(3))
    } else if (cmd === 'docs') {
      const res = await conn.sendRequest<{ cli: string }>('docs')
      console.log(res.cli)
    } else if (cmd === 'process') {
      await runProcessVerb(conn)
    } else if (cmd === 'agent') {
      await runAgentVerb(conn)
    } else if (cmd === 'pane') {
      process.exitCode = await runPaneVerb(conn, process.argv.slice(3), readAllStdin)
    } else if (cmd === 'token') {
      process.exitCode = await runTokenVerb(conn, process.argv.slice(3))
    } else if (cmd === 'vault') {
      await runVaultVerb(conn)
    } else if (cmd === 'sandbox') {
      await runSandboxVerb(conn)
    } else if (cmd === 'secret') {
      await runSecretVerb(conn)
    } else if (cmd === 'ext') {
      if (process.argv[3] === 'ls') await runExtList(conn)
      else await runExtCommand(conn, process.argv[3], process.argv[4], process.argv.slice(5))
    } else if (cmd && !CORE_VERBS.has(cmd) && (await opensAsFile(conn, cmd))) {
      await runOpenFiles(conn, process.argv.slice(2))
    } else if (cmd && !cmd.includes('.') && !CORE_VERBS.has(cmd)) {
      await runExtCommand(conn, cmd, process.argv[3], process.argv.slice(4))
    } else if (cmd === 'manager') {
      process.exitCode = await runManagerVerb(conn, process.argv.slice(3), process.cwd())
    } else if (cmd === 'bus') {
      await runBusVerb(conn)
    } else if (cmd === 'settings') {
      await runSettingsVerb(conn)
    } else if (cmd === 'browse') {
      await runBrowse(conn, process.argv.slice(3))
    } else if (cmd === 'gateway') {
      await runGatewayVerb(conn)
    } else if (cmd && wantsHelp(process.argv[3])) {
      const list = await conn.sendRequest<CommandDescriptor[]>('command.list')
      const found = list.find((c) => c.id === cmd)
      if (found) {
        console.log(commandHelp(found))
      } else {
        console.error(`ostia: unknown command '${cmd}' (try: ostia commands)`)
        process.exitCode = 1
      }
    } else if (cmd) {
      const flags = parseCommandFlags(process.argv.slice(3))
      const workspace = flags.workspace
        ? await resolveWorkspaceRef(conn, flags.workspace)
        : undefined
      const res = await conn.sendRequest<CommandResult>(
        'command.exec',
        buildCommandCall(cmd, flags, workspace),
      )
      if (res.ok) {
        console.log('ok')
        if (res.result !== undefined) console.log(JSON.stringify(res.result))
      } else {
        console.error('ostia:', res.error?.message)
        process.exitCode = 1
      }
    } else {
      console.error(
        `ostia: unknown command '${cmd ?? ''}' (try: whoami, commands, info, cwd, pane.list, workspace.list, notify, ask, state, open, docs, process, pane, vault, bus, settings, browse, gateway, ext)`,
      )
      process.exitCode = 1
    }
  } catch (e) {
    if (connectionLost) {
      console.error('ostia: connection to the app closed (did Ostia quit?)')
    } else {
      console.error('ostia:', describeFailure(e))
    }
    process.exitCode = 1
  } finally {
    done = true
    conn.dispose()
    socket.destroy()
  }
}
void main()
