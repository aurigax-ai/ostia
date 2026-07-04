#!/usr/bin/env node
/**
 * `pine` CLI (Slice 5, spec §6). A standalone Node script — NOT bundled into the Electron
 * app — that dials the running app instance's control socket (`PINE_SOCKET`, `PINE_TOKEN`,
 * both injected into every pty's env by `pty:attach` in `src/main/index.ts`) and speaks the
 * same `vscode-jsonrpc` framing as `controlServer.ts`. Built separately via esbuild
 * (`npm run build:cli`) since it must run under plain `node`, not Electron's main process.
 */
import { createConnection } from 'node:net'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
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

/** Pulls a bare `--global` boolean flag out of a raw argv slice; everything else is positional. */
function extractGlobalFlag(argv: string[]): { global: boolean; rest: string[] } {
  const rest: string[] = []
  let global = false
  for (const arg of argv) {
    if (arg === '--global') global = true
    else rest.push(arg)
  }
  return { global, rest }
}

/**
 * Read a secret value from stdin — never from argv, so it never lands in shell history,
 * `ps`, or a terminal echo. Piped input (`echo -n secret | pine vault set KEY`) is read to
 * EOF as-is. An interactive TTY gets a stderr prompt and a raw-mode line read so keystrokes
 * aren't echoed back (same no-echo posture as a password prompt).
 */
async function readSecretFromStdin(promptLabel: string): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write(`${promptLabel} (input hidden): `)
    return await readLineNoEcho()
  }
  return await readAllStdin()
}

/** Reads piped stdin to EOF, stripping one trailing newline (as `echo`/most shells add). */
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

