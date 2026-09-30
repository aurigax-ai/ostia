import { resolve as resolvePath } from 'node:path'

export interface BrowseCall {
  verb: string
  method: string
  params: Record<string, unknown>
  readsStdin?: boolean
}

export type BrowseParse = { ok: true; call: BrowseCall } | { ok: false; error: string }

export interface BrowseGlobals {
  json: boolean
  paneId?: string
  argv: string[]
}

interface FlagSpec {
  values?: Record<string, string>
  booleans?: Record<string, string>
}

interface ParsedFlags {
  positional: string[]
  values: Record<string, string>
  booleans: Set<string>
}

const NEGATIVE_NUMBER = /^-\d/

function parseFlags(args: string[], spec: FlagSpec): ParsedFlags | string {
  const positional: string[] = []
  const values: Record<string, string> = {}
  const booleans = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('-') || arg === '-' || NEGATIVE_NUMBER.test(arg)) {
      positional.push(arg)
      continue
    }
    const valueKey = spec.values?.[arg]
    if (valueKey) {
      const value = args[i + 1]
      if (value === undefined) return `${arg} needs a value`
      values[valueKey] = value
      i++
      continue
    }
    const boolKey = spec.booleans?.[arg]
    if (boolKey) {
      booleans.add(boolKey)
      continue
    }
    return `unknown flag ${arg}`
  }
  return { positional, values, booleans }
}

export function extractGlobals(argv: string[]): BrowseGlobals | string {
  const rest: string[] = []
  let json = false
  let paneId: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--pane') {
      paneId = argv[i + 1]
      if (!paneId) return '--pane needs a value'
      i++
    } else rest.push(arg)
  }
  return { json, paneId, argv: rest }
}

export function splitCommandLine(line: string): string[] {
  const words: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) current += line[++i]
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (ch === '\\' && i + 1 < line.length) {
      current += line[++i]
      started = true
    } else if (/\s/.test(ch)) {
      if (started) words.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started) words.push(current)
  return words
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function ok(verb: string, method: string, params: Record<string, unknown> = {}): BrowseParse {
  return { ok: true, call: { verb, method, params } }
}

function usage(text: string): BrowseParse {
  return { ok: false, error: `usage: pine browse ${text}` }
}

type Parser = (args: string[], cwd: string) => BrowseParse

function targetVerb(verb: string, method = verb): Parser {
  return (args) => {
    const flags = parseFlags(args, {})
    if (typeof flags === 'string') return { ok: false, error: flags }
    const [target] = flags.positional
    return target ? ok(verb, `browse.${method}`, { target }) : usage(`${verb} <selector|@ref>`)
  }
}

function plainVerb(verb: string, method = verb): Parser {
  return (args) => (args.length === 0 ? ok(verb, `browse.${method}`) : usage(verb))
}

function keyVerb(verb: string): Parser {
  return (args) => (args[0] ? ok(verb, `browse.${verb}`, { key: args[0] }) : usage(`${verb} <key>`))
}

function textVerb(verb: 'type' | 'fill'): Parser {
  return (args) => {
    const [target, ...text] = args
    if (!target || text.length === 0) return usage(`${verb} <selector|@ref> <text>`)
    return ok(verb, `browse.${verb}`, { target, text: text.join(' ') })
  }
}

function bufferVerb(verb: 'console' | 'errors'): Parser {
  return (args) => {
    const flags = parseFlags(args, { booleans: { '--clear': 'clear' } })
    if (typeof flags === 'string' || flags.positional.length > 0) return usage(`${verb} [--clear]`)
    return ok(verb, `browse.${verb}`, { clear: flags.booleans.has('clear') })
  }
}

const FIND_LOCATORS = ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid']

