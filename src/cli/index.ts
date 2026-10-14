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
import { controlInfoPath, readControlSocket } from '../main/control/controlDiscovery'
import { capturedArgs } from '../shared/agents/agentLaunch'
import {
  RESUMABLE_AGENTS,
  isResumableAgent,
  resumeFromHookPayload,
} from '../shared/agents/agentResume'
import { CLAUDE_WORK_EVENTS, claudeWorkReport, isClaudeWorkEvent } from '../shared/agents/agentWork'
import {
  CLAUDE_ATTENTION_EVENTS,
  claudeAttention,
  isClaudeAttentionEvent,
} from '../shared/agents/claudeAttention'
import { readEnv } from '../shared/appEnv'
import { ARTIFACTS_ENV } from '../shared/artifacts/artifacts'
import type {
  DiffFilesResult,
  FileTarget,
  OpenFilesResult,
  RevealFolderResult,
} from '../shared/files/openFiles'
import { SCRIPT_TOKEN_PREFIX } from '../shared/permissions/scriptTokens'
import type { SnippetEntry, SnippetListing } from '../shared/snippets'
import type { CommandDescriptor, CommandResult } from '../shared/types'
import { FlagError, type ParsedArgs, parseArgs } from './common/args'
import { commandHelp, wantsHelp } from './common/commandHelp'
import { buildCommandCall, parseCommandFlags, resolveWorkspaceRef } from './common/crossWorkspace'
import { describeFailure } from './common/failure'
import {
  type FileProbe,
  diffRefusalLine,
  openTarget,
  parseFileArg,
  refusalLine,
  revealRefusalLine,
} from './common/fileArgs'
import { paneToken } from './common/paneToken'
import { TTY_NOTICE, captureStdin } from './common/stdinCapture'
import { type UsageAnswer, findNoun, topUsage, usageGate, usageOf } from './common/usageTable'
import { buildVersionAt } from './common/version'
import { runAgentHook } from './hooks/agentHook'
import { STATE_VERBS, messageFromStdin, saveAttentionOffline } from './hooks/offlineAttention'
import { runPermissionHook } from './hooks/permissionHook'
import { runTokenVerb } from './hooks/token'
import { runAskVerb } from './verbs/ask'
import { runBrowse } from './verbs/browse'
import {
  BUS_ASLEEP_HINT,
  BUS_QUEUED_HINT,
  type BusSendOk,
  type SentMessage,
  busWaitTimeoutMs,
  runBusHook,
  sentLines,
} from './verbs/bus'
import { runCmuxImportVerb } from './verbs/cmuxImport'
import { runGitVerb, runPortsVerb } from './verbs/coreBoards'
import { runInstallPolkit } from './verbs/installPolkit'
import { runManagerVerb } from './verbs/manager'
import {
  parseGroupColorArgs,
  parseGroupDeleteArgs,
  parseGroupRenameArgs,
  parseWorkspaceGroupArgs,
  parseWorkspaceRenameArgs,
  runPaneVerb,
} from './verbs/pane'
import { runPortalCommand } from './verbs/portal'
import { isOfflineViewVerb, runOfflineViewVerb, runViewVerb } from './verbs/view'

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
  if (sub === 'list') {
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
    failUsage('secret')
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
    failUsage('sandbox')
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
  } else if (sub === 'list') {
    const res = await conn.sendRequest<VaultListResult | VaultErr>('vault.list', { scope })
    if ('keys' in res) {
      for (const k of res.keys) console.log(k)
    } else {
      console.error(`ostia: vault list failed (${describeVaultError(res)})`)
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
    failUsage('vault')
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
  verb?: string
  commands: ExtCommandInfo[]
}

type ExtResult =
  | { ok: true; text?: string; data?: unknown }
  | { ok: false; error: string; message?: string; data?: unknown }

async function runExtList(conn: MessageConnection): Promise<void> {
  if (process.argv[3] !== 'list') return failUsage('ext')
  const list = await conn.sendRequest<ExtInfo[]>('ext.list')
  for (const ext of list) {
    console.log(`${ext.id}\t${ext.status}\t${ext.name}`)
    for (const cmd of ext.commands)
      console.log(`  ostia ${ext.verb ?? ext.id} ${cmd.usage ?? cmd.id}\t${cmd.title}`)
  }
}

function extUsage(ext: ExtInfo): string {
  const word = ext.verb ?? ext.id
  const lines = ext.commands.map((c) => `  ostia ${word} ${c.usage ?? c.id}\n      ${c.title}`)
  return [`usage: ostia ${word} <command>   ${ext.name}`, ...lines].join('\n')
}

async function runExtCommand(
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
    console.error(topUsage())
    process.exitCode = 1
    return
  }
  if (!command || (ext.verb && extId !== ext.verb)) {
    console.error(extUsage(ext))
    process.exitCode = 1
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
  if (cmd.stdin) args.stdin = await readAllStdin()
  const res = await conn.sendRequest<ExtResult>('ext.invoke', { extId: ext.id, command, args })
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

interface OpenHow {
  background: boolean
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

const WAIT_ENDED = 'ostia: the wait ended before the tab was closed'

function fail(message: string): void {
  console.error(message)
  process.exitCode = 1
}

function failUsage(noun: string): void {
  fail(usageOf(noun))
}

async function runOpenFiles(conn: MessageConnection, args: string[]): Promise<void> {
  let parsed: ParsedArgs<'name', never, 'background' | 'wait'>
  try {
    parsed = parseArgs(args, {
      values: { name: '--name' },
      booleans: { background: '-b, --background', wait: '-w, --wait' },
    })
  } catch (err) {
    if (!(err instanceof FlagError)) throw err
    return fail(`ostia open: ${err.message}\n${usageOf('open')}`)
  }
  const targets = parsed.positional.map((word) => openTarget(word, FILE_PROBE))
  if (targets.length === 0) return fail(usageOf('open'))
  const { background, wait } = parsed.booleans
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
  problems.push(...(await openFilesIn(conn, files, { background, wait })))
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
  if (parsed.positional.length !== 2) return fail(usageOf('diff'))
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
    failUsage('bus')
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
    failUsage('gateway')
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

async function runAgentVerb(conn: MessageConnection): Promise<void> {
  const { values: flags, positional } = parseArgs(process.argv.slice(4), {
    values: { name: '--name', cwd: '--cwd', workspace: '--workspace', tab: '--tab' },
  })
  const [agent, given] = positional
  if (process.argv[3] !== 'run' || !agent || given === undefined) return failUsage('agent')
  const prompt = given === '-' ? await readAllStdin() : given
  const res = await conn.sendRequest<{ id: string; name: string; paneId: string } | ErrResult>(
    'agent.run',
    {
      agent,
      prompt,
      name: flags.name,
      ...(flags.cwd ? { cwd: resolvePath(flags.cwd) } : {}),
      ...(flags.workspace ? { workspace: await resolveWorkspaceRef(conn, flags.workspace) } : {}),
      ...(flags.tab !== undefined ? { tab: flags.tab } : {}),
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
      values: { name: '--name', cwd: '--cwd', workspace: '--workspace', tab: '--tab' },
    })
    const cmd = positional[0]
    if (!cmd) return failUsage('process')
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
        ...(flags.tab !== undefined ? { tab: flags.tab } : {}),
      },
    )
    if (isErrResult(res)) {
      console.error(`ostia: process run failed (${describeErrResult(res)})`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(res))
  } else if (sub === 'list') {
    const list = await conn.sendRequest<ProcInfo[] | ErrResult>('process.list')
    if (!Array.isArray(list)) {
      const reason = isErrResult(list) ? describeErrResult(list) : 'unexpected response'
      console.error(`ostia: process list failed (${reason})`)
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
    if (!id) return failUsage('process')
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
    if (!id) return failUsage('process')
    const res = await conn.sendRequest<{ ok: true } | ErrResult>('process.kill', { id })
    if (isErrResult(res)) {
      console.error(`ostia: process kill failed (${describeErrResult(res)})`)
      process.exitCode = 1
      return
    }
    console.log('ok')
  } else if (sub === 'restart') {
    const id = rawArgs[0]
    if (!id) return failUsage('process')
    const res = await conn.sendRequest<{ id: string } | ErrResult>('process.restart', { id })
    if (isErrResult(res)) {
      console.error(`ostia: process restart failed (${describeErrResult(res)})`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(res))
  } else {
    failUsage('process')
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
    failUsage('settings')
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
  if (!state || !STATE_VERBS.includes(state)) return failUsage('state')
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
  workspace?: string,
): Promise<void> {
  const res = await conn.sendRequest<CommandResult>('command.exec', {
    id,
    args,
    ...(workspace ? { target: { workspaceId: workspace, paneId: null } } : {}),
  })
  if (res.ok) {
    console.log('ok')
  } else {
    console.error(`ostia workspace ${verb}: ${res.error?.message ?? 'failed'}`)
    process.exitCode = 1
  }
}

async function runWorkspaceNew(conn: MessageConnection, argv: string[]): Promise<void> {
  const { positional, values, booleans } = parseArgs(argv, {
    values: { name: '--name', group: '--group' },
    booleans: { noFocus: '--no-focus' },
  })
  if (positional.length > 1) return failUsage('workspace')
  const res = await conn.sendRequest<CommandResult>('command.exec', {
    id: 'workspace.new',
    args: {
      dir: resolvePath(positional[0] ?? '.'),
      ...(values.name ? { name: values.name } : {}),
      ...(values.group ? { group: values.group } : {}),
      ...(booleans.noFocus ? { focus: false } : {}),
    },
  })
  if (!res.ok) return fail(`ostia workspace new: ${res.error.message}`)
  console.log(JSON.stringify(res.result))
}

async function runWorkspaceVerb(conn: MessageConnection): Promise<void> {
  const [sub, ...rest] = process.argv.slice(3)
  if (sub === 'list') {
    await runWorkspaceList(conn, parseArgs(rest, { booleans: { json: '--json' } }).booleans.json)
    return
  }
  if (sub === 'group' || sub === 'ungroup') {
    let params: { workspace?: string; name: string }
    try {
      params = parseWorkspaceGroupArgs(rest, sub === 'group')
    } catch (err) {
      console.error(`ostia workspace ${sub}: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
      return
    }
    await runWorkspaceCommand(
      conn,
      sub,
      sub === 'group' ? 'workspace.group' : 'workspace.ungroup',
      sub === 'group' ? { name: params.name } : undefined,
      params.workspace,
    )
    return
  }
  if (sub === 'close') {
    const { positional, values } = parseArgs(rest, { values: { workspace: '--workspace' } })
    if (positional.length > 0) {
      console.error('ostia workspace close: usage: workspace close [--workspace <id>]')
      process.exitCode = 1
      return
    }
    await runWorkspaceCommand(conn, 'close', 'workspace.close', undefined, values.workspace)
    return
  }
  if (sub === 'group-color') {
    let params: { group: string; color: string | null }
    try {
      params = parseGroupColorArgs(rest)
    } catch (err) {
      console.error(
        `ostia workspace group-color: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exitCode = 1
      return
    }
    await runWorkspaceCommand(conn, 'group-color', 'workspace.groupColor', params)
    return
  }
  if (sub === 'group-rename' || sub === 'group-delete') {
    let params: { group: string; name?: string }
    try {
      params = sub === 'group-rename' ? parseGroupRenameArgs(rest) : parseGroupDeleteArgs(rest)
    } catch (err) {
      console.error(`ostia workspace ${sub}: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
      return
    }
    await runWorkspaceCommand(
      conn,
      sub,
      sub === 'group-rename' ? 'workspace.groupRename' : 'workspace.groupDelete',
      params,
    )
    return
  }
  if (sub === 'pin' || sub === 'unpin') {
    const { positional, values } = parseArgs(rest, { values: { workspace: '--workspace' } })
    if (positional.length > 0) {
      console.error(`ostia workspace ${sub}: usage: workspace ${sub} [--workspace <id>]`)
      process.exitCode = 1
      return
    }
    await runWorkspaceCommand(
      conn,
      sub,
      sub === 'pin' ? 'workspace.pin' : 'workspace.unpin',
      undefined,
      values.workspace,
    )
    return
  }
  if (sub === 'new') {
    await runWorkspaceNew(conn, rest)
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
  if (sub !== 'describe') return failUsage('workspace')
  const { positional, booleans, values } = parseArgs(rest, {
    values: { workspace: '--workspace' },
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
    ...(values.workspace ? { target: { workspaceId: values.workspace, paneId: null } } : {}),
  })
  if (res.ok) {
    console.log('ok')
  } else {
    console.error(`ostia workspace describe: ${res.error?.message ?? 'failed'}`)
    process.exitCode = 1
  }
}

function describeSnippet(w: SnippetEntry): string {
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

async function runSnippetVerb(conn: MessageConnection): Promise<void> {
  const [sub, ...rest] = process.argv.slice(3)
  const { positional, booleans } = parseArgs(rest, {
    booleans: { json: '--json' },
    unknown: 'keep',
  })
  const { json } = booleans
  const name = positional.join(' ').trim()
  if (sub !== 'list' && !(sub === 'show' && name)) return failUsage('snippet')
  const listing = await conn.sendRequest<SnippetListing>('snippet.list')
  if (sub === 'list') {
    if (json) {
      console.log(JSON.stringify(listing, null, 2))
      return
    }
    for (const w of listing.snippets) {
      console.log([w.name, `${w.source}:${w.origin}`, w.command.replace(/\n/g, ' ')].join('\t'))
    }
    for (const p of listing.problems) {
      console.error(`ostia snippet: couldn't read ${p.source}:${p.origin}: ${p.error}`)
    }
    return
  }
  const matches = listing.snippets.filter((w) => w.name === name)
  if (matches.length === 0) {
    console.error(`ostia snippet show: no snippet named '${name}'`)
    process.exitCode = 1
    return
  }
  console.log(json ? JSON.stringify(matches, null, 2) : matches.map(describeSnippet).join('\n\n'))
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
  const args = capturedArgs(agent, process.env)
  const res = await conn.sendRequest<{ ok: boolean; error?: string }>('pane.setResume', {
    agent,
    ...session,
    ...(args ? { args } : {}),
  })
  if (res.ok) {
    console.log('ok')
  } else {
    console.error(`ostia resume-token: ${res.error ?? 'failed'}`)
    process.exitCode = 1
  }
}

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

interface WhoAmI {
  externalId: string
  paneId?: string
  workspaceId?: string
}

async function runWhoami(conn: MessageConnection): Promise<void> {
  const who = await conn.sendRequest<WhoAmI>('whoami')
  const state = who.paneId
    ? await conn.sendRequest<{ cwd?: string; running?: boolean } | null>('pane.info')
    : null
  console.log(
    JSON.stringify(
      { ...who, ...(state ? { cwd: state.cwd ?? null, running: state.running === true } : {}) },
      null,
      2,
    ),
  )
}

async function runRawCommand(conn: MessageConnection, cmd: string): Promise<void> {
  if (wantsHelp(process.argv[3])) {
    const list = await conn.sendRequest<CommandDescriptor[]>('command.list')
    const found = list.find((c) => c.id === cmd)
    if (found) console.log(commandHelp(found))
    else fail(`ostia: unknown command '${cmd}' (see: ostia commands)`)
    return
  }
  const flags = parseCommandFlags(process.argv.slice(3))
  const workspace = flags.workspace ? await resolveWorkspaceRef(conn, flags.workspace) : undefined
  const res = await conn.sendRequest<CommandResult>(
    'command.exec',
    buildCommandCall(cmd, flags, workspace),
  )
  if (!res.ok) return fail(`ostia: ${res.error?.message}`)
  console.log('ok')
  if (res.result !== undefined) console.log(JSON.stringify(res.result))
}

async function runNotify(conn: MessageConnection): Promise<void> {
  const [title, body] = process.argv.slice(3)
  const res = await conn.sendRequest<{ ok: boolean; error?: string }>('notify', { title, body })
  if (res.ok) console.log('ok')
  else fail(`ostia notify: ${res.error ?? 'failed'}`)
}

async function runDocs(conn: MessageConnection): Promise<void> {
  const res = await conn.sendRequest<{ cli: string }>('docs')
  console.log(res.cli)
}

type Runner = (conn: MessageConnection) => Promise<void>

const argvFrom3 = (): string[] => process.argv.slice(3)

const RUNNERS: Readonly<Record<string, Runner>> = {
  whoami: runWhoami,
  commands: async (conn) => {
    console.log(JSON.stringify(await conn.sendRequest('command.list'), null, 2))
  },
  docs: runDocs,
  notify: runNotify,
  ask: async (conn) => {
    process.exitCode = await runAskVerb(conn, argvFrom3(), readAllStdin)
  },
  state: runStateVerb,
  workspace: runWorkspaceVerb,
  'resume-token': runResumeTokenVerb,
  'claude-hook': runClaudeHookVerb,
  'permission-hook': async (conn) => {
    process.exitCode = await runPermissionHook(argvFrom3(), {
      readInput: readAllStdin,
      ask: (params) => conn.sendRequest('permission.ask', params),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    })
  },
  'agent-hook': async (conn) => {
    process.exitCode = await runAgentHook(argvFrom3(), {
      readInput: readAllStdin,
      invoke: (params) => conn.sendRequest('ext.invoke', params),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    })
  },
  snippet: runSnippetVerb,
  git: (conn) => runGitVerb(conn, argvFrom3()),
  ports: (conn) => runPortsVerb(conn, argvFrom3()),
  view: (conn) => runViewVerb(conn, argvFrom3()),
  open: (conn) => runOpenFiles(conn, argvFrom3()),
  diff: (conn) => runDiffFiles(conn, argvFrom3()),
  process: runProcessVerb,
  agent: runAgentVerb,
  pane: async (conn) => {
    process.exitCode = await runPaneVerb(conn, argvFrom3(), readAllStdin)
  },
  token: async (conn) => {
    process.exitCode = await runTokenVerb(conn, argvFrom3())
  },
  cmux: async (conn) => {
    process.exitCode = await runCmuxImportVerb(conn, process.argv.slice(4), process.cwd())
  },
  vault: runVaultVerb,
  sandbox: runSandboxVerb,
  secret: runSecretVerb,
  ext: runExtList,
  manager: async (conn) => {
    process.exitCode = await runManagerVerb(conn, argvFrom3(), process.cwd())
  },
  bus: runBusVerb,
  settings: runSettingsVerb,
  browse: (conn) => runBrowse(conn, argvFrom3()),
  gateway: runGatewayVerb,
}

function printUsage(answer: UsageAnswer): void {
  if (answer.code === 0) console.log(answer.text)
  else console.error(answer.text)
  process.exitCode = answer.code
}

async function main(): Promise<void> {
  const token = paneToken()
  const socketPath =
    readEnv('SOCKET') ??
    (token?.startsWith(SCRIPT_TOKEN_PREFIX) ? readControlSocket(controlInfoPath()) : undefined)
  const argv = process.argv.slice(2)
  const [cmd] = argv
  if (cmd === '--version') {
    const version = buildVersionAt(__dirname)
    if (version) console.log(version)
    else fail('ostia: build-info.json is missing')
    return
  }
  if (cmd === 'polkit' && argv[1] === 'install') {
    process.exitCode = runInstallPolkit(argv.slice(2), {
      platform: process.platform,
      uid: process.getuid?.(),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    })
    return
  }
  if (isOfflineViewVerb(argv)) {
    process.exitCode = runOfflineViewVerb(argv)
    return
  }
  if (!socketPath) {
    if (cmd !== undefined && wantsHelp(cmd)) return printUsage({ text: topUsage(), code: 0 })
    if (cmd === 'open') return fail('ostia open: files open from a terminal inside Ostia')
    process.exitCode = await runPortalCommand(argv, {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      cwd: process.cwd(),
    })
    return
  }
  const gated = usageGate(argv)
  if (gated) return printUsage(gated)
  let socket: Socket
  try {
    socket = await connectSocket(socketPath)
  } catch {
    if (await saveAttentionOffline(argv, readAllStdin)) return
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
    await conn.sendRequest('hello', { token, pid: process.ppid })
    const runner = Object.hasOwn(RUNNERS, cmd) ? RUNNERS[cmd] : undefined
    if (runner) await runner(conn)
    else if (cmd.includes('.')) await runRawCommand(conn, cmd)
    else await runExtCommand(conn, cmd, process.argv[3], process.argv.slice(4))
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