/**
 * Reads one line from a TTY in raw mode (no local echo, no canonical line buffering).
 *
 * Raw mode is process-global terminal state, so leaving it on past this call would leave
 * the user's shell with a silently-broken prompt (no echo, no line editing) -- worse than
 * the secret prompt itself. Every exit path (line entered, Ctrl+C, stdin error/close/end,
 * or an external SIGINT) funnels through the single idempotent `finish` below, which
 * restores echo and tears down every listener exactly once, however this settles.
 */
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
        if (ch === '\u0003') {
          // Ctrl+C — bail out without printing whatever was typed so far.
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

/** `pine vault <set|get|ls|rm>` — the encrypted-secret-store verb group (no-echo by design). */
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

interface WikiOk {
  ok: true
}
interface WikiErr {
  ok: false
  error: string
  message?: string
}
interface WikiGetResult {
  slug: string
  title: string
  body: string
  updatedAt: string
}
interface WikiListResult {
  pages: { slug: string; title: string; updatedAt: string }[]
}
interface WikiSearchResult {
  matches: { slug: string; title: string; snippet: string }[]
}

function describeWikiError(res: WikiErr): string {
  return res.message ? `${res.error}: ${res.message}` : res.error
}

/** `pine wiki <get|set|ls|search|rm>` — the project/global wiki verb group. */
async function runWikiVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const { global, rest } = extractGlobalFlag(process.argv.slice(4))
  const scope: 'project' | 'global' = global ? 'global' : 'project'

  if (sub === 'get') {
    const slug = rest[0]
    if (!slug) {
      console.error('pine wiki get: missing <slug>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<WikiGetResult | WikiErr>('wiki.get', { slug, scope })
    if ('body' in res) {
      console.log(res.body)
    } else {
      console.error(`pine: wiki get failed (${describeWikiError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'set') {
    const slug = rest[0]
    if (!slug) {
      console.error('pine wiki set: missing <slug>')
      process.exitCode = 1
      return
    }
    const body = await readAllStdin()
    const res = await conn.sendRequest<WikiOk | WikiErr>('wiki.set', { slug, body, scope })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: wiki set failed (${describeWikiError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'ls') {
    const res = await conn.sendRequest<WikiListResult | WikiErr>('wiki.list', { scope })
    if ('pages' in res) {
      for (const p of res.pages) console.log(`${p.slug}\t${p.title}\t${p.updatedAt}`)
    } else {
      console.error(`pine: wiki ls failed (${describeWikiError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'search') {
    const q = rest[0]
    if (!q) {
      console.error('pine wiki search: missing <q>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<WikiSearchResult | WikiErr>('wiki.search', { q, scope })
    if ('matches' in res) {
      for (const m of res.matches) console.log(`${m.slug}\t${m.title}\t${m.snippet}`)
    } else {
      console.error(`pine: wiki search failed (${describeWikiError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'rm') {
    const slug = rest[0]
    if (!slug) {
      console.error('pine wiki rm: missing <slug>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<WikiOk | WikiErr>('wiki.delete', { slug, scope })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: wiki rm failed (${describeWikiError(res)})`)
      process.exitCode = 1
    }
  } else {
    console.error(`pine wiki: unknown subcommand '${sub ?? ''}' (try: get, set, ls, search, rm)`)
    process.exitCode = 1
  }
}

interface KanbanCard {
  id: string
  title: string
  column: string
  assignee?: string
  body?: string
  createdAt: string
  updatedAt: string
}
interface KanbanBoard {
  columns: { id: string; name: string }[]
  cards: KanbanCard[]
}
interface KanbanOk {
  ok: true
}
interface KanbanErr {
  ok: false
  error: string
  message?: string
}

function describeKanbanError(res: KanbanErr): string {
  return res.message ? `${res.error}: ${res.message}` : res.error
}

/** `pine kanban <ls|add|move|assign|done|rm>` — the project kanban board verb group. */
async function runKanbanVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const rawArgs = process.argv.slice(4)

  if (sub === 'ls') {
    const res = await conn.sendRequest<KanbanBoard | KanbanErr>('kanban.get', {})
    if ('columns' in res) {
      for (const col of res.columns) {
        const cards = res.cards.filter((c) => c.column === col.id)
        console.log(`# ${col.name} (${col.id})`)
        if (cards.length === 0) console.log('  (empty)')
        for (const c of cards) {
          console.log(`  ${c.id}\t${c.title}${c.assignee ? ` @${c.assignee}` : ''}`)
        }
      }
    } else {
      console.error(`pine: kanban ls failed (${describeKanbanError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'add') {
    const { flags, rest } = parseFlags(rawArgs, ['column', 'body'])
    const title = rest[0]
    if (!title) {
      console.error('pine kanban add: missing "<title>"')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ card: KanbanCard } | KanbanErr>('kanban.add', {
      title,
      column: flags.column || undefined,
      body: flags.body || undefined,
    })
    if ('card' in res) {
      console.log(JSON.stringify(res.card))
    } else {
      console.error(`pine: kanban add failed (${describeKanbanError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'move') {
    const [cardId, column] = rawArgs
    if (!cardId || !column) {
      console.error('pine kanban move: missing <id> <column>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<KanbanOk | KanbanErr>('kanban.move', { cardId, column })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: kanban move failed (${describeKanbanError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'assign') {
    const [cardId, assignee] = rawArgs
    if (!cardId || !assignee) {
      console.error('pine kanban assign: missing <id> <who>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<KanbanOk | KanbanErr>('kanban.assign', {
      cardId,
      assignee,
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: kanban assign failed (${describeKanbanError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'done') {
    const cardId = rawArgs[0]
    if (!cardId) {
      console.error('pine kanban done: missing <id>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<KanbanOk | KanbanErr>('kanban.move', {
      cardId,
      column: 'done',
    })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: kanban done failed (${describeKanbanError(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'rm') {
    const cardId = rawArgs[0]
    if (!cardId) {
      console.error('pine kanban rm: missing <id>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<KanbanOk | KanbanErr>('kanban.remove', { cardId })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`pine: kanban rm failed (${describeKanbanError(res)})`)
      process.exitCode = 1
    }
  } else {
    console.error(
      `pine kanban: unknown subcommand '${sub ?? ''}' (try: ls, add, move, assign, done, rm)`,
    )
    process.exitCode = 1
  }
}

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

/** `pine bus <send|inbox|wait|handoff|claim|handoffs|done>` — the cross-agent mailbox group. */
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
    const timeoutMs = flags.timeout ? Number(flags.timeout) : undefined
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

/**
 * `pine gateway <enable|pair|status|devices|revoke|disable>` — the LAN control-gateway verb
 * group (elevated `gateway` capability; see `src/main/gateway/`). LAN/Tailscale-only, off by
 * default: nothing here does anything until `enable` (or `pair`, which enables implicitly —
 * see `src/main/gateway/index.ts`) is run at least once.
 *
 * `pair` can't render an actual QR here (no QR-encoding dependency was pulled in for it) — it
 * prints the pairing JSON payload (scan-ready if you pipe it through your own QR tool) plus a
 * copyable `pine-pair://` URI wrapping the same payload, base64url-encoded.
 */
async function runGatewayVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const { flags, rest } = parseFlags(process.argv.slice(4), ['host', 'port'])

  if (sub === 'enable') {
    const res = await conn.sendRequest<GatewayStartResult>('gateway.enable', {
      host: flags.host || undefined,
      port: flags.port ? Number(flags.port) : undefined,
    })
    console.log(JSON.stringify(res))
  } else if (sub === 'disable') {
    const res = await conn.sendRequest<GatewayOk>('gateway.disable', {})
    console.log(res.ok ? 'ok' : 'pine: gateway disable failed')
  } else if (sub === 'pair') {
    const res = await conn.sendRequest<GatewayPairResult>('gateway.pair', {})
    console.log(JSON.stringify(res, null, 2))
    console.log(`\npine-pair://${Buffer.from(JSON.stringify(res)).toString('base64url')}`)
    console.log('\n(scan the JSON above as a QR from the phone, or paste the pine-pair:// URI)')
  } else if (sub === 'status') {
    const res = await conn.sendRequest<GatewayStatusResult>('gateway.status', {})
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

/** Pulls known `--flag value` pairs out of a raw argv slice; everything else is positional. */
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

/** `pine process <run|ls|logs|kill|restart>` — the process-manager verb group. */
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
    const res = await conn.sendRequest<{ id: string; name: string; pid?: number }>('process.run', {
      cmd,
      name: flags.name,
      cwd: flags.cwd,
    })
    console.log(JSON.stringify(res))
  } else if (sub === 'ls') {
    const list = await conn.sendRequest<ProcInfo[]>('process.list')
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
    const sinceCursor = flags.since ? Number(flags.since) : undefined
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

/**
 * `pine settings <get|set>` — bridges to the renderer's `settingsStore` via the
 * `settings.get`/`settings.set` commands (routed through `command.exec`, same as
 * `pine open`), so the running app's Settings UI reflects the change live.
 */
async function runSettingsVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]

  if (sub === 'get') {
    const key = process.argv[4]
    const res = await conn.sendRequest<CommandResult>('command.exec', {
      id: 'settings.get',
      args: key ? { key } : undefined,
    })
    if (res.ok) {
      // `result` comes back `undefined` (dropped over the wire) for an absent dot-path —
      // normalize to `null` so this always prints valid JSON, never the bare word `undefined`.
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

/** Shared CLI plumbing for `console`/`errors` — identical request/response shape
 *  (`{sub:'list'|'clear', paneId}` → `{ok:true, entries}` on list, `{ok:true}` on clear),
 *  differing only in the RPC method name and which label to print on a bad `sub`. */
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

/**
 * `pine browse <open|nav|read|click|type|dblclick|hover|focus|check|uncheck|scroll-into-view|
 * fill|select|scroll|press|keydown|keyup|eval|wait|screenshot|content|snapshot|get|is|find|
 * highlight|url|zoom|devtools|focus-webview|is-webview-focused|identify|cookies|storage|state|
 * history|addscript|addstyle|addinitscript|console|errors|frame|download|navigate|open-split>`
 * — agent automation of the in-app `browser` pane's guest page (elevated `browse` capability;
 * see `src/main/browse.ts`). `--pane <externalId>` targets a specific browser pane (another
 * pane's `pine whoami` id, relayed the same way as the "no pane roster yet" coordination recipe
 * in the `pine` skill); omitted, it defaults to the caller's own session's browser pane.
 *
 * `snapshot`/`find` assign `eN` refs to elements (valid until the next navigation); anywhere
 * else a `<selector>` is accepted, `@eN` or `eN` works too (`browse.ts`'s injected
 * `window.__pine.resolveEl`) — so a typical flow is `pine browse snapshot` to see refs, then
 * `pine browse click @e3`.
 *
 * `cookies`/`storage`/`state` act on this pane's OWN cookie/storage jar — every browser pane
 * has an isolated `partition` (`BrowserView.tsx`), never shared across panes. `state`'s `<path>`
 * is allow-listed the same way `screenshot`'s is; so is `download wait`'s `--path`.
 *
 * `console`/`errors` read/clear this surface's buffered `console-message`s (capped ~500);
 * `errors` is the error-level / uncaught-exception subset (an injected catcher reports
 * `window.onerror`/`onunhandledrejection` into it too). `frame <selector|main>` points
 * subsequent selector-driven verbs at an iframe's document (`main`/`top` resets to the page).
 * `navigate` is `open` without the auto-create fallback (fails if no surface exists yet);
 * `open-split` is the inverse — always creates a new browser pane (a split), never reuses one.
 */
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
    const x = flags.x ? Number(flags.x) : undefined
    const y = flags.y ? Number(flags.y) : undefined
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
    const timeoutMs = flags.timeout ? Number(flags.timeout) : undefined
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
    // `[selector]` is optional, so a bare `--interactive` (no selector) must not be mistaken
    // for one — `rest[0]` here is a flag token, not a positional, when the selector is omitted.
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
    const index = flags.index ? Number(flags.index) : undefined
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
    const ms = flags.ms ? Number(flags.ms) : undefined
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
          sessionId: string
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
    const timeoutMs = flags.timeout ? Number(flags.timeout) : undefined
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
  } else {
    console.error(
      `pine browse: unknown subcommand '${sub ?? ''}' (try: open, nav, read, click, type, dblclick, hover, focus, check, uncheck, scroll-into-view, fill, select, scroll, press, keydown, keyup, eval, wait, screenshot, content, snapshot, get, is, find, highlight, url, zoom, devtools, focus-webview, is-webview-focused, identify, cookies, storage, state, history, addscript, addstyle, addinitscript, console, errors, frame, download, navigate, open-split)`,
    )
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  const socketPath = process.env.PINE_SOCKET
  const token = process.env.PINE_TOKEN
  const [cmd] = process.argv.slice(2)
  if (!socketPath) {
    console.error('pine: not inside a Pine pane (PINE_SOCKET unset)')
    process.exit(1)
  }
  const socket = createConnection(socketPath)
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
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
    } else if (cmd === 'notify') {
      const title = process.argv[3]
      const body = process.argv[4]
      await conn.sendRequest('notify', { title, body })
      console.log('ok')
    } else if (cmd === 'open') {
      const path = process.argv[3]
      const res = await conn.sendRequest<CommandResult>('command.exec', {
        id: 'editor.open',
        args: { path },
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
    } else if (cmd === 'wiki') {
      await runWikiVerb(conn)
    } else if (cmd === 'kanban') {
      await runKanbanVerb(conn)
    } else if (cmd === 'bus') {
      await runBusVerb(conn)
    } else if (cmd === 'settings') {
      await runSettingsVerb(conn)
    } else if (cmd === 'browse') {
      await runBrowseVerb(conn)
    } else if (cmd === 'gateway') {
      await runGatewayVerb(conn)
    } else if (cmd) {
      // Any other verb is treated as a command id, with an optional JSON args blob
      // as the 2nd argv (e.g. `pine pane.splitRight` or `pine pane.write '"ls\n"'`).
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
        `pine: unknown command '${cmd ?? ''}' (try: whoami, commands, info, cwd, notify, open, docs, process, vault, wiki, kanban, bus, settings, browse, gateway)`,
      )
      process.exitCode = 1
    }
  } catch (e) {
    console.error('pine:', e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  } finally {
    conn.dispose()
    socket.destroy()
  }
}
void main()
