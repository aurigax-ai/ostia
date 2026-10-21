import { resolve as resolvePath } from 'node:path'
import {
  keyVerb,
  num,
  ok,
  type Parser,
  parseFlags,
  plainVerb,
  targetVerb,
  textVerb,
  usage,
} from './browseFlags'

export const interactVerbs: Record<string, Parser> = {
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
}
