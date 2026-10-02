import { describe, expect, it } from 'vitest'
import {
  type BrowseParse,
  extractGlobals,
  parseBrowseCommand,
  splitCommandLine,
} from './browseArgs'

const CWD = '/home/u/proj'

function call(argv: string[]): { method: string; params: Record<string, unknown> } {
  const parsed: BrowseParse = parseBrowseCommand(argv, CWD)
  if (!parsed.ok) throw new Error(parsed.error)
  return { method: parsed.call.method, params: parsed.call.params }
}

function error(argv: string[]): string {
  const parsed = parseBrowseCommand(argv, CWD)
  if (parsed.ok) throw new Error(`expected an error for ${argv.join(' ')}`)
  return parsed.error
}

describe('parseBrowseCommand', () => {
  it('maps agent-browser navigation verbs', () => {
    expect(call(['open', 'example.com'])).toEqual({
      method: 'browse.open',
      params: { url: 'example.com' },
    })
    expect(call(['open'])).toEqual({ method: 'browse.open', params: {} })
    expect(call(['back']).method).toBe('browse.back')
    expect(call(['forward']).method).toBe('browse.forward')
    expect(call(['reload']).method).toBe('browse.reload')
    expect(call(['close']).method).toBe('browse.close')
  })

  it('maps login with an optional username', () => {
    expect(call(['login'])).toEqual({ method: 'browse.login', params: {} })
    expect(call(['login', '--user', 'me@x.dev'])).toEqual({
      method: 'browse.login',
      params: { username: 'me@x.dev' },
    })
    expect(error(['login', 'extra'])).toMatch(/usage: pine browse login/)
  })

  it('reads snapshot flags in both short and long form', () => {
    expect(call(['snapshot', '-i', '-c', '-d', '3', '-s', '#main', '-u']).params).toEqual({
      interactive: true,
      compact: true,
      urls: true,
      depth: 3,
      selector: '#main',
    })
    expect(call(['snapshot', '--interactive']).params.interactive).toBe(true)
  })

  it('takes a selector or @ref as the element target', () => {
    expect(call(['click', '@e2'])).toEqual({
      method: 'browse.click',
      params: { target: '@e2', newTab: false },
    })
    expect(call(['click', '#go', '--new-tab']).params.newTab).toBe(true)
    expect(call(['hover', '@e4'])).toEqual({ method: 'browse.hover', params: { target: '@e4' } })
    expect(call(['scrollintoview', '@e1']).method).toBe('browse.scrollintoview')
    expect(error(['click'])).toMatch(/usage: pine browse click/)
  })

  it('joins the rest of the words as the text for fill and type', () => {
    expect(call(['fill', '@e3', 'test@example.com']).params).toEqual({
      target: '@e3',
      text: 'test@example.com',
    })
    expect(call(['type', '#q', 'hello', 'world']).params.text).toBe('hello world')
  })

  it('passes key combos through to press', () => {
    expect(call(['press', 'Control+a'])).toEqual({
      method: 'browse.press',
      params: { key: 'Control+a' },
    })
    expect(call(['keyboard', 'inserttext', 'hi']).params).toEqual({
      mode: 'inserttext',
      text: 'hi',
    })
  })

  it('selects one or several values', () => {
    expect(call(['select', '@e1', 'a', 'b']).params).toEqual({ target: '@e1', values: ['a', 'b'] })
  })

  it('scrolls down 300px by default and accepts a direction, amount and selector', () => {
    expect(call(['scroll']).params).toEqual({ direction: 'down', amount: undefined })
    expect(call(['scroll', 'up', '500', '--selector', '.list']).params).toEqual({
      direction: 'up',
      amount: 500,
      target: '.list',
    })
    expect(error(['scroll', 'sideways'])).toMatch(/usage/)
  })

  it('resolves file paths against the caller cwd', () => {
    expect(call(['screenshot', 'shots/a.png', '--full']).params).toEqual({
      path: '/home/u/proj/shots/a.png',
      full: true,
    })
    expect(call(['screenshot']).params.path).toBeUndefined()
    expect(call(['pdf', 'out.pdf']).params.path).toBe('/home/u/proj/out.pdf')
    expect(call(['upload', '@e1', 'a.txt', '/tmp/b.txt']).params.files).toEqual([
      '/home/u/proj/a.txt',
      '/tmp/b.txt',
    ])
    expect(call(['state', 'save', 'auth.json']).params.path).toBe('/home/u/proj/auth.json')
  })

  it('decodes base64 eval and asks for stdin with --stdin', () => {
    expect(call(['eval', '-b', Buffer.from('document.title').toString('base64')]).params).toEqual({
      js: 'document.title',
    })
    const stdin = parseBrowseCommand(['eval', '--stdin'], CWD)
    expect(stdin.ok && stdin.call.readsStdin).toBe(true)
    expect(call(['eval', 'document.title']).params.js).toBe('document.title')
  })

  it('reads get attr as positional selector and attribute name', () => {
    expect(call(['get', 'attr', '@e1', 'href']).params).toEqual({
      sub: 'attr',
      target: '@e1',
      arg: 'href',
    })
    expect(call(['get', 'title']).params).toEqual({ sub: 'title' })
    expect(error(['get', 'attr', '@e1'])).toMatch(/get attr/)
  })

  it('parses find locators with a default click action', () => {
    expect(call(['find', 'role', 'button', '--name', 'Submit']).params).toEqual({
      by: 'role',
      value: 'button',
      name: 'Submit',
      exact: false,
    })
    expect(call(['find', 'label', 'Email', 'fill', 'a@b.c']).params).toMatchObject({
      by: 'label',
      value: 'Email',
      action: 'fill',
      text: 'a@b.c',
    })
    expect(call(['find', 'text', 'Sign In', 'click', '--exact']).params.exact).toBe(true)
  })

  it('turns find first, last and nth into an indexed css lookup', () => {
    expect(call(['find', 'first', '.item', 'click']).params).toMatchObject({
      by: 'nth',
      value: '.item',
      index: 0,
    })
    expect(call(['find', 'last', '.item']).params.index).toBe(-1)
    expect(call(['find', 'nth', '2', 'a', 'text']).params).toMatchObject({
      by: 'nth',
      value: 'a',
      index: 2,
      action: 'text',
    })
    expect(error(['find', 'color', 'red'])).toMatch(/usage/)
  })

  it('parses every wait form', () => {
    expect(call(['wait', '2000']).params).toEqual({ ms: 2000 })
    expect(call(['wait', '#spinner', '--state', 'hidden']).params).toEqual({
      target: '#spinner',
      state: 'hidden',
      timeoutMs: undefined,
    })
    expect(call(['wait', '--text', 'Welcome']).params).toMatchObject({ text: 'Welcome' })
    expect(call(['wait', '--url', '**/dash', '--timeout', '5000']).params).toMatchObject({
      url: '**/dash',
      timeoutMs: 5000,
    })
    expect(call(['wait', '--load', 'networkidle']).params).toMatchObject({ load: 'networkidle' })
    expect(call(['wait', '--fn', 'window.ready']).params).toMatchObject({ fn: 'window.ready' })
    expect(call(['wait', '--download', 'f.zip'])).toEqual({
      method: 'browse.download',
      params: { path: '/home/u/proj/f.zip', timeoutMs: undefined },
    })
  })

  it('reads negative numbers as values, not flags', () => {
    expect(call(['mouse', 'wheel', '-120']).params).toEqual({ action: 'wheel', dy: -120, dx: 0 })
    expect(call(['mouse', 'move', '10', '20']).params).toEqual({ action: 'move', x: 10, y: 20 })
    expect(call(['scroll', 'up', '-40', '-s', '#list']).params).toEqual({
      direction: 'up',
      amount: -40,
      target: '#list',
    })
    expect(call(['find', 'nth', '-1', 'li', '--exact']).params).toMatchObject({
      by: 'nth',
      index: -1,
      value: 'li',
      exact: true,
    })
  })

  it('parses browser settings', () => {
    expect(call(['set', 'viewport', '1280', '720', '2']).params).toEqual({
      what: 'viewport',
      width: 1280,
      height: 720,
      scale: 2,
    })
    expect(call(['set', 'media', 'dark', 'reduced-motion']).params).toEqual({
      what: 'media',
      colorScheme: 'dark',
      reducedMotion: true,
    })
    expect(call(['set', 'offline', 'off']).params).toEqual({ what: 'offline', offline: false })
    expect(call(['set', 'headers', '{"X-Key":"v"}']).params).toEqual({
      what: 'headers',
      headers: { 'X-Key': 'v' },
    })
  })

  it('treats a bare cookies call as get and parses cookie flags on set', () => {
    expect(call(['cookies']).params).toEqual({ sub: 'get', url: undefined })
    expect(call(['cookies', 'set', 'sid', 'abc', '--secure', '--sameSite', 'Lax']).params).toEqual({
      sub: 'set',
      name: 'sid',
      value: 'abc',
      url: undefined,
      domain: undefined,
      path: undefined,
      sameSite: 'Lax',
      expires: undefined,
      httpOnly: false,
      secure: true,
    })
    expect(call(['cookies', 'clear']).params).toEqual({ sub: 'clear' })
  })

  it('reads storage like agent-browser: bare area, key, set and clear', () => {
    expect(call(['storage', 'local']).params).toEqual({ area: 'local', sub: 'get', key: undefined })
    expect(call(['storage', 'session', 'token']).params).toEqual({
      area: 'session',
      sub: 'get',
      key: 'token',
    })
    expect(call(['storage', 'local', 'get', 'k']).params.key).toBe('k')
    expect(call(['storage', 'local', 'set', 'k', 'v']).params).toEqual({
      area: 'local',
      sub: 'set',
      key: 'k',
      value: 'v',
    })
    expect(call(['storage', 'local', 'clear']).params).toEqual({ area: 'local', sub: 'clear' })
    expect(error(['storage', 'indexed'])).toMatch(/usage/)
  })

  it('parses network requests, routes and unroutes', () => {
    expect(
      call(['network', 'requests', '--type', 'xhr,fetch', '--status', '2xx']).params,
    ).toMatchObject({ sub: 'requests', types: ['xhr', 'fetch'], status: '2xx' })
    expect(call(['network', 'route', '**/api/*', '--body', '{"a":1}']).params).toEqual({
      sub: 'route',
      url: '**/api/*',
      abort: false,
      body: '{"a":1}',
    })
    expect(call(['network', 'unroute']).params).toEqual({ sub: 'unroute', url: undefined })
  })

  it('maps tab forms: list, new, switch by id and close', () => {
    expect(call(['tab']).params).toEqual({ sub: 'list' })
    expect(call(['tab', 'new', 'x.test']).params).toEqual({ sub: 'new', url: 'x.test' })
    expect(call(['tab', 'p3']).params).toEqual({ sub: 'switch', target: 'p3' })
    expect(call(['tab', 'close']).params).toEqual({ sub: 'close', target: undefined })
  })

  it('reads dialog, console and errors forms', () => {
    expect(call(['dialog', 'accept', 'my', 'answer']).params).toEqual({
      sub: 'accept',
      text: 'my answer',
    })
    expect(call(['dialog', 'status']).params).toEqual({ sub: 'status' })
    expect(call(['console', '--clear']).params).toEqual({ clear: true })
    expect(call(['errors']).params).toEqual({ clear: false })
  })

  it('names the valid commands when one is unknown', () => {
    expect(error(['nav', 'back'])).toMatch(/unknown command 'nav'.*snapshot/)
    expect(error([])).toMatch(/missing command/)
  })

  it('rejects unknown flags', () => {
    expect(error(['snapshot', '--everything'])).toBe('unknown flag --everything')
    expect(error(['snapshot', '-ic'])).toBe('unknown flag -ic')
    expect(error(['snapshot', '--depth=3'])).toBe('unknown flag --depth=3')
    expect(error(['click', '@e1', '--'])).toBe('unknown flag --')
  })

  it('names the flag that came without its value', () => {
    expect(error(['snapshot', '-d'])).toBe('-d needs a value')
    expect(error(['wait', '#done', '--timeout'])).toBe('--timeout needs a value')
  })
})

describe('extractGlobals', () => {
  it('pulls --json and --pane out from anywhere in the arguments', () => {
    expect(extractGlobals(['get', '--json', 'text', '@e1', '--pane', 'p7'])).toEqual({
      json: true,
      paneId: 'p7',
      argv: ['get', 'text', '@e1'],
    })
    expect(extractGlobals(['snapshot', '--pane'])).toBe('--pane needs a value')
  })
})

describe('splitCommandLine', () => {
  it('splits on whitespace and honors quotes and escapes', () => {
    expect(splitCommandLine('open https://x.test')).toEqual(['open', 'https://x.test'])
    expect(splitCommandLine(`fill @e3 "hello world"`)).toEqual(['fill', '@e3', 'hello world'])
    expect(splitCommandLine(`eval 'document.title === "x"'`)).toEqual([
      'eval',
      'document.title === "x"',
    ])
    expect(splitCommandLine('type @e1 a\\ b ""')).toEqual(['type', '@e1', 'a b', ''])
  })
})
