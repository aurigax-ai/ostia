import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import type { PublishOptions } from '../../shared/artifacts/shares'
import { PortableBuilder } from './portableBuilder'
import type { Bundler } from './portableBundle'
import { PortableExport, registerPortableIpc } from './portableExport'
import type { PublishedTables } from './portableTables'
import type { ShareService } from './shares/shareService'

const PUBLISH: PublishOptions = {
  mode: 'link',
  password: '',
  withLinkKey: false,
  expiresInSeconds: 2_592_000,
  acceptedDigest: '',
}

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
  published: Map<string, PublishedTables>
  arriving: Map<string, () => PublishedTables>
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
  const published = new Map<string, PublishedTables>()
  const arriving = new Map<string, () => PublishedTables>()
  let builds = 0
  const builder = new PortableBuilder({
    load: async () => {
      const real = (await import('esbuild')) as unknown as Bundler
      return {
        context: (options) => {
          builds += 1
          return real.context(options)
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
    sandboxedFolders: () =>
      [...sandboxed].map((workspaceId) =>
        workspaceId === '1:w' ? folder : join(base, workspaceId),
      ),
    tmpDir: () => temp,
    openPath: async (path) => {
      opened.push(path)
      return ''
    },
    saveDialog: async () => saveTo.path,
    downloads: () => base,
    writeClipboard: (text) => clipboard.push(text),
    version: '9.9.9',
    publishedTables: (_windowId, path) => published.get(path) ?? null,
    awaitTables: async (_windowId, path) => arriving.get(path)?.() ?? null,
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
    published,
    arriving,
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

  it('copies a viewed file out as the tables its viewer published, never its bytes', async () => {
    const path = join(r.folder, 'sales.xlsx')
    writeFileSync(path, Buffer.from('PK\u0003\u0004 workbook bytes OSTIA_SHEET_BYTES'))
    expect(await r.exporter.run('1', 'copy', { workspaceId: '1:w', path, theme: THEME })).toEqual({
      ok: false,
      reason: 'no-tables',
    })
    expect(
      await r.exporter.run('1', 'copy', {
        workspaceId: '1:w',
        path,
        theme: THEME,
        awaitTables: true,
      }),
    ).toEqual({ ok: false, reason: 'no-tables' })
    r.arriving.set(path, () => {
      r.published.set(path, { tables: [{ name: 'Late', columns: ['A'], rows: [['1']] }] })
      return r.published.get(path) ?? null
    })
    expect(
      await r.exporter.run('1', 'copy', {
        workspaceId: '1:w',
        path,
        theme: THEME,
        awaitTables: true,
      }),
    ).toEqual({ ok: true })
    expect(r.clipboard.at(-1)).toContain('Late')
    r.arriving.clear()
    r.published.set(path, 'too-large')
    expect(await r.exporter.run('1', 'copy', { workspaceId: '1:w', path, theme: THEME })).toEqual({
      ok: false,
      reason: 'too-large',
    })
    r.published.set(path, {
      tables: [{ name: 'Sales <Q1>', columns: ['Region'], rows: [['<b>North</b>']] }],
    })
    const copied = await r.exporter.run('1', 'copy', {
      workspaceId: '1:w',
      path,
      theme: THEME,
      document: { body: '<script>renderer</script>', css: '' },
    })
    expect(copied).toEqual({ ok: true })
    const text = r.clipboard.at(-1) ?? ''
    expect(text).toContain('Sales &amp;lt;Q1&amp;gt;')
    expect(text).toContain('&amp;lt;b&amp;gt;North')
    expect(text).not.toContain('renderer')
    expect(text).toContain('"type":"tables"')
    expect(text).toContain('"sources":{}')
    expect(text).not.toContain('OSTIA_SHEET_BYTES')
  })

  it('PRT-C35 is reached only over owner-window IPC', async () => {
    registerPortableIpc(r.exporter)
    expect([...handlers.keys()].sort()).toEqual([
      'artifacts:portable-copy',
      'artifacts:portable-open',
      'artifacts:portable-publish',
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
      for (const action of ['open', 'save', 'copy', 'publish'] as const) {
        const result = await r.exporter.run('1', action, {
          workspaceId: '1:w',
          path,
          theme: THEME,
          publish: PUBLISH,
        })
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

  it('PRT-C70 refuses a runnable file inside a sandboxed workspace folder whatever workspace the request names', async () => {
    const box = join(r.folder, '..', '1:s')
    mkdirSync(box)
    writeFileSync(join(box, 'escape.tsx'), COMPONENT)
    r.sandboxed.add('1:s')
    for (const action of ['open', 'save', 'copy'] as const) {
      const result = await r.exporter.run('1', action, {
        workspaceId: '1:w',
        path: join(box, 'escape.tsx'),
        theme: THEME,
      })
      expect(result, action).toEqual({ ok: false, reason: 'sandboxed' })
    }
    expect(r.builds()).toBe(0)
  })

  it('PRT-C72 saves a Markdown artifact up to 1 MiB, the most a source file may be', async () => {
    const path = write('long.md', `# Long\n\n${'x'.repeat(900 * 1024)}\n`)
    r.saveTo.path = join(r.folder, 'long.html')
    const saved = await r.exporter.run('1', 'save', {
      workspaceId: '1:w',
      path,
      theme: THEME,
      document: MARKDOWN,
    })
    expect(saved).toEqual({ ok: true })
    const tooLong = write('too-long.md', 'x'.repeat(1024 * 1024 + 1))
    const refused = await r.exporter.run('1', 'save', {
      workspaceId: '1:w',
      path: tooLong,
      theme: THEME,
      document: MARKDOWN,
    })
    expect(refused).toEqual({ ok: false, reason: 'too-large' })
  })

  it('PRT-C80 hands the finished portable file to the share service for the owner window only', async () => {
    const publish = vi.fn(async () => ({ ok: true }) as PortableResult)
    r.exporter.useShares({ publish } as unknown as ShareService)
    const path = write('plan.md', '# Plan\n')
    const request = { workspaceId: '1:w', path, theme: THEME, document: MARKDOWN, publish: PUBLISH }
    expect(await r.exporter.run('1', 'publish', request)).toEqual({ ok: true })
    expect(publish).toHaveBeenCalledTimes(1)
    const [given, options] = publish.mock.calls[0] as unknown as [
      { file: string; source: string; name: string },
      PublishOptions,
    ]
    expect(given.name).toBe('plan.md')
    expect(given.file).toContain('"format":"ostia-artifact/1"')
    expect(options).toEqual(PUBLISH)
    expect(await r.exporter.run('2', 'publish', request)).toEqual({
      ok: false,
      reason: 'not-allowed',
    })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('PRT-C81 publishes nothing without options, without a share service or with options of the wrong shape', async () => {
    const path = write('plan.md', '# Plan\n')
    const base = { workspaceId: '1:w', path, theme: THEME, document: MARKDOWN }
    expect(await r.exporter.run('1', 'publish', { ...base, publish: PUBLISH })).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    const publish = vi.fn(async () => ({ ok: true }) as PortableResult)
    r.exporter.useShares({ publish } as unknown as ShareService)
    expect(await r.exporter.run('1', 'publish', base)).toEqual({ ok: false, reason: 'bad-options' })
    registerPortableIpc(r.exporter)
    const handler = handlers.get('artifacts:portable-publish')
    for (const bad of [
      { ...PUBLISH, mode: 'everyone' },
      { ...PUBLISH, password: 7 },
      { ...PUBLISH, expiresInSeconds: 1.5 },
      { ...PUBLISH, acceptedDigest: true },
      'link',
    ]) {
      expect(await handler?.({ sender: { id: 1 } }, { ...base, publish: bad })).toEqual({
        ok: false,
        reason: 'not-allowed',
      })
    }
    expect(publish).not.toHaveBeenCalled()
  })

  it('PRT-C82 publishes a document of a sandboxed workspace but never its runnable file', async () => {
    r.sandboxed.add('1:w')
    const publish = vi.fn(async () => ({ ok: true }) as PortableResult)
    r.exporter.useShares({ publish } as unknown as ShareService)
    const notes = write('notes.md', '# Notes\n')
    expect(
      await r.exporter.run('1', 'publish', {
        workspaceId: '1:w',
        path: notes,
        theme: THEME,
        document: MARKDOWN,
        publish: PUBLISH,
      }),
    ).toEqual({ ok: true })
  })
})
