import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { ipcMain } from 'electron'
import {
  PORTABLE_FORMAT,
  type PortableManifest,
  wrapPortable,
} from '../../shared/artifacts/portable'
import { ArtifactHistory, previewBuild, registerArtifactHistoryIpc } from './artifactHistory'

const LIGHT = { dark: false, vars: {} }

let root: string
let folder: string
let scratch: Set<string>
let failing: Set<string>
let made: number
let clock: { now: number }
let history: ArtifactHistory

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const madeFor: string[] = []
let titleOf = (file: string): string => basename(file)
let slowMake: Promise<void> | null = null

async function make(workspaceId: string, file: string): Promise<string | null> {
  made += 1
  madeFor.push(workspaceId)
  if (slowMake) await slowMake
  const text = readFileSync(file, 'utf8')
  if (failing.has(basename(file)) || text.includes('SYNTAX')) return null
  const document = `<pre>${text}</pre>`
  const manifest: PortableManifest = {
    format: PORTABLE_FORMAT,
    type: 'markdown',
    name: titleOf(file),
    built: new Date(clock.now).toISOString(),
    ostia: 'test',
    libraries: [],
    theme: LIGHT,
    hash: sha(document),
    sources: {
      [basename(file)]: text,
      ...(text.includes('WITH-LIB') ? { 'lib/part.ts': 'part' } : {}),
    },
  }
  return wrapPortable(document, manifest)
}

function rig(quietMs = 30): ArtifactHistory {
  return new ArtifactHistory({
    root,
    folderOf: (workspaceId) => (workspaceId === 'w1' ? folder : join(root, workspaceId)),
    isScratch: (workspaceId) => scratch.has(workspaceId),
    make,
    kindMatches: (name) => name.endsWith('.xlsx'),
    now: () => clock.now,
    quietMs,
  })
}

function write(name: string, body: string | Buffer): string {
  const path = join(folder, name)
  writeFileSync(path, body)
  return path
}

