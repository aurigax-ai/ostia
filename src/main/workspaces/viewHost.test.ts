import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  VIEW_FILE_MAX_BYTES,
  type ViewInfo,
  type ViewListing,
  parseViewText,
} from '../../shared/views/views'
import { ViewHost, ViewStore } from './viewHost'

const VIEW = {
  version: 1,
  title: 'Workspaces',
  placement: 'sidebar',
  root: { type: 'list', for: 'workspaces', as: 'ws', item: { type: 'text', text: '{{ws.name}}' } },
}

let base: string
let dir: string
let storePath: string
let host: ViewHost | null = null
let changes: ViewListing[] = []

function write(name: string, body: unknown): void {
  writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
}

function start(): ViewHost {
  host = new ViewHost({
    dir,
    store: new ViewStore(storePath),
    onChange: (listing) => changes.push(listing),
  })
  return host
}

function info(name: string): ViewInfo | undefined {
  return host?.list().find((v) => v.name === name)
}

function settleWatcher(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, process.platform === 'darwin' ? 600 : 0))
}

async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const began = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - began > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-views-'))
  dir = join(base, 'views')
  mkdirSync(dir)
  storePath = join(base, 'views.json')
  changes = []
})

afterEach(() => {
  host?.stop()
  host = null
  rmSync(base, { recursive: true, force: true })
})

describe('ViewHost', () => {
  it('lists a new view as pending and hides its tree until enabled', () => {
    write('agents.json', VIEW)
    start()
    expect(info('agents')).toMatchObject({
      status: 'pending',
      title: 'Workspaces',
      placement: 'sidebar',
      doc: null,
      problems: [],
    })
    host?.setEnabled('agents', true)
    expect(info('agents')?.status).toBe('enabled')
    expect(info('agents')?.doc?.root.type).toBe('list')
    expect(JSON.parse(readFileSync(storePath, 'utf8'))).toEqual({ agents: { enabled: true } })
    expect(changes.at(-1)?.views[0].status).toBe('enabled')
  })

  it('remembers enablement across restarts and never enables a file it does not list', () => {
    write('agents.json', VIEW)
    start().setEnabled('agents', true)
    host?.setEnabled('ghost', true)
    host?.stop()
    start()
    expect(info('agents')?.status).toBe('enabled')
    expect(JSON.parse(readFileSync(storePath, 'utf8'))).not.toHaveProperty('ghost')
  })

  it('refuses symbolic links', () => {
    write('real.txt', VIEW)
    symlinkSync(join(dir, 'real.txt'), join(dir, 'linked.json'))
    start()
    expect(info('linked')).toMatchObject({
      doc: null,
      placement: null,
      problems: [{ path: '(file)', message: 'symbolic links are not read' }],
    })
  })

  it('refuses files over the size cap', () => {
    write('big.json', {
      ...VIEW,
      description: 'x'.repeat(10),
      pad: ' '.repeat(VIEW_FILE_MAX_BYTES),
    })
    start()
    expect(info('big')?.problems[0].message).toMatch(/larger than 64 KiB/)
  })

  it('ignores files whose names are not view names', () => {
    write('Agents.json', VIEW)
    write('notes.txt', 'hi')
    write('.hidden.json', VIEW)
    start()
    expect(host?.list()).toEqual([])
  })

  it('keeps the last good tree when an enabled view breaks, and reports the problem', () => {
    write('agents.json', VIEW)
    start().setEnabled('agents', true)
    write('agents.json', { ...VIEW, root: { type: 'text', text: '{{nope}}' } })
    host?.rescan()
    const broken = info('agents')
    expect(broken?.stale).toBe(true)
    expect(broken?.doc?.root.type).toBe('list')
    expect(broken?.problems[0]).toMatchObject({ path: 'root.text', line: 7 })
  })

  it('reloads on its own when a file is added, changed or removed', async () => {
    start().watch()
    await settleWatcher()
    write('agents.json', VIEW)
    await until(() => info('agents'))
    write('agents.json', { ...VIEW, title: 'Renamed' })
    await until(() => (info('agents')?.title === 'Renamed' ? true : undefined))
    rmSync(join(dir, 'agents.json'))
    await until(() => (info('agents') === undefined ? true : undefined))
    expect(changes.length).toBeGreaterThanOrEqual(3)
  })

  it('creates the views folder when it does not exist yet', async () => {
    rmSync(dir, { recursive: true })
    start().watch()
    await settleWatcher()
    write('late.json', VIEW)
    await until(() => info('late'))
  })
})

describe('ostia skill', () => {
  it('teaches a view example that validates', () => {
    const skill = readFileSync(join(__dirname, '..', 'agents', 'ostia-skill.md'), 'utf8')
    const section = skill.slice(skill.indexOf('## Views'))
    const example = /```json\n([\s\S]*?)```/.exec(section)?.[1]
    expect(example).toBeDefined()
    const res = parseViewText(example ?? '')
    expect(res.ok ? [] : res.problems).toEqual([])
  })
})
