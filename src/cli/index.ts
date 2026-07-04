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
    const mine = rawArgs.includes('--mine')
    const res = await conn.sendRequest<BusHandoffsResult | BusErr>('bus.handoffs', { mine })
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
        `pine: unknown command '${cmd ?? ''}' (try: whoami, commands, info, cwd, notify, open, docs, process, vault, wiki, kanban, bus)`,
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
