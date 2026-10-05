import type { MessageConnection } from 'vscode-jsonrpc/node'
import { type BrowseCall, extractGlobals, parseBrowseCommand, splitCommandLine } from './browseArgs'
import { failureHint } from './failure'

export interface BrowseResponse {
  success: boolean
  data: Record<string, unknown> | null
  error: string | null
  hint?: string
}

type RawResult = Record<string, unknown> & { ok?: unknown; error?: unknown; message?: unknown }

export function toResponse(raw: unknown): BrowseResponse {
  const result = (raw && typeof raw === 'object' ? raw : {}) as RawResult
  if (result.ok === false) {
    const detail = typeof result.message === 'string' ? `: ${result.message}` : ''
    return { success: false, data: null, error: `${String(result.error ?? 'failed')}${detail}` }
  }
  const { ok: _ok, ...data } = result
  return { success: true, data: Object.keys(data).length > 0 ? data : null, error: null }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value, null, 2)
}

interface ConsoleLine {
  level: string
  text: string
}

interface TabLine {
  tabId: string
  title?: string
  url?: string
  profile?: 'shared'
  active: boolean
}

export const SHARED_TAB_TEXT = "[the human's browser profile: driving it asks them each time]"

function tabText(t: TabLine): string {
  const rest = t.profile === 'shared' ? SHARED_TAB_TEXT : `${t.title}\t${t.url}`
  return `${t.active ? '*' : ' '} ${t.tabId}\t${rest}`
}

interface RequestLine {
  requestId: string
  method: string
  status?: number
  type: string
  url: string
  error?: string
}

export function formatText(verb: string, data: Record<string, unknown> | null): string {
  if (!data) return 'ok'
  switch (verb) {
    case 'snapshot':
      return asText(data.snapshot)
    case 'read':
      return asText(data.text)
    case 'open':
      return asText(data.url ?? 'ok')
    case 'get':
    case 'zoom':
      return asText(data.value ?? data.zoom)
    case 'is':
      return String(data.value)
    case 'is-webview-focused':
      return String(data.focused)
    case 'eval':
      return asText(data.result)
    case 'find':
      return data.value !== undefined ? asText(data.value) : asText(data.ref)
    case 'screenshot':
    case 'pdf':
    case 'state':
      return asText(data.path)
    case 'wait':
      return data.path !== undefined ? asText(data.path) : 'ok'
    case 'cookies':
      return data.cookies !== undefined ? asText(data.cookies) : 'ok'
    case 'storage':
      if (data.values !== undefined) return asText(data.values)
      return data.value === null ? '' : asText(data.value)
    case 'addinitscript':
      return asText(data.identifier)
    case 'addstyle':
      return asText(data.key)
    case 'console':
    case 'errors': {
      const entries = (data.entries as ConsoleLine[] | undefined) ?? []
      return entries.map((e) => `[${e.level}] ${e.text}`).join('\n')
    }
    case 'tab': {
      const tabs = data.tabs as TabLine[] | undefined
      if (!tabs) return data.tabId !== undefined ? asText(data.tabId) : 'ok'
      return tabs.map(tabText).join('\n')
    }
    case 'network': {
      const requests = data.requests as RequestLine[] | undefined
      if (requests) {
        return requests
          .map(
            (r) =>
              `${r.requestId}\t${r.method}\t${r.status ?? r.error ?? 'pending'}\t${r.type}\t${r.url}`,
          )
          .join('\n')
      }
      if (data.request) return asText(data.request)
      return data.routes !== undefined ? asText(data.routes) : 'ok'
    }
    case 'pick':
      return asText(data.capture)
    default:
      return Object.keys(data).length > 0 ? asText(data) : 'ok'
  }
}

async function readStdin(): Promise<string> {
  let data = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) data += chunk
  return data
}

export async function executeCall(
  conn: MessageConnection,
  call: BrowseCall,
  paneId: string | undefined,
): Promise<BrowseResponse> {
  const params: Record<string, unknown> = { ...call.params }
  if (call.readsStdin) params.js = await readStdin()
  if (paneId) params.paneId = paneId
  try {
    return toResponse(await conn.sendRequest(call.method, params))
  } catch (e) {
    const hint = failureHint(e)
    return {
      success: false,
      data: null,
      error: e instanceof Error ? e.message : String(e),
      ...(hint ? { hint } : {}),
    }
  }
}

function report(verb: string, res: BrowseResponse, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(res))
    return
  }
  if (res.success) console.log(formatText(verb, res.data))
  else console.error(`ostia browse ${verb}: ${res.error}${res.hint ? `. ${res.hint}` : ''}`)
}

async function batchCommands(args: string[]): Promise<string[][] | string> {
  if (args.length > 0) return args.map(splitCommandLine)
  try {
    const parsed = JSON.parse(await readStdin()) as unknown
    if (!Array.isArray(parsed) || !parsed.every((c) => Array.isArray(c))) {
      return 'batch expects a JSON array of argument arrays on stdin'
    }
    return parsed.map((c: unknown[]) => c.map(String))
  } catch {
    return 'batch expects a JSON array of argument arrays on stdin'
  }
}

async function runOne(
  conn: MessageConnection,
  argv: string[],
  paneId: string | undefined,
): Promise<{ verb: string; res: BrowseResponse }> {
  const globals = extractGlobals(argv)
  if (typeof globals === 'string') {
    return { verb: argv[0] ?? 'batch', res: { success: false, data: null, error: globals } }
  }
  const parsed = parseBrowseCommand(globals.argv, process.cwd())
  if (!parsed.ok) {
    return { verb: argv[0] ?? 'batch', res: { success: false, data: null, error: parsed.error } }
  }
  return {
    verb: parsed.call.verb,
    res: await executeCall(conn, parsed.call, globals.paneId ?? paneId),
  }
}

async function runBatch(
  conn: MessageConnection,
  args: string[],
  json: boolean,
  paneId: string | undefined,
): Promise<boolean> {
  const bail = args.includes('--bail')
  const commands = await batchCommands(args.filter((a) => a !== '--bail'))
  if (typeof commands === 'string') {
    report('batch', { success: false, data: null, error: commands }, json)
    return false
  }
  const results: (BrowseResponse & { command: string[] })[] = []
  let allOk = true
  for (const argv of commands) {
    const { verb, res } = await runOne(conn, argv, paneId)
    if (!json) report(verb, res, false)
    results.push({ command: argv, ...res })
    if (!res.success) {
      allOk = false
      if (bail) break
    }
  }
  if (json) console.log(JSON.stringify(results))
  return allOk
}

export async function runBrowse(conn: MessageConnection, argv: string[]): Promise<void> {
  const globals = extractGlobals(argv)
  if (typeof globals === 'string') {
    console.error(`ostia browse: ${globals}`)
    process.exitCode = 1
    return
  }
  const { json, paneId } = globals
  if (globals.argv[0] === 'batch') {
    if (!(await runBatch(conn, globals.argv.slice(1), json, paneId))) process.exitCode = 1
    return
  }
  const parsed = parseBrowseCommand(globals.argv, process.cwd())
  if (!parsed.ok) {
    report(globals.argv[0] ?? 'browse', { success: false, data: null, error: parsed.error }, json)
    process.exitCode = 1
    return
  }
  const res = await executeCall(conn, parsed.call, paneId)
  report(parsed.call.verb, res, json)
  if (!res.success) process.exitCode = 1
}
