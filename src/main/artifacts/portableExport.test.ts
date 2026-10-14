import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: { sender: { id: number } }, request: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: { sender: { id: number } }, request: unknown) => unknown,
    ) => handlers.set(channel, handler),
  },
}))

import type { PreviewTheme } from '../../shared/artifacts/htmlPreview'
import type { PortableResult } from '../../shared/artifacts/portable'
import { PortableBuilder } from './portableBuilder'
import type { Bundler } from './portableBundle'
import { PortableExport, registerPortableIpc } from './portableExport'

const THEME: PreviewTheme = { dark: false, vars: { '--ostia-bg': '#fff' } }
const DAY = 24 * 60 * 60 * 1000

interface Rig {
  exporter: PortableExport
  folder: string
  temp: string
  opened: string[]
  clipboard: string[]
  saveTo: { path: string | null }
  sandboxed: Set<string>
  builds: () => number
  clock: { now: number }
}

let r: Rig

function rig(): Rig {
  const base = mkdtempSync(join(tmpdir(), 'portable-export-'))
  const folder = join(base, 'artifacts')
  const temp = join(base, 'ostia-portable')
  mkdirSync(folder)
  const opened: string[] = []
  const clipboard: string[] = []
  const saveTo = { path: null as string | null }
  const sandboxed = new Set<string>()
  const clock = { now: Date.UTC(2026, 9, 14, 12) }
  let builds = 0
  const builder = new PortableBuilder({
    load: async () => {
      const real = (await import('esbuild')) as unknown as Bundler
      return {
        build: (options) => {
          builds += 1
          return real.build(options)
        },
      }
    },
    runtimeDir: () => join(process.cwd(), 'out', 'artifact-runtime'),
    version: '9.9.9',
  })
  const exporter = new PortableExport({
    builder,
    confine: (path) => (path.startsWith(`${base}/`) ? path : null),
    servesFolder: (dir) => dir === folder,
    ownsWorkspace: (windowId, workspaceId) => workspaceId.startsWith(`${windowId}:`),
    sandboxed: (workspaceId) => sandboxed.has(workspaceId),
    tmpDir: () => temp,
    openPath: async (path) => {
      opened.push(path)
      return ''
    },
    saveDialog: async () => saveTo.path,
    downloads: () => base,
    writeClipboard: (text) => clipboard.push(text),
    version: '9.9.9',
    now: () => clock.now,
  })
  return {
    exporter,
    folder,
    temp,
    opened,
    clipboard,
    saveTo,
    sandboxed,
    builds: () => builds,
    clock,
  }
}

function write(name: string, body: string): string {
  const path = join(r.folder, name)
  writeFileSync(path, body)
  return path
}

const COMPONENT = 'export default () => <p className="p-4">hello</p>\n'
const MARKDOWN = {
  body: '<article class="typeset"><h1>Plan</h1></article>',
  css: '.typeset{color:red}',
}

beforeEach(() => {
  r = rig()
})

afterEach(() => {
  handlers.clear()
})