const parsers: Record<string, Parser> = {
  open: (args) => ok('open', 'browse.open', args[0] ? { url: args[0] } : {}),
  back: plainVerb('back'),
  forward: plainVerb('forward'),
  reload: plainVerb('reload'),
  close: plainVerb('close'),
  read: plainVerb('read'),
  click: (args) => {
    const flags = parseFlags(args, { booleans: { '--new-tab': 'newTab' } })
    if (typeof flags === 'string') return { ok: false, error: flags }
    const [target] = flags.positional
    if (!target) return usage('click <selector|@ref> [--new-tab]')
    return ok('click', 'browse.click', { target, newTab: flags.booleans.has('newTab') })
  },
  dblclick: targetVerb('dblclick'),
  focus: targetVerb('focus'),
  hover: targetVerb('hover'),
  check: targetVerb('check'),
  uncheck: targetVerb('uncheck'),
  scrollintoview: targetVerb('scrollintoview'),
  type: textVerb('type'),
  fill: textVerb('fill'),
  press: keyVerb('press'),
  keydown: keyVerb('keydown'),
  keyup: keyVerb('keyup'),
  keyboard: (args) => {
    const [mode, ...text] = args
    if ((mode !== 'type' && mode !== 'inserttext') || text.length === 0) {
      return usage('keyboard <type|inserttext> <text>')
    }
    return ok('keyboard', 'browse.keyboard', { mode, text: text.join(' ') })
  },
  select: (args) => {
    const [target, ...values] = args
    if (!target || values.length === 0) return usage('select <selector|@ref> <value...>')
    return ok('select', 'browse.select', { target, values })
  },
  scroll: (args) => {
    const flags = parseFlags(args, { values: { '-s': 'selector', '--selector': 'selector' } })
    if (typeof flags === 'string') return { ok: false, error: flags }
    const [direction = 'down', amount] = flags.positional
    if (!['up', 'down', 'left', 'right'].includes(direction)) {
      return usage('scroll [up|down|left|right] [px] [--selector <sel>]')
    }
    return ok('scroll', 'browse.scroll', {
      direction,
      amount: num(amount),
      target: flags.values.selector,
    })
  },
  drag: (args) => {
    const [source, target] = args
    return source && target
      ? ok('drag', 'browse.drag', { source, target })
      : usage('drag <source> <target>')
  },
  upload: (args, cwd) => {
    const [target, ...files] = args
    if (!target || files.length === 0) return usage('upload <selector|@ref> <file...>')
    return ok('upload', 'browse.upload', {
      target,
      files: files.map((f) => resolvePath(cwd, f)),
    })
  },
  screenshot: (args, cwd) => {
    const flags = parseFlags(args, { booleans: { '--full': 'full', '-f': 'full' } })
    if (typeof flags === 'string') return { ok: false, error: flags }
    const [path] = flags.positional
    return ok('screenshot', 'browse.screenshot', {
      path: path ? resolvePath(cwd, path) : undefined,
      full: flags.booleans.has('full'),
    })
  },
  pdf: (args, cwd) =>
    args[0] ? ok('pdf', 'browse.pdf', { path: resolvePath(cwd, args[0]) }) : usage('pdf <path>'),
  snapshot: (args) => {
    const flags = parseFlags(args, {
      values: { '-d': 'depth', '--depth': 'depth', '-s': 'selector', '--selector': 'selector' },
      booleans: {
        '-i': 'interactive',
        '--interactive': 'interactive',
        '-c': 'compact',
        '--compact': 'compact',
        '-u': 'urls',
        '--urls': 'urls',
      },
    })
    if (typeof flags === 'string') return { ok: false, error: flags }
    if (flags.positional.length > 0) {
      return usage('snapshot [-i] [-c] [-u] [-d <depth>] [-s <selector>]')
    }
    return ok('snapshot', 'browse.snapshot', {
      interactive: flags.booleans.has('interactive'),
      compact: flags.booleans.has('compact'),
      urls: flags.booleans.has('urls'),
      depth: num(flags.values.depth),
      selector: flags.values.selector,
    })
  },
  eval: (args) => {
    const flags = parseFlags(args, {
      values: { '-b': 'base64', '--base64': 'base64' },
      booleans: { '--stdin': 'stdin' },
    })
    if (typeof flags === 'string') return { ok: false, error: flags }
    if (flags.booleans.has('stdin')) {
      return {
        ok: true,
        call: { verb: 'eval', method: 'browse.eval', params: {}, readsStdin: true },
      }
    }
    if (flags.values.base64 !== undefined) {
      return ok('eval', 'browse.eval', {
        js: Buffer.from(flags.values.base64, 'base64').toString('utf8'),
      })
    }
    const js = flags.positional.join(' ')
    return js ? ok('eval', 'browse.eval', { js }) : usage('eval <js> | -b <base64> | --stdin')
  },
  get: (args) => {
    const [sub, target, arg] = args
    if (!sub) return usage('get <text|html|value|attr|title|url|count|box|styles> [selector] [arg]')
    if (sub === 'attr' && (!target || !arg)) return usage('get attr <selector|@ref> <name>')
    return ok('get', 'browse.get', { sub, target, arg })
  },
  is: (args) => {
    const [sub, target] = args
    if (!sub || !target) return usage('is <visible|enabled|checked> <selector|@ref>')
    return ok('is', 'browse.is', { sub, target })
  },
  find: (args) => {
    const flags = parseFlags(args, {
      values: { '--name': 'name' },
      booleans: { '--exact': 'exact' },
    })
    if (typeof flags === 'string') return { ok: false, error: flags }
    const [by, ...rest] = flags.positional
    const common = { name: flags.values.name, exact: flags.booleans.has('exact') }
    if (by === 'nth') {
      const [index, value, action, ...text] = rest
      if (num(index) === undefined || !value) {
        return usage('find nth <index> <selector> [action] [text]')
      }
      return ok('find', 'browse.find', {
        by: 'nth',
        value,
        index: num(index),
        action,
        text: text.join(' ') || undefined,
        ...common,
      })
    }
    if (by === 'first' || by === 'last') {
      const [value, action, ...text] = rest
      if (!value) return usage(`find ${by} <selector> [action] [text]`)
      return ok('find', 'browse.find', {
        by: 'nth',
        value,
        index: by === 'first' ? 0 : -1,
        action,
        text: text.join(' ') || undefined,
        ...common,
      })
    }
    if (!by || !FIND_LOCATORS.includes(by)) {
      return usage(
        'find <role|text|label|placeholder|alt|title|testid|first|last|nth> <value> [action] [text]',
      )
    }
    const [value, action, ...text] = rest
    if (!value) return usage(`find ${by} <value> [action] [text]`)
    return ok('find', 'browse.find', {
      by,
      value,
      action,
      text: text.join(' ') || undefined,
      ...common,
    })
  },
  wait: (args, cwd) => {
    const flags = parseFlags(args, {
      values: {
        '--timeout': 'timeout',
        '--state': 'state',
        '--text': 'text',
        '-t': 'text',
        '--url': 'url',
        '-u': 'url',
        '--load': 'load',
        '-l': 'load',
        '--fn': 'fn',
        '-f': 'fn',
      },
      booleans: { '--download': 'download', '-d': 'download' },
    })
    if (typeof flags === 'string') return { ok: false, error: flags }
    const timeoutMs = num(flags.values.timeout)
    if (flags.booleans.has('download')) {
      const [path] = flags.positional
      return ok('wait', 'browse.download', {
        path: path ? resolvePath(cwd, path) : undefined,
        timeoutMs,
      })
    }
    const { text, url, load, fn, state } = flags.values
    if (text !== undefined || url !== undefined || load !== undefined || fn !== undefined) {
      return ok('wait', 'browse.wait', { text, url, load, fn, timeoutMs })
    }
    const [first] = flags.positional
    if (!first) {
      return usage('wait <selector|ms> [--state visible|hidden] | --text | --url | --load | --fn')
    }
    if (/^\d+$/.test(first)) return ok('wait', 'browse.wait', { ms: Number(first) })
    return ok('wait', 'browse.wait', { target: first, state, timeoutMs })
  },
  mouse: (args) => {
    const [action, a, b] = args
    if (action === 'move') {
      if (num(a) === undefined || num(b) === undefined) return usage('mouse move <x> <y>')
      return ok('mouse', 'browse.mouse', { action, x: num(a), y: num(b) })
    }
    if (action === 'down' || action === 'up') {
      return ok('mouse', 'browse.mouse', { action, button: a ?? 'left' })
    }
    if (action === 'wheel') {
      if (num(a) === undefined) return usage('mouse wheel <dy> [dx]')
      return ok('mouse', 'browse.mouse', { action, dy: num(a), dx: num(b) ?? 0 })
    }
    return usage('mouse <move|down|up|wheel> ...')
  },
  set: (args) => {
    const [what, ...rest] = args
    switch (what) {
      case 'viewport': {
        const [w, h, scale] = rest
        if (num(w) === undefined || num(h) === undefined) {
          return usage('set viewport <width> <height> [scale]')
        }
        return ok('set', 'browse.set', { what, width: num(w), height: num(h), scale: num(scale) })
      }
      case 'media':
        return ok('set', 'browse.set', {
          what,
          colorScheme: rest.find((r) => r === 'dark' || r === 'light'),
          reducedMotion: rest.includes('reduced-motion'),
        })
      case 'offline':
        return ok('set', 'browse.set', { what, offline: (rest[0] ?? 'on') !== 'off' })
      case 'headers': {
        try {
          const headers = JSON.parse(rest.join(' ') || '{}')
          return ok('set', 'browse.set', { what, headers })
        } catch {
          return usage("set headers '<json object>'")
        }
      }
      case 'geo': {
        const [lat, lng] = rest
        if (num(lat) === undefined || num(lng) === undefined) return usage('set geo <lat> <lng>')
        return ok('set', 'browse.set', { what, latitude: num(lat), longitude: num(lng) })
      }
      default:
        return usage('set <viewport|media|offline|headers|geo> ...')
    }
  },
  cookies: (args) => {
    const flags = parseFlags(args, {
      values: {
        '--url': 'url',
        '--domain': 'domain',
        '--path': 'path',
        '--sameSite': 'sameSite',
        '--expires': 'expires',
      },
      booleans: { '--httpOnly': 'httpOnly', '--secure': 'secure' },
    })
    if (typeof flags === 'string') return { ok: false, error: flags }
    const [sub = 'get', name, value] = flags.positional
    if (sub === 'get') return ok('cookies', 'browse.cookies', { sub, url: flags.values.url })
    if (sub === 'clear') return ok('cookies', 'browse.cookies', { sub })
    if (sub !== 'set' || !name || value === undefined) {
      return usage(
        'cookies [get] | cookies set <name> <value> [--url] [--domain] [--path] [--httpOnly] [--secure] [--sameSite] [--expires] | cookies clear',
      )
    }
    return ok('cookies', 'browse.cookies', {
      sub,
      name,
      value,
      url: flags.values.url,
      domain: flags.values.domain,
      path: flags.values.path,
      sameSite: flags.values.sameSite,
      expires: num(flags.values.expires),
      httpOnly: flags.booleans.has('httpOnly'),
      secure: flags.booleans.has('secure'),
    })
  },
  storage: (args) => {
    const [area, op, key, value] = args
    if (area !== 'local' && area !== 'session') {
      return usage('storage <local|session> [get|set|clear] [key] [value]')
    }
    if (op === 'set') {
      if (!key || value === undefined) return usage(`storage ${area} set <key> <value>`)
      return ok('storage', 'browse.storage', { area, sub: 'set', key, value })
    }
    if (op === 'clear') return ok('storage', 'browse.storage', { area, sub: 'clear' })
    const lookup = op === 'get' ? key : op
    return ok('storage', 'browse.storage', { area, sub: 'get', key: lookup })
  },
  network: (args) => {
    const flags = parseFlags(args, {
      values: {
        '--filter': 'filter',
        '--type': 'type',
        '--method': 'method',
        '--status': 'status',
        '--body': 'body',
      },
      booleans: { '--abort': 'abort', '--clear': 'clear' },
    })
    if (typeof flags === 'string') return { ok: false, error: flags }
    const [sub, arg] = flags.positional
    switch (sub) {
      case 'requests':
        return ok('network', 'browse.network', {
          sub,
          filter: flags.values.filter,
          types: flags.values.type?.split(','),
          method: flags.values.method,
          status: flags.values.status,
          clear: flags.booleans.has('clear'),
        })
      case 'request':
        return arg
          ? ok('network', 'browse.network', { sub, requestId: arg })
          : usage('network request <requestId>')
      case 'route':
        if (!arg) return usage('network route <url> [--abort] [--body <json>]')
        return ok('network', 'browse.network', {
          sub,
          url: arg,
          abort: flags.booleans.has('abort'),
          body: flags.values.body,
        })
      case 'unroute':
        return ok('network', 'browse.network', { sub, url: arg })
      default:
        return usage('network <requests|request|route|unroute> ...')
    }
  },
  tab: (args) => {
    const [sub, arg] = args
    if (sub === undefined || sub === 'list') return ok('tab', 'browse.tab', { sub: 'list' })
    if (sub === 'new') return ok('tab', 'browse.tab', { sub: 'new', url: arg })
    if (sub === 'close') return ok('tab', 'browse.tab', { sub: 'close', target: arg })
    return ok('tab', 'browse.tab', { sub: 'switch', target: sub })
  },
  frame: (args) =>
    args[0]
      ? ok('frame', 'browse.frame', { target: args[0] })
      : usage('frame <selector|@ref|main>'),
  dialog: (args) => {
    const [sub, ...text] = args
    if (sub === 'accept') {
      return ok('dialog', 'browse.dialog', { sub, text: text.length ? text.join(' ') : undefined })
    }
    if (sub === 'dismiss' || sub === 'status') return ok('dialog', 'browse.dialog', { sub })
    return usage('dialog <accept [text]|dismiss|status>')
  },
  console: bufferVerb('console'),
  errors: bufferVerb('errors'),
  highlight: targetVerb('highlight'),
  inspect: plainVerb('inspect'),
  state: (args, cwd) => {
    const [sub, path] = args
    if ((sub !== 'save' && sub !== 'load') || !path) return usage('state <save|load> <path>')
    return ok('state', 'browse.state', { sub, path: resolvePath(cwd, path) })
  },
  pushstate: (args) =>
    args[0] ? ok('pushstate', 'browse.pushstate', { url: args[0] }) : usage('pushstate <url>'),
  addinitscript: (args) =>
    args.length > 0
      ? ok('addinitscript', 'browse.addinitscript', { js: args.join(' ') })
      : usage('addinitscript <js>'),
  removeinitscript: (args) =>
    args[0]
      ? ok('removeinitscript', 'browse.removeinitscript', { identifier: args[0] })
      : usage('removeinitscript <identifier>'),
  addstyle: (args) =>
    args.length > 0
      ? ok('addstyle', 'browse.addstyle', { css: args.join(' ') })
      : usage('addstyle <css>'),
  identify: plainVerb('identify'),
  login: (args) => {
    const flags = parseFlags(args, { values: { '--user': 'user' } })
    if (typeof flags === 'string') return { ok: false, error: flags }
    if (flags.positional.length > 0) return usage('login [--user <name>]')
    return ok('login', 'browse.login', flags.values.user ? { username: flags.values.user } : {})
  },
  zoom: (args) =>
    args[0] === 'in' || args[0] === 'out' || args[0] === 'reset'
      ? ok('zoom', 'browse.zoom', { action: args[0] })
      : usage('zoom <in|out|reset>'),
  'focus-mode': (args) =>
    args[0] === 'enter' || args[0] === 'exit' || args[0] === 'toggle'
      ? ok('focus-mode', 'browse.focusMode', { action: args[0] })
      : usage('focus-mode <enter|exit|toggle>'),
  'react-grab': (args) =>
    args[0] === 'toggle' || args[0] === 'get'
      ? ok('react-grab', 'browse.reactGrab', { action: args[0] })
      : usage('react-grab <toggle|get>'),
  history: (args) =>
    args[0] === 'clear'
      ? ok('history', 'browse.history', { sub: 'clear' })
      : usage('history clear'),
  'focus-webview': plainVerb('focus-webview', 'focusWebview'),
  'is-webview-focused': plainVerb('is-webview-focused', 'isWebviewFocused'),
  pick: (args) => {
    const flags = parseFlags(args, { values: { '--timeout': 'timeout' } })
    if (typeof flags === 'string') return { ok: false, error: flags }
    return ok('pick', 'browse.pick', { timeoutMs: num(flags.values.timeout) })
  },
}

export const BROWSE_VERBS = [...Object.keys(parsers), 'batch'].sort()

export function parseBrowseCommand(argv: string[], cwd: string): BrowseParse {
  const [verb, ...args] = argv
  if (!verb) return { ok: false, error: `missing command (try: ${BROWSE_VERBS.join(', ')})` }
  const parser = parsers[verb]
  if (!parser) {
    return { ok: false, error: `unknown command '${verb}' (try: ${BROWSE_VERBS.join(', ')})` }
  }
  return parser(args, cwd)
}
