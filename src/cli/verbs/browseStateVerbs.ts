import { resolve as resolvePath } from 'node:path'
import {
  bufferVerb,
  num,
  ok,
  type Parser,
  parseFlags,
  plainVerb,
  targetVerb,
  usage,
} from './browseFlags'

export const stateVerbs: Record<string, Parser> = {
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