async function quiet(): Promise<void> {
  await vi.runOnlyPendingTimersAsync()
  await history.settled()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-history-')))
  folder = join(root, 'w1')
  mkdirSync(folder)
  scratch = new Set()
  failing = new Set()
  made = 0
  clock = { now: Date.UTC(2026, 9, 14, 12) }
  history = rig()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ArtifactHistory', () => {
  it('PRT-C41 keeps one portable version per write once each write has been quiet', async () => {
    const path = write('report.md', 'one')
    for (const text of ['one', 'two', 'three']) {
      writeFileSync(path, text)
      history.changed('w1', path)
      await quiet()
      clock.now += 5_000
    }
    const versions = history.list('w1', path)
    expect(versions).toHaveLength(3)
    const texts = versions.map((v) => history.version('w1', path, v.id)?.sources['report.md'])
    expect(texts).toEqual(['three', 'two', 'one'])
    expect(versions[0].current).toBe(true)
  })

  it('PRT-C42 makes one version for a burst of writes', async () => {
    const path = write('chart.md', 'start')
    for (let i = 0; i < 50; i += 1) {
      writeFileSync(path, `write ${i}`)
      history.changed('w1', path)
    }
    await quiet()
    expect(history.list('w1', path)).toHaveLength(1)
    expect(made).toBe(1)
  })

  it('PRT-C43 makes no version when the file does not build and keeps the last good one', async () => {
    const path = write('chart.md', 'good')
    history.changed('w1', path)
    await quiet()
    writeFileSync(path, 'SYNTAX error')
    history.changed('w1', path)
    await quiet()
    const versions = history.list('w1', path)
    expect(versions).toHaveLength(1)
    expect(history.version('w1', path, versions[0].id)?.sources['chart.md']).toBe('good')
  })

  it('PRT-C44 drops the oldest versions past 20 per artifact and 64 MiB per workspace', async () => {
    const path = write('notes.md', 'v0')
    for (let i = 0; i < 21; i += 1) {
      writeFileSync(path, `v${i}`)
      await history.snapshot('w1', path)
      clock.now += 1_000
    }
    const kept = history.list('w1', path)
    expect(kept).toHaveLength(20)
    expect(history.version('w1', path, kept.at(-1)?.id ?? '')?.sources['notes.md']).toBe('v1')
    const big = 'x'.repeat(13 * 1024 * 1024)
    const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'].map((name) =>
      write(name, `${name}${big}`),
    )
    for (const file of files) {
      await history.snapshot('w1', file)
      clock.now += 1_000
    }
    expect(history.list('w1', files[0])).toHaveLength(0)
    expect(history.bytes('w1')).toBeLessThanOrEqual(64 * 1024 * 1024)
  })

  it('PRT-C45 makes no version for the same bytes again, a symlink or a file one folder down', async () => {
    const path = write('same.md', 'same')
    await history.snapshot('w1', path)
    await history.snapshot('w1', path)
    expect(history.list('w1', path)).toHaveLength(1)
    const outside = join(root, 'outside.md')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(folder, 'link.md'))
    mkdirSync(join(folder, 'sub'))
    const deep = join(folder, 'sub', 'deep.md')
    writeFileSync(deep, 'deep')
    expect(await history.snapshot('w1', join(folder, 'link.md'))).toBe(false)
    expect(await history.snapshot('w1', deep)).toBe(false)
    expect(history.list('w1', join(folder, 'link.md'))).toHaveLength(0)
    expect(history.list('w1', deep)).toHaveLength(0)
  })

  it('keeps a copy of a file a viewer opens, and nothing for a file no viewer opens', async () => {
    const sheet = write('sales.xlsx', Buffer.from('PK workbook one'))
    await history.snapshot('w1', sheet)
    const [version] = history.list('w1', sheet)
    const content = history.version('w1', sheet, version.id)
    expect(content?.sources).toEqual({})
    expect(readFileSync(content?.file ?? '', 'latin1')).toBe('PK workbook one')
    expect(made).toBe(0)
    const unknown = write('blob.bin', Buffer.from([0, 1, 2]))
    expect(await history.snapshot('w1', unknown)).toBe(false)
    expect(history.list('w1', unknown)).toHaveLength(0)
  })

  it('PRT-C47 previews a version from its stored document, without building it', async () => {
    const path = write('chart.md', 'old text')
    await history.snapshot('w1', path)
    const [version] = history.list('w1', path)
    const file = history.version('w1', path, version.id)?.file ?? ''
    const build = vi.fn(async () => ({ document: 'built', inputs: [] }))
    const served = await previewBuild(history, build)({ file, root: null }, LIGHT)
    expect(build).not.toHaveBeenCalled()
    expect(served.document).toBe('<pre>old text</pre>')
    await previewBuild(history, build)({ file: path, root: folder }, LIGHT)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('PRT-C48 restores a version, keeping the current files as a version first', async () => {
    const path = write('plan.md', 'ten minutes ago')
    await history.snapshot('w1', path)
    const [old] = history.list('w1', path)
    clock.now += 600_000
    writeFileSync(path, 'now')
    const before = history.list('w1', path).length
    const result = await history.restore('w1', path, old.id)
    expect(result).toEqual({ restored: ['plan.md'], refused: [] })
    expect(readFileSync(path, 'utf8')).toBe('ten minutes ago')
    const after = history.list('w1', path)
    expect(after.length).toBeGreaterThan(before)
    expect(after.some((v) => history.version('w1', path, v.id)?.sources['plan.md'] === 'now')).toBe(
      true,
    )
  })

  it('PRT-C49 refuses to restore outside the folder or through a symlink', async () => {
    const path = write('plan.md', 'WITH-LIB')
    await history.snapshot('w1', path)
    const [version] = history.list('w1', path)
    const file = history.version('w1', path, version.id)?.file ?? ''
    const raw = readFileSync(file, 'utf8')
    writeFileSync(
      file,
      raw.replace('"lib/part.ts":"part"', '"lib/part.ts":"part","../outside.txt":"escape"'),
    )
    const outside = join(root, 'elsewhere.txt')
    writeFileSync(outside, 'keep me')
    mkdirSync(join(folder, 'lib'))
    symlinkSync(outside, join(folder, 'lib', 'part.ts'))
    writeFileSync(path, 'changed')
    const result = await history.restore('w1', path, version.id)
    expect(result?.restored).toEqual(['plan.md'])
    expect([...(result?.refused ?? [])].sort()).toEqual(['../outside.txt', 'lib/part.ts'])
    expect(existsSync(join(root, 'outside.txt'))).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
    expect(readFileSync(path, 'utf8')).toBe('WITH-LIB')
  })

  it('PRT-C52 moves the history with a closed folder, and with the files of a merge', async () => {
    const path = write('plan.md', 'kept')
    await history.snapshot('w1', path)
    const closed = join(root, '.closed', 'w1-1')
    mkdirSync(closed, { recursive: true })
    history.close('w1', closed)
    expect(existsSync(history.dirOf('w1'))).toBe(false)
    expect(readdirSync(join(closed, '.history'))).toHaveLength(1)
    folder = join(root, 'w1')
    mkdirSync(folder, { recursive: true })
    const again = write('plan.md', 'merged')
    await history.snapshot('w1', again)
    mkdirSync(join(root, 'w2'))
    history.merge('w1', 'w2', [['plan.md', 'plan-2.md']])
    expect(existsSync(history.dirOf('w1'))).toBe(false)
    expect(history.list('w2', join(root, 'w2', 'plan-2.md'))).toHaveLength(1)
  })

  it('PRT-C53 leaves no history of a closed scratch workspace', async () => {
    scratch.add('w1')
    const path = write('plan.md', 'scratch')
    await history.snapshot('w1', path)
    expect(existsSync(history.dirOf('w1'))).toBe(true)
    history.close('w1', null)
    expect(existsSync(history.dirOf('w1'))).toBe(false)
    expect(existsSync(join(root, '.closed'))).toBe(false)
  })

  it('PRT-C50 lists, reads and restores versions only over IPC from the owning window', async () => {
    const path = write('plan.md', 'v1')
    await history.snapshot('w1', path)
    const [version] = history.list('w1', path)
    registerArtifactHistoryIpc({
      history,
      ownsWorkspace: (windowId, id) => windowId === '1' && id === 'w1',
    })
    const handlers = new Map(
      vi.mocked(ipcMain.handle).mock.calls.map(([channel, handler]) => [channel, handler]),
    )
    expect([...handlers.keys()].sort()).toEqual([
      'artifacts:restore',
      'artifacts:version',
      'artifacts:versions',
    ])
    const call = (channel: string, windowId: number, ...args: unknown[]) =>
      (handlers.get(channel) as (...a: unknown[]) => unknown)({ sender: { id: windowId } }, ...args)
    writeFileSync(path, 'v2')
    expect(await call('artifacts:restore', 2, 'w1', path, version.id)).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('v2')
    expect(await call('artifacts:versions', 2, 'w1', path)).toBeNull()
    expect(await call('artifacts:version', 2, 'w1', path, version.id)).toBeNull()
    expect(await call('artifacts:versions', 1, 'w1', path)).toHaveLength(1)
    const sources = readdirSync(join(process.cwd(), 'src', 'main'), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => readFileSync(join(process.cwd(), 'src', 'main', file), 'utf8'))
    const methods = sources.flatMap((text) =>
      [...text.matchAll(/register(?:Control|Targetable)Method\(\s*'([^']+)'/g)].map((m) => m[1]),
    )
    expect(methods.length).toBeGreaterThan(20)
    expect(methods.filter((name) => /version|restore|history/i.test(name))).toEqual([])
  })

  it('PRT-C73 removes a scratch workspace’s history when Ostia quits', async () => {
    scratch.add('w1')
    const path = write('plan.md', 'scratch')
    await history.snapshot('w1', path)
    expect(existsSync(history.dirOf('w1'))).toBe(true)
    history.quit()
    expect(existsSync(history.dirOf('w1'))).toBe(false)
  })

  it('PRT-C74 sweeps at startup the history of a workspace whose folder is gone', async () => {
    const path = write('plan.md', 'kept')
    await history.snapshot('w1', path)
    mkdirSync(join(history.root, 'gone'), { recursive: true })
    writeFileSync(join(history.root, 'gone', 'x'), 'x')
    mkdirSync(join(history.root, 'scratch-1'), { recursive: true })
    expect(history.sweep()).toEqual(
      expect.arrayContaining([join(history.root, 'gone'), join(history.root, 'scratch-1')]),
    )
    expect(existsSync(history.dirOf('w1'))).toBe(true)
    expect(existsSync(join(history.root, 'gone'))).toBe(false)
  })

  it('PRT-C75 leaves nothing when a snapshot is still running as the workspace closes', async () => {
    const path = write('plan.md', 'late')
    let release = (): void => {}
    slowMake = new Promise((resolve) => {
      release = resolve
    })
    const running = history.snapshot('w1', path)
    await vi.advanceTimersByTimeAsync(10)
    history.close('w1', null)
    release()
    expect(await running).toBe(false)
    slowMake = null
    expect(existsSync(history.dirOf('w1'))).toBe(false)
  })

  it('PRT-C79 builds a version for the workspace it belongs to', async () => {
    madeFor.length = 0
    const path = write('plan.md', 'mine')
    await history.snapshot('w1', path)
    expect(madeFor).toEqual(['w1'])
  })

  it('PRT-C80 reads a version whose title holds a >, and names it with an 8-hex hash', async () => {
    titleOf = () => 'a <b> & "c" > d.md'
    const path = write('plan.md', 'odd title')
    await history.snapshot('w1', path)
    titleOf = (file) => basename(file)
    const [version] = history.list('w1', path)
    expect(version.id).toMatch(/^\d+-[0-9a-f]{8}\.html$/)
    const file = history.version('w1', path, version.id)?.file ?? ''
    expect(history.document(file)).toBe('<pre>odd title</pre>')
  })
})
