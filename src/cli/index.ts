#!/usr/bin/env node
import { type Socket, createConnection } from 'node:net'
import { resolve as resolvePath } from 'node:path'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import { RESUMABLE_AGENTS, isResumableAgent, resumeIdFromHookPayload } from '../shared/agentResume'
import type { CommandResult } from '../shared/types'

interface ProcInfo {
  id: string
  name: string
  cmd: string
  cwd: string
  status: 'running' | 'exited' | 'killed'
  pid?: number
  exitCode?: number
  startedAt: string
}

function extractGlobalFlag(argv: string[]): { global: boolean; rest: string[] } {
  const rest: string[] = []
  let global = false
  for (const arg of argv) {
    if (arg === '--global') global = true
    else rest.push(arg)
  }
  return { global, rest }
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

async function runVaultVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const { global, rest } = extractGlobalFlag(process.argv.slice(4))
  const scope: 'project' | 'global' = global ? 'global' : 'project'

  if (sub === 'set') {
    const key = rest[0]
    if (!key) {
      console.error('pine vault set: missing <KEY>')
      process.exitCode = 1
      return
    }
    const value = await readSecretFromStdin(`Enter value for ${key}`)
    const res = await conn.sendRequest<VaultOk | VaultErr>('vault.set', { key, value, scope })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: vault set failed (${describeVaultError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'get') {
    const key = rest[0]
    if (!key) {
      console.error('pine vault get: missing <KEY>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<VaultGetResult | VaultErr>('vault.get', { key, scope })
    if ('value' in res) {
      console.log(res.value)
    } else {
      console.error(`pine: vault get failed (${describeVaultError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'ls') {
    const res = await conn.sendRequest<VaultListResult | VaultErr>('vault.list', { scope })
    if ('keys' in res) {
      for (const k of res.keys) console.log(k)
    } else {
      console.error(`pine: vault ls failed (${describeVaultError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'rm') {
    const key = rest[0]
    if (!key) {
      console.error('pine vault rm: missing <KEY>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<VaultOk | VaultErr>('vault.delete', { key, scope })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: vault rm failed (${describeVaultError(res)})`)
      process.exitCode = 1
    }
  } else {
    console.error(`pine vault: unknown subcommand '${sub ?? ''}' (try: set, get, ls, rm)`)
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
  | { ok: false; error: string; message?: string }

async function runExtList(conn: MessageConnection): Promise<void> {
  const list = await conn.sendRequest<ExtInfo[]>('ext.list')
  for (const ext of list) {
    console.log(`${ext.id}\t${ext.status}\t${ext.name}`)
    for (const cmd of ext.commands)
      console.log(`  pine ${ext.id} ${cmd.usage ?? cmd.id}\t${cmd.title}`)
  }
}

async function runExtCommand(
  conn: MessageConnection,
  extId: string | undefined,
  command: string | undefined,
  argv: string[],
): Promise<void> {
  if (!extId || !command) {
    console.error('usage: pine ext <extId> <command> [args...]   (see: pine ext ls)')
    process.exitCode = 1
    return
  }
  const list = await conn.sendRequest<ExtInfo[]>('ext.list')
  const ext = list.find((e) => e.id === extId)
  if (!ext) {
    console.error(`pine: unknown command or extension '${extId}' (see: pine ext ls)`)
    process.exitCode = 1
    return
  }
  const cmd = ext.commands.find((c) => c.id === command)
  if (!cmd) {
    const known = ext.commands.map((c) => c.id).join(', ')
    console.error(`pine ${extId}: unknown subcommand '${command}' (try: ${known})`)
    process.exitCode = 1
    return
  }
  const args: { argv: string[]; stdin?: string } = { argv }
  if (cmd.stdin) args.stdin = await readAllStdin()
  const res = await conn.sendRequest<ExtResult>('ext.invoke', { extId, command, args })
  if (!res.ok) {
    const detail = res.message ? `${res.error}: ${res.message}` : res.error
    console.error(`pine: ${extId} ${command} failed (${detail})`)
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
  'commands',
  'info',
  'cwd',
  'pane.list',
  'workspace.list',
  'notify',
  'state',
  'resume-token',
  'open',
  'docs',
  'process',
  'vault',
  'bus',
  'settings',
  'browse',
  'gateway',
  'ext',
])

interface BusOk {
  ok: true
  id?: string
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
      console.error('pine bus send: missing <toExternalId> "<msg>"')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BusOk | BusErr>('bus.send', { to, text })
    if (res.ok) {
      console.log(JSON.stringify(res))
    } else {
      console.error(`pine: bus send failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'inbox') {
    const drain = rawArgs.includes('--drain')
    const res = await conn.sendRequest<BusInboxResult | BusErr>('bus.inbox', { drain })
    if ('messages' in res) {
      console.log(JSON.stringify(res.messages))
    } else {
      console.error(`pine: bus inbox failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'wait') {
    const { flags } = parseFlags(rawArgs, ['timeout'])
    const timeoutMs = numberFlag(flags, 'timeout')
    const res = await conn.sendRequest<BusWaitResult | BusErr>('bus.wait', { timeoutMs })
    if ('messages' in res) {
      console.log(JSON.stringify(res))
    } else {
      console.error(`pine: bus wait failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'handoff') {
    const { flags, rest } = parseFlags(rawArgs, ['task', 'summary'])
    const to = rest[0]
    if (!to || !flags.task || !flags.summary) {
      console.error('pine bus handoff: missing <to> --task "..." --summary "..."')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BusOk | BusErr>('bus.handoff', {
      to,
      task: flags.task,
      summary: flags.summary,
    })
    if (res.ok) {
      console.log(JSON.stringify(res))
    } else {
      console.error(`pine: bus handoff failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'claim') {
    const id = rawArgs[0]
    if (!id) {
      console.error('pine bus claim: missing <id>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BusOk | BusErr>('bus.claim', { id })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: bus claim failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'handoffs') {
    const all = rawArgs.includes('--all')
    const res = await conn.sendRequest<BusHandoffsResult | BusErr>('bus.handoffs', { all })
    if ('handoffs' in res) {
      console.log(JSON.stringify(res.handoffs))
    } else {
      console.error(`pine: bus handoffs failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'done') {
    const id = rawArgs[0]
    if (!id) {
      console.error('pine bus done: missing <id>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BusOk | BusErr>('bus.update', { id, state: 'completed' })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: bus done failed (${describeBusError(res)})`)
      process.exitCode = 1
    }
  } else {
    console.error(
      `pine bus: unknown subcommand '${sub ?? ''}' (try: send, inbox, wait, handoff, claim, handoffs, done)`,
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
interface GatewayStartResult {
  host: string
  port: number
  fingerprint: string
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
  const { flags, rest } = parseFlags(process.argv.slice(4), ['host', 'port'])

  if (sub === 'enable') {
    const res = await conn.sendRequest<GatewayStartResult | GatewayErr>('gateway.enable', {
      host: flags.host || undefined,
      port: numberFlag(flags, 'port'),
    })
    if (isErrResult(res)) {
      console.error(`pine: gateway enable failed (${describeGatewayError(res)})`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(res))
  } else if (sub === 'disable') {
    const res = await conn.sendRequest<GatewayOk | GatewayErr>('gateway.disable', {})
    if (isErrResult(res)) {
      console.error(`pine: gateway disable failed (${describeGatewayError(res)})`)
      process.exitCode = 1
      return
    }
    console.log('ok')
  } else if (sub === 'pair') {
    const res = await conn.sendRequest<GatewayPairResult | GatewayErr>('gateway.pair', {})
    if (isErrResult(res)) {
      console.error(`pine: gateway pair failed (${describeGatewayError(res)})`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(res, null, 2))
    console.log(`\npine-pair://${Buffer.from(JSON.stringify(res)).toString('base64url')}`)
    console.log('\n(scan the JSON above as a QR from the phone, or paste the pine-pair:// URI)')
  } else if (sub === 'status') {
    const res = await conn.sendRequest<GatewayStatusResult | GatewayErr>('gateway.status', {})
    if (isErrResult(res)) {
      console.error(`pine: gateway status failed (${describeGatewayError(res)})`)
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
    const deviceId = rest[0]
    if (!deviceId) {
      console.error('pine gateway revoke: missing <deviceId>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<GatewayOk | GatewayErr>('gateway.revoke', { deviceId })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: gateway revoke failed (${describeGatewayError(res)})`)
      process.exitCode = 1
    }
  } else {
    console.error(
      `pine gateway: unknown subcommand '${sub ?? ''}' (try: enable, pair, status, devices, revoke, disable)`,
    )
    process.exitCode = 1
  }
}

function parseFlags(
  argv: string[],
  flagNames: string[],
): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const name = arg.startsWith('--') ? arg.slice(2) : undefined
    if (name && flagNames.includes(name)) {
      flags[name] = argv[++i] ?? ''
    } else {
      rest.push(arg)
    }
  }
  return { flags, rest }
}

function numberFlag(flags: Record<string, string>, name: string): number | undefined {
  const raw = flags[name]
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

async function runProcessVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const rawArgs = process.argv.slice(4)

  if (sub === 'run') {
    const { flags, rest } = parseFlags(rawArgs, ['name', 'cwd'])
    const cmd = rest[0]
    if (!cmd) {
      console.error('pine process run: missing "<cmd>"')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ id: string; name: string; pid?: number } | ErrResult>(
      'process.run',
      { cmd, name: flags.name, cwd: flags.cwd },
    )
    if (isErrResult(res)) {
      console.error(`pine: process run failed (${describeErrResult(res)})`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(res))
  } else if (sub === 'ls') {
    const list = await conn.sendRequest<ProcInfo[] | ErrResult>('process.list')
    if (!Array.isArray(list)) {
      const reason = isErrResult(list) ? describeErrResult(list) : 'unexpected response'
      console.error(`pine: process ls failed (${reason})`)
      process.exitCode = 1
      return
    }
    if (list.length === 0) {
      console.log('(no tracked processes)')
      return
    }
    for (const p of list) {
      console.log(`${p.id}\t${p.name}\t${p.status}\t${p.pid ?? '-'}\t${p.cmd}`)
    }
  } else if (sub === 'logs') {
    const { flags, rest } = parseFlags(rawArgs, ['since'])
    const id = rest[0]
    if (!id) {
      console.error('pine process logs: missing <id|name>')
      process.exitCode = 1
      return
    }
    const sinceCursor = numberFlag(flags, 'since')
    const res = await conn.sendRequest<
      { data: string; cursor: number; dropped: boolean } | { ok: false; error: string }
    >('process.output', { id, sinceCursor })
    if ('ok' in res) {
      console.error(`pine: process logs failed (${res.error})`)
      process.exitCode = 1
      return
    }
    if (res.data) process.stdout.write(res.data)
    console.error(`(cursor=${res.cursor}${res.dropped ? ', dropped' : ''})`)
  } else if (sub === 'kill') {
    const id = rawArgs[0]
    if (!id) {
      console.error('pine process kill: missing <id|name>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true } | { ok: false; error: string }>(
      'process.kill',
      { id },
    )
    if (!res.ok) process.exitCode = 1
    console.log(res.ok ? 'ok' : `pine: process.kill failed (${res.error})`)
  } else if (sub === 'restart') {
    const id = rawArgs[0]
    if (!id) {
      console.error('pine process restart: missing <id|name>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ id: string } | { ok: false; error: string }>(
      'process.restart',
      { id },
    )
    if ('ok' in res) {
      console.error(`pine: process restart failed (${res.error})`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(res))
  } else {
    console.error(
      `pine process: unknown subcommand '${sub ?? ''}' (try: run, ls, logs, kill, restart)`,
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
      console.error('pine:', res.error?.message)
      process.exitCode = 1
    }
  } else if (sub === 'set') {
    const key = process.argv[4]
    const rawValue = process.argv[5]
    if (!key || rawValue === undefined) {
      console.error('pine settings set: missing <key> <value>')
      process.exitCode = 1
      return
    }
    let value: unknown
    try {
      value = JSON.parse(rawValue)
    } catch {
      value = rawValue
    }
    const res = await conn.sendRequest<CommandResult>('command.exec', {
      id: 'settings.set',
      args: { key, value },
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error('pine:', res.error?.message)
      process.exitCode = 1
    }
  } else {
    console.error(`pine settings: unknown subcommand '${sub ?? ''}' (try: get, set)`)
    process.exitCode = 1
  }
}

interface BrowseOk {
  ok: true
  created?: boolean
  paneId?: string
}
interface BrowseErr {
  ok: false
  error: string
  message?: string
}

function describeBrowseError(res: BrowseErr): string {
  return res.message ? `${res.error}: ${res.message}` : res.error
}

interface BrowseBufferEntry {
  level: string
  text: string
  ts: number
}
interface BrowseBufferOk {
  ok: true
  entries: BrowseBufferEntry[]
}

interface BrowseDialogEntry {
  type: string
  message: string
  ts: number
}

async function runBrowseBufferSub(
  conn: MessageConnection,
  method: 'browse.console' | 'browse.errors',
  label: string,
  bufSub: string | undefined,
  paneId: string | undefined,
): Promise<void> {
  const resolvedSub = bufSub || 'list'
  if (resolvedSub !== 'list' && resolvedSub !== 'clear') {
    console.error(`pine browse ${label}: expected [list|clear]`)
    process.exitCode = 1
    return
  }
  const res = await conn.sendRequest<BrowseBufferOk | BrowseOk | BrowseErr>(method, {
    sub: resolvedSub,
    paneId,
  })
  if (!res.ok) {
    console.error(`pine: browse ${label} failed (${describeBrowseError(res)})`)
    process.exitCode = 1
    return
  }
  console.log(resolvedSub === 'clear' ? 'ok' : JSON.stringify('entries' in res ? res.entries : []))
}

async function runBrowseVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const { flags, rest } = parseFlags(process.argv.slice(4), [
    'pane',
    'timeout',
    'x',
    'y',
    'selector',
    'attr',
    'property',
    'index',
    'ms',
    'url',
    'domain',
    'path',
  ])
  const paneId = flags.pane || undefined
  const interactive = rest.includes('--interactive')
  const exact = rest.includes('--exact')

  if (sub === 'open') {
    const url = rest[0]
    if (!url) {
      console.error('pine browse open: missing <url>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.open', { url, paneId })
    if (res.ok) {
      console.log(JSON.stringify(res))
    } else {
      console.error(`pine: browse open failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'nav') {
    const action = rest[0]
    if (action !== 'back' && action !== 'forward' && action !== 'reload') {
      console.error('pine browse nav: missing <back|forward|reload>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.nav', { action, paneId })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse nav failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'read') {
    const selector = rest[0]
    const res = await conn.sendRequest<{ ok: true; text: string } | BrowseErr>('browse.read', {
      selector,
      paneId,
    })
    if (res.ok) {
      console.log(res.text)
    } else {
      console.error(`pine: browse read failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'click') {
    const selector = rest[0]
    if (!selector) {
      console.error('pine browse click: missing <selector>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.click', { selector, paneId })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse click failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'type') {
    const [selector, text] = rest
    if (!selector || text === undefined) {
      console.error('pine browse type: missing <selector> <text>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.type', {
      selector,
      text,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse type failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'dblclick') {
    const selector = rest[0]
    if (!selector) {
      console.error('pine browse dblclick: missing <selector>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.dblclick', {
      selector,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse dblclick failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'hover') {
    const selector = rest[0]
    if (!selector) {
      console.error('pine browse hover: missing <selector>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.hover', { selector, paneId })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse hover failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'focus') {
    const selector = rest[0]
    if (!selector) {
      console.error('pine browse focus: missing <selector>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.focus', { selector, paneId })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse focus failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'check') {
    const selector = rest[0]
    if (!selector) {
      console.error('pine browse check: missing <selector>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.check', { selector, paneId })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse check failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'uncheck') {
    const selector = rest[0]
    if (!selector) {
      console.error('pine browse uncheck: missing <selector>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.uncheck', {
      selector,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse uncheck failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'scroll-into-view') {
    const selector = rest[0]
    if (!selector) {
      console.error('pine browse scroll-into-view: missing <selector>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.scrollIntoView', {
      selector,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse scroll-into-view failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'fill') {
    const [selector, text] = rest
    if (!selector || text === undefined) {
      console.error('pine browse fill: missing <selector> <text>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.fill', {
      selector,
      text,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse fill failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'select') {
    const [selector, value] = rest
    if (!selector || value === undefined) {
      console.error('pine browse select: missing <selector> <value>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.select', {
      selector,
      value,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse select failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'scroll') {
    const x = numberFlag(flags, 'x')
    const y = numberFlag(flags, 'y')
    const selector = flags.selector || undefined
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.scroll', {
      x,
      y,
      selector,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse scroll failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'press') {
    const key = rest[0]
    if (!key) {
      console.error('pine browse press: missing <key>')
      process.exitCode = 1
      return
    }
    const selector = flags.selector || undefined
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.press', {
      key,
      selector,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse press failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'keydown') {
    const key = rest[0]
    if (!key) {
      console.error('pine browse keydown: missing <key>')
      process.exitCode = 1
      return
    }
    const selector = flags.selector || undefined
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.keydown', {
      key,
      selector,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse keydown failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'keyup') {
    const key = rest[0]
    if (!key) {
      console.error('pine browse keyup: missing <key>')
      process.exitCode = 1
      return
    }
    const selector = flags.selector || undefined
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.keyup', {
      key,
      selector,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse keyup failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'eval') {
    const js = rest[0]
    if (!js) {
      console.error('pine browse eval: missing "<js>"')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; result: string } | BrowseErr>('browse.eval', {
      js,
      paneId,
    })
    if (res.ok) {
      console.log(res.result)
    } else {
      console.error(`pine: browse eval failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'wait') {
    const selector = rest[0]
    if (!selector) {
      console.error('pine browse wait: missing <selector>')
      process.exitCode = 1
      return
    }
    const timeoutMs = numberFlag(flags, 'timeout')
    const res = await conn.sendRequest<{ found: boolean; timedOut?: boolean } | BrowseErr>(
      'browse.wait',
      { selector, timeoutMs, paneId },
    )
    if ('found' in res) {
      console.log(JSON.stringify(res))
      if (!res.found) process.exitCode = 1
    } else {
      console.error(`pine: browse wait failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'screenshot') {
    const path = rest[0]
    const res = await conn.sendRequest<{ ok: true; path: string } | BrowseErr>(
      'browse.screenshot',
      { path, paneId },
    )
    if (res.ok) {
      console.log(res.path)
    } else {
      console.error(`pine: browse screenshot failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'content') {
    const res = await conn.sendRequest<{ ok: true; html: string } | BrowseErr>('browse.content', {
      paneId,
    })
    if (res.ok) {
      console.log(res.html)
    } else {
      console.error(`pine: browse content failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'snapshot') {
    const selectorArg = rest[0]
    const selector = selectorArg && !selectorArg.startsWith('--') ? selectorArg : undefined
    const res = await conn.sendRequest<
      { ok: true; snapshot: string; refs: Record<string, unknown> } | BrowseErr
    >('browse.snapshot', { selector, interactive: interactive || undefined, paneId })
    if (res.ok) {
      console.log(res.snapshot)
    } else {
      console.error(`pine: browse snapshot failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'get') {
    const [getSub, selector] = rest
    if (!getSub) {
      console.error('pine browse get: missing <sub>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; value: unknown } | BrowseErr>('browse.get', {
      sub: getSub,
      selector,
      attr: flags.attr || undefined,
      property: flags.property || undefined,
      paneId,
    })
    if (res.ok) {
      console.log(typeof res.value === 'string' ? res.value : JSON.stringify(res.value))
    } else {
      console.error(`pine: browse get failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'is') {
    const [isSub, selector] = rest
    if (!isSub || !selector) {
      console.error('pine browse is: missing <sub> <selector>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; value: boolean } | BrowseErr>('browse.is', {
      sub: isSub,
      selector,
      paneId,
    })
    if (res.ok) {
      console.log(String(res.value))
      if (!res.value) process.exitCode = 1
    } else {
      console.error(`pine: browse is failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'find') {
    const [by, query] = rest
    if (!by || query === undefined) {
      console.error('pine browse find: missing <by> <query>')
      process.exitCode = 1
      return
    }
    const index = numberFlag(flags, 'index')
    const res = await conn.sendRequest<{ ok: true; element_ref: string } | BrowseErr>(
      'browse.find',
      {
        by,
        query,
        exact: exact || undefined,
        index,
        selector: flags.selector || undefined,
        paneId,
      },
    )
    if (res.ok) {
      console.log(res.element_ref)
    } else {
      console.error(`pine: browse find failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'highlight') {
    const selector = rest[0]
    if (!selector) {
      console.error('pine browse highlight: missing <selector>')
      process.exitCode = 1
      return
    }
    const ms = numberFlag(flags, 'ms')
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.highlight', {
      selector,
      ms,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse highlight failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'url') {
    const res = await conn.sendRequest<{ ok: true; url: string } | BrowseErr>('browse.url', {
      paneId,
    })
    if (res.ok) {
      console.log(res.url)
    } else {
      console.error(`pine: browse url failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'zoom') {
    const action = rest[0]
    if (action !== 'in' && action !== 'out' && action !== 'reset') {
      console.error('pine browse zoom: missing <in|out|reset>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; zoom: number } | BrowseErr>('browse.zoom', {
      action,
      paneId,
    })
    if (res.ok) {
      console.log(String(res.zoom))
    } else {
      console.error(`pine: browse zoom failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'devtools') {
    const action = rest[0]
    if (action !== undefined && !['toggle', 'open', 'close', 'console'].includes(action)) {
      console.error('pine browse devtools: expected [toggle|open|close|console]')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; open: boolean; note?: string } | BrowseErr>(
      'browse.devtools',
      { action, paneId },
    )
    if (res.ok) {
      console.log(JSON.stringify(res))
    } else {
      console.error(`pine: browse devtools failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'focus-webview') {
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.focusWebview', { paneId })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse focus-webview failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'is-webview-focused') {
    const res = await conn.sendRequest<{ ok: true; focused: boolean } | BrowseErr>(
      'browse.isWebviewFocused',
      { paneId },
    )
    if (res.ok) {
      console.log(String(res.focused))
      if (!res.focused) process.exitCode = 1
    } else {
      console.error(`pine: browse is-webview-focused failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'identify') {
    const res = await conn.sendRequest<
      | {
          ok: true
          paneId?: string
          url: string
          title: string
          workspaceId: string
          windowId: string
        }
      | BrowseErr
    >('browse.identify', { paneId })
    if (res.ok) {
      console.log(JSON.stringify(res))
    } else {
      console.error(`pine: browse identify failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'cookies') {
    const [cookieSub, name, value] = rest
    if (cookieSub !== 'get' && cookieSub !== 'set' && cookieSub !== 'clear') {
      console.error('pine browse cookies: missing <get|set|clear>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; cookies?: unknown[] } | BrowseErr>(
      'browse.cookies',
      {
        sub: cookieSub,
        name,
        value,
        url: flags.url || undefined,
        domain: flags.domain || undefined,
        paneId,
      },
    )
    if (res.ok) {
      console.log(cookieSub === 'get' ? JSON.stringify(res.cookies) : 'ok')
    } else {
      console.error(`pine: browse cookies failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'storage') {
    const [area, storageSub, key, value] = rest
    if (area !== 'local' && area !== 'session') {
      console.error('pine browse storage: missing <local|session>')
      process.exitCode = 1
      return
    }
    if (storageSub !== 'get' && storageSub !== 'set' && storageSub !== 'clear') {
      console.error('pine browse storage: missing <get|set|clear>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; value?: unknown } | BrowseErr>(
      'browse.storage',
      { area, sub: storageSub, key, value, paneId },
    )
    if (res.ok) {
      console.log(storageSub === 'get' ? JSON.stringify(res.value) : 'ok')
    } else {
      console.error(`pine: browse storage failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'state') {
    const [stateSub, path] = rest
    if (stateSub !== 'save' && stateSub !== 'load') {
      console.error('pine browse state: missing <save|load>')
      process.exitCode = 1
      return
    }
    if (!path) {
      console.error('pine browse state: missing <path>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; path: string } | BrowseErr>('browse.state', {
      sub: stateSub,
      path,
      paneId,
    })
    if (res.ok) {
      console.log(res.path)
    } else {
      console.error(`pine: browse state failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'history') {
    const historySub = rest[0]
    if (historySub !== 'clear') {
      console.error('pine browse history: missing <clear>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.history', {
      sub: historySub,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse history failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'addscript') {
    const js = rest[0]
    if (!js) {
      console.error('pine browse addscript: missing "<js>"')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; result: string } | BrowseErr>(
      'browse.addscript',
      { js, paneId },
    )
    if (res.ok) {
      console.log(res.result)
    } else {
      console.error(`pine: browse addscript failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'addstyle') {
    const css = rest[0]
    if (!css) {
      console.error('pine browse addstyle: missing "<css>"')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; key: string } | BrowseErr>('browse.addstyle', {
      css,
      paneId,
    })
    if (res.ok) {
      console.log(res.key)
    } else {
      console.error(`pine: browse addstyle failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'addinitscript') {
    const js = rest[0]
    if (!js) {
      console.error('pine browse addinitscript: missing "<js>"')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; identifier: string } | BrowseErr>(
      'browse.addinitscript',
      { js, paneId },
    )
    if (res.ok) {
      console.log(res.identifier)
    } else {
      console.error(`pine: browse addinitscript failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'console') {
    await runBrowseBufferSub(conn, 'browse.console', 'console', rest[0], paneId)
  } else if (sub === 'errors') {
    await runBrowseBufferSub(conn, 'browse.errors', 'errors', rest[0], paneId)
  } else if (sub === 'frame') {
    const selector = rest[0]
    if (!selector) {
      console.error('pine browse frame: missing <selector|main>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.frame', { selector, paneId })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse frame failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'download') {
    const downloadSub = rest[0]
    if (downloadSub !== 'wait') {
      console.error('pine browse download: missing <wait>')
      process.exitCode = 1
      return
    }
    const timeoutMs = numberFlag(flags, 'timeout')
    const res = await conn.sendRequest<
      { path: string; filename: string; state: string } | { timedOut: true } | BrowseErr
    >('browse.download', {
      sub: downloadSub,
      path: flags.path || undefined,
      timeoutMs,
      paneId,
    })
    if ('timedOut' in res) {
      console.log(JSON.stringify(res))
      process.exitCode = 1
    } else if ('path' in res) {
      console.log(JSON.stringify(res))
    } else {
      console.error(`pine: browse download failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'navigate') {
    const url = rest[0]
    if (!url) {
      console.error('pine browse navigate: missing <url>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.navigate', { url, paneId })
    if (res.ok) {
      console.log(JSON.stringify(res))
    } else {
      console.error(`pine: browse navigate failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'open-split') {
    const url = rest[0]
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.openSplit', { url, paneId })
    if (res.ok) {
      console.log(JSON.stringify(res))
    } else {
      console.error(`pine: browse open-split failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'tab') {
    const [tabSub, arg] = rest
    if (tabSub !== 'new' && tabSub !== 'list' && tabSub !== 'switch' && tabSub !== 'close') {
      console.error('pine browse tab: missing <new|list|switch|close>')
      process.exitCode = 1
      return
    }
    if ((tabSub === 'switch' || tabSub === 'close') && !arg) {
      console.error(`pine browse tab ${tabSub}: missing <target>`)
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<
      | { ok: true; created?: boolean }
      | { ok: true; tabs: { paneId: string; url: string; title: string }[] }
      | BrowseErr
    >('browse.tab', {
      sub: tabSub,
      url: tabSub === 'new' ? arg : undefined,
      target: tabSub === 'switch' || tabSub === 'close' ? arg : undefined,
      paneId,
    })
    if (!res.ok) {
      console.error(`pine: browse tab failed (${describeBrowseError(res)})`)
      process.exitCode = 1
      return
    }
    console.log('tabs' in res ? JSON.stringify(res.tabs) : 'ok')
  } else if (sub === 'dialog') {
    const [dialogSub, text] = rest
    if (dialogSub !== 'accept' && dialogSub !== 'dismiss' && dialogSub !== 'list') {
      console.error('pine browse dialog: missing <accept|dismiss|list>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; dialogs?: BrowseDialogEntry[] } | BrowseErr>(
      'browse.dialog',
      { sub: dialogSub, text, paneId },
    )
    if (!res.ok) {
      console.error(`pine: browse dialog failed (${describeBrowseError(res)})`)
      process.exitCode = 1
      return
    }
    console.log(dialogSub === 'list' ? JSON.stringify(res.dialogs ?? []) : 'ok')
  } else if (sub === 'focus-mode') {
    const action = rest[0]
    if (action !== 'enter' && action !== 'exit' && action !== 'toggle') {
      console.error('pine browse focus-mode: missing <enter|exit|toggle>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BrowseOk | BrowseErr>('browse.focusMode', {
      action,
      paneId,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: browse focus-mode failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'react-grab') {
    const action = rest[0]
    if (action !== 'toggle' && action !== 'get') {
      console.error('pine browse react-grab: missing <toggle|get>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: true; on?: boolean; entry?: unknown } | BrowseErr>(
      'browse.reactGrab',
      { action, paneId },
    )
    if (!res.ok) {
      console.error(`pine: browse react-grab failed (${describeBrowseError(res)})`)
      process.exitCode = 1
      return
    }
    console.log(action === 'get' ? JSON.stringify(res.entry ?? null) : JSON.stringify(res))
  } else if (sub === 'pick') {
    const timeoutMs = numberFlag(flags, 'timeout')
    const res = await conn.sendRequest<{ ok: true; capture: unknown } | BrowseErr>('browse.pick', {
      paneId,
      timeoutMs,
    })
    if (res.ok) {
      console.log(JSON.stringify(res.capture, null, 2))
    } else {
      console.error(`pine: browse pick failed (${describeBrowseError(res)})`)
      process.exitCode = 1
    }
  } else {
    console.error(
      `pine browse: unknown subcommand '${sub ?? ''}' (try: open, nav, read, click, type, dblclick, hover, focus, check, uncheck, scroll-into-view, fill, select, scroll, press, keydown, keyup, eval, wait, screenshot, content, snapshot, get, is, find, highlight, url, zoom, devtools, focus-webview, is-webview-focused, identify, cookies, storage, state, history, addscript, addstyle, addinitscript, console, errors, frame, download, navigate, open-split, tab, dialog, focus-mode, react-grab, pick)`,
    )
    process.exitCode = 1
  }
}

const STATE_VERBS = ['waiting', 'done', 'working', 'error', 'clear']

function messageFromStdin(raw: string): string {
  const text = raw.trim()
  if (!text.startsWith('{')) return text
  try {
    const parsed = JSON.parse(text) as { message?: unknown }
    return typeof parsed.message === 'string' ? parsed.message : ''
  } catch {
    return text
  }
}

async function runStateVerb(conn: MessageConnection): Promise<void> {
  const args = process.argv.slice(3)
  let paneId: string | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pane') paneId = args[++i]
    else positional.push(args[i])
  }
  const [state, rawMessage] = positional
  if (!state || !STATE_VERBS.includes(state)) {
    console.error(`pine state: expected one of ${STATE_VERBS.join('|')}`)
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
    console.error(`pine state: ${res.error ?? 'failed'}${res.message ? ` (${res.message})` : ''}`)
    process.exitCode = 1
  }
}

async function runResumeTokenVerb(conn: MessageConnection): Promise<void> {
  const [agent, raw] = process.argv.slice(3)
  if (!isResumableAgent(agent) || !raw) {
    console.error(`pine resume-token: usage: resume-token <${RESUMABLE_AGENTS.join('|')}> <id|->`)
    process.exitCode = 1
    return
  }
  const id = resumeIdFromHookPayload(raw === '-' ? await readAllStdin() : raw)
  if (!id) {
    console.error('pine resume-token: no agent session id found')
    process.exitCode = 1
    return
  }
  const res = await conn.sendRequest<{ ok: boolean; error?: string }>('pane.setResume', {
    agent,
    id,
  })
  if (res.ok) {
    console.log('ok')
  } else {
    console.error(`pine resume-token: ${res.error ?? 'failed'}`)
    process.exitCode = 1
  }
}

const USAGE = `usage: pine <command> [args]

commands:
  whoami | commands | info | cwd | pane.list | workspace.list | docs
  notify <title> [body]
  state <waiting|done|working|error|clear> [message|-] [--pane <externalId>]
  resume-token <claude|codex> <id|->  remember how to resume this pane's agent after a restart
  open <path>
  process | vault | bus | settings | browse | gateway <subcommand> ...
  ext ls | ext <extId> <command> [args...]
  <extId> <command> [args...]  an extension command, e.g. pine git status, pine trellis status
  <command.id> [json-args]     run any registered command (see: pine commands)

run 'pine docs' inside a Pine pane for the full reference.`

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
  const socketPath = process.env.PINE_SOCKET
  const token = process.env.PINE_TOKEN
  const [cmd] = process.argv.slice(2)
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE)
    return
  }
  if (!socketPath) {
    console.error('pine: not inside a Pine pane (PINE_SOCKET unset)')
    process.exit(1)
  }
  let socket: Socket
  try {
    socket = await connectSocket(socketPath)
  } catch {
    console.error(`pine: app not reachable at ${socketPath}`)
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
        console.error(`pine notify: ${res.error ?? 'failed'}`)
        process.exitCode = 1
      }
    } else if (cmd === 'state') {
      await runStateVerb(conn)
    } else if (cmd === 'resume-token') {
      await runResumeTokenVerb(conn)
    } else if (cmd === 'open') {
      const arg = process.argv[3]
      if (!arg) {
        console.error('pine open: missing <path>')
        process.exitCode = 1
        return
      }
      const res = await conn.sendRequest<CommandResult>('command.exec', {
        id: 'editor.open',
        args: { path: resolvePath(process.cwd(), arg) },
      })
      if (res.ok) {
        console.log('ok')
      } else {
        console.error('pine:', res.error?.message)
        process.exitCode = 1
      }
    } else if (cmd === 'docs') {
      const res = await conn.sendRequest<{ cli: string }>('docs')
      console.log(res.cli)
    } else if (cmd === 'process') {
      await runProcessVerb(conn)
    } else if (cmd === 'vault') {
      await runVaultVerb(conn)
    } else if (cmd === 'ext') {
      if (process.argv[3] === 'ls') await runExtList(conn)
      else await runExtCommand(conn, process.argv[3], process.argv[4], process.argv.slice(5))
    } else if (cmd && !cmd.includes('.') && !CORE_VERBS.has(cmd)) {
      await runExtCommand(conn, cmd, process.argv[3], process.argv.slice(4))
    } else if (cmd === 'bus') {
      await runBusVerb(conn)
    } else if (cmd === 'settings') {
      await runSettingsVerb(conn)
    } else if (cmd === 'browse') {
      await runBrowseVerb(conn)
    } else if (cmd === 'gateway') {
      await runGatewayVerb(conn)
    } else if (cmd) {
      const raw = process.argv[3]
      const args = raw ? JSON.parse(raw) : undefined
      const res = await conn.sendRequest<CommandResult>('command.exec', { id: cmd, args })
      if (res.ok) {
        console.log('ok')
        if (res.result !== undefined) console.log(JSON.stringify(res.result))
      } else {
        console.error('pine:', res.error?.message)
        process.exitCode = 1
      }
    } else {
      console.error(
        `pine: unknown command '${cmd ?? ''}' (try: whoami, commands, info, cwd, pane.list, workspace.list, notify, state, open, docs, process, vault, bus, settings, browse, gateway, ext)`,
      )
      process.exitCode = 1
    }
  } catch (e) {
    if (connectionLost) {
      console.error('pine: connection to the app closed (did Pine quit?)')
    } else {
      console.error('pine:', e instanceof Error ? e.message : String(e))
    }
    process.exitCode = 1
  } finally {
    done = true
    conn.dispose()
    socket.destroy()
  }
}
void main()