describe('PortableExport', () => {
  it('PRT-C33 opens a component in the browser from a 0600 file, and a startup sweeps old ones', async () => {
    const path = write('chart.tsx', COMPONENT)
    const result = await r.exporter.run('1', 'open', { workspaceId: '1:w', path, theme: THEME })
    expect(result).toEqual({ ok: true })
    expect(r.opened).toHaveLength(1)
    const file = r.opened[0]
    expect(file.startsWith(`${r.temp}/`)).toBe(true)
    expect(file).toMatch(/\/chart-[0-9a-f]{8}\.html$/)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toContain('<iframe sandbox="allow-scripts"')
    const old = join(r.temp, 'old-00000000.html')
    writeFileSync(old, 'x')
    const day = (r.clock.now - DAY - 1000) / 1000
    utimesSync(old, day, day)
    r.exporter.sweep()
    expect(existsSync(old)).toBe(false)
    expect(existsSync(file)).toBe(true)
  })

  it('PRT-C34 saves a Markdown artifact where the human picked and copies the same text', async () => {
    const path = write('plan.md', '# Plan\n')
    r.saveTo.path = join(r.folder, '..', 'plan.html')
    const saved = await r.exporter.run('1', 'save', {
      workspaceId: '1:w',
      path,
      theme: THEME,
      document: MARKDOWN,
    })
    expect(saved).toEqual({ ok: true })
    const text = readFileSync(r.saveTo.path, 'utf8')
    expect(text).toContain('<iframe sandbox="allow-popups allow-popups-to-escape-sandbox"')
    expect(text).toContain(
      '&lt;h1&gt;Plan&lt;/h1&gt;'.replace(/&lt;|&gt;/g, (m) => (m === '&lt;' ? '<' : '>')),
    )
    const copied = await r.exporter.run('1', 'copy', {
      workspaceId: '1:w',
      path,
      theme: THEME,
      document: MARKDOWN,
    })
    expect(copied).toEqual({ ok: true })
    expect(r.clipboard).toHaveLength(1)
    expect(r.clipboard[0].replace(/"built":"[^"]+"/, '')).toBe(text.replace(/"built":"[^"]+"/, ''))
  })

  it('PRT-C35 is reached only over owner-window IPC', async () => {
    registerPortableIpc(r.exporter)
    expect([...handlers.keys()].sort()).toEqual([
      'artifacts:portable-copy',
      'artifacts:portable-open',
      'artifacts:portable-save',
    ])
    const path = write('chart.tsx', COMPONENT)
    const handler = handlers.get('artifacts:portable-copy')
    const refused = (await handler?.(
      { sender: { id: 2 } },
      { workspaceId: '1:w', path, theme: THEME },
    )) as PortableResult
    expect(refused).toEqual({ ok: false, reason: 'not-allowed' })
    expect(r.clipboard).toEqual([])
    const outside = (await handler?.(
      { sender: { id: 1 } },
      { workspaceId: '1:w', path: '/etc/hosts.md', theme: THEME },
    )) as PortableResult
    expect(outside).toEqual({ ok: false, reason: 'not-allowed' })
    const socket = readFileSync(join(process.cwd(), 'src/main/control/controlServer.ts'), 'utf8')
    expect(socket).not.toMatch(/portable/i)
  })

  it('PRT-C36 writes nothing when the human cancels or the folder is not writable', async () => {
    const path = write('plan.md', '# Plan\n')
    r.saveTo.path = null
    const cancelled = await r.exporter.run('1', 'save', {
      workspaceId: '1:w',
      path,
      theme: THEME,
      document: MARKDOWN,
    })
    expect(cancelled).toEqual({ ok: false, reason: 'cancelled' })
    const locked = join(r.folder, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    r.saveTo.path = join(locked, 'plan.html')
    const failed = await r.exporter.run('1', 'save', {
      workspaceId: '1:w',
      path,
      theme: THEME,
      document: MARKDOWN,
    })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.reason).toBe('failed')
    expect(readdirSync(locked)).toEqual([])
    chmodSync(locked, 0o700)
  })

  it('PRT-C38 never lets a runnable file of a sandboxed workspace out, but a document', async () => {
    r.sandboxed.add('1:w')
    const component = write('chart.tsx', COMPONENT)
    const page = write('page.html', '<!doctype html><p>x</p>')
    for (const path of [component, page]) {
      for (const action of ['open', 'save', 'copy'] as const) {
        const result = await r.exporter.run('1', action, { workspaceId: '1:w', path, theme: THEME })
        expect(result, `${action} ${path}`).toEqual({ ok: false, reason: 'sandboxed' })
      }
    }
    expect(r.builds()).toBe(0)
    const notes = write('notes.md', '# Notes\n')
    r.saveTo.path = join(r.folder, 'notes.html')
    expect(
      await r.exporter.run('1', 'save', {
        workspaceId: '1:w',
        path: notes,
        theme: THEME,
        document: MARKDOWN,
      }),
    ).toEqual({ ok: true })
  })

  it('PRT-C40 writes, opens and copies nothing for a component that does not build', async () => {
    const path = write('broken.tsx', 'export default () => <div>\n')
    r.saveTo.path = join(r.folder, 'broken.html')
    for (const action of ['open', 'save', 'copy'] as const) {
      const result = await r.exporter.run('1', action, { workspaceId: '1:w', path, theme: THEME })
      expect(result.ok, action).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('not-built')
        expect(result.message).toMatch(/broken\.tsx:\d+:\d+/)
      }
    }
    expect(r.opened).toEqual([])
    expect(r.clipboard).toEqual([])
    expect(existsSync(r.saveTo.path)).toBe(false)
  })
})
