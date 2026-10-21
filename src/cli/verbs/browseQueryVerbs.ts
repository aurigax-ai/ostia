import { resolve as resolvePath } from 'node:path'
import { num, ok, type Parser, parseFlags, usage } from './browseFlags'

const FIND_LOCATORS = ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid']

export const queryVerbs: Record<string, Parser> = {
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
}
