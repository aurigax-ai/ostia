import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ArchiveRequest } from '@aurigax-ai/ostia-extension-sdk/contract/archiveReaders'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { archiveRoot } from '../../../shared/archives/archivePaths'
import type { CommandResult } from '../../../shared/control/commands'
import { registerControlServer, stopControlServer } from '../../control/controlServer'
import { ExtensionHost } from '../../extensions/extensionHost'
import { registerExtensionMethods } from '../../extensions/extensionMethods'
import { ExtensionStore } from '../../extensions/extensionStore'
import { localSource } from '../fileSources'
import { ARCHIVE_LIMITS } from './archiveTree'
import { Archives } from './archives'
import { ExtensionReaders } from './extensionReader'

const fixtures = resolve(__dirname, '../../../../test/fixtures/extensions-archives')
const POLL = { timeout: 8000, interval: 20 }
const SCAN_MS = 400
const GRACE_MS = 300
const LIMITS = { ...ARCHIVE_LIMITS, scanMs: SCAN_MS }

describe('archives read by an extension (real extension process, real socket)', () => {
  let dir: string
  let files: string
  let dataDir: string
  let host: ExtensionHost
  let archives: Archives

  const status = (): string | undefined => host.list().find((e) => e.id === 'fakearc')?.status

  function put(name: string): string {
    const path = join(files, name)
    writeFileSync(path, name)
    return path
  }

  async function asked(): Promise<ArchiveRequest[]> {
    const res = await host.invoke('fakearc', 'asked', null, host.userCaller(null))
    return res.ok ? (res.data as ArchiveRequest[]) : []
  }

  function fresh(): Archives {
    const readers = new ExtensionReaders(() => host.archives, {
      readMs: SCAN_MS,
      listChars: 300_000,
    })
    return new Archives((path) => (path.startsWith(`${files}/`) ? path : null), LIMITS, readers)
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-archives-'))
    files = join(dir, 'files')
    dataDir = join(dir, 'data')
    mkdirSync(files)
    const socketPath = join(dir, 'control.sock')
    host = new ExtensionHost({
      roots: [{ dir: fixtures, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      dataDir,
      workDirForWorkspace: () => undefined,
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      restartDelayMs: 500,
      readyTimeoutMs: 8000,
      requestTimeoutMs: 4000,
      archiveKillGraceMs: GRACE_MS,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
        isSandboxed: () => false,
      },
      socketPath,
    )
  })

  afterAll(() => {
    host.processes.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    archives = fresh()
    if (status() !== 'running' && status() !== 'idle') host.processes.setEnabled('fakearc', true)
    await asked()
  })

  it('lists and opens entries through the reader, and the read file is gone afterwards', async () => {
    const root = archiveRoot(put('tree.fake'))
    expect(await archives.list(root)).toEqual([
      { name: 'docs', dir: true },
      { name: 'top.csv', dir: false },
    ])
    expect(await archives.list(`${root}/docs`)).toEqual([{ name: 'readme.txt', dir: false }])
    const read = await archives.readText(`${root}/docs/readme.txt`, 1024)
    expect(read).toMatchObject({ ok: true, text: 'hello' })
    const requests = await asked()
    expect(requests.map((r) => r.op)).toEqual(['list', 'read'])
    const [listed, opened] = requests
    expect(listed).toEqual({
      op: 'list',
      reader: 'fake',
      archive: join(files, 'tree.fake'),
      limits: LIMITS,
    })
    if (opened.op !== 'read') throw new Error('not a read')
    expect(opened).toMatchObject({ index: 1, max: 1024, limits: LIMITS })
    expect(opened.out.startsWith(join(dataDir, 'fakearc', 'archive-reads'))).toBe(true)
    expect(readdirSync(join(dataDir, 'fakearc', 'archive-reads'))).toEqual([])
  })

  it('caps the entries and the depth and shows hostile names literally', async () => {
    const huge = await archives.list(archiveRoot(put('huge.fake')))
    expect(huge).toHaveLength(ARCHIVE_LIMITS.entries)
    let path = archiveRoot(put('deep.fake'))
    for (let level = 0; level < ARCHIVE_LIMITS.depth - 1; level++) {
      const [only] = await archives.list(path)
      expect(only?.dir).toBe(true)
      path = `${path}/${only?.name}`
    }
    expect(await archives.list(path)).toEqual([{ name: 'd31／d32／x.txt', dir: false }])
    const names = await archives.list(archiveRoot(put('names.fake')))
    expect(names.map((e) => e.name)).toEqual(['..', 'abs', 'bell\\u0007.txt'])
  })

  it('refuses a listing that is too long, malformed or failed', async () => {
    for (const name of ['wide.fake', 'bad.fake', 'failed.fake']) {
      expect(await archives.list(archiveRoot(put(name))), name).toEqual([])
    }
  })

  it('answers links, encrypted and oversized entries itself without asking the reader', async () => {
    const root = archiveRoot(put('special.fake'))
    await archives.list(root)
    await asked()
    expect(await archives.readText(`${root}/passwd`, 1024)).toEqual({
      ok: false,
      error: 'archive',
      reason: 'link',
    })
    expect(await archives.readText(`${root}/secret.txt`, 1024)).toEqual({
      ok: false,
      error: 'archive',
      reason: 'encrypted',
    })
    expect(await archives.readBinary(`${root}/big.bin`, 1024)).toEqual({
      ok: false,
      error: 'too-large',
      size: 1024 * 1024 * 1024,
    })
    expect(await asked()).toEqual([])
  })

  it('refuses a read result that is a link, a fifo, the wrong size, too large or elsewhere', async () => {
    for (const name of ['symlink', 'fifo', 'liar', 'over', 'elsewhere']) {
      const root = archiveRoot(put(`${name}.fake`))
      expect(await archives.readBinary(`${root}/docs/readme.txt`, 64), name).toEqual({
        ok: false,
        error: 'unreadable',
      })
    }
    const left = readdirSync(join(dataDir, 'fakearc', 'archive-reads'))
    expect(left.filter((name) => !name.endsWith('.x'))).toEqual([])
    expect(await archives.readBinary(`${archiveRoot(put('gone.fake'))}/top.csv`, 64)).toEqual({
      ok: false,
      error: 'archive',
      reason: 'gone',
    })
    expect(await archives.readBinary(`${archiveRoot(put('bomb.fake'))}/top.csv`, 64)).toEqual({
      ok: false,
      error: 'archive',
      reason: 'unzip-limit',
    })
  })

  it('refuses a read result when the reads folder was swapped for a link', async () => {
    const reads = join(dataDir, 'fakearc', 'archive-reads')
    const root = archiveRoot(put('dirlink.fake'))
    expect(await archives.readBinary(`${root}/docs/readme.txt`, 64)).toEqual({
      ok: false,
      error: 'unreadable',
    })
    rmSync(reads, { force: true })
    rmSync(`${reads}-other`, { recursive: true, force: true })
  })

  it('marks a listing the reader cut short and asks again after a failure', async () => {
    expect(await archives.list(archiveRoot(put('partial.fake')))).toEqual([
      { name: 'first.txt', dir: false },
    ])
    const root = archiveRoot(put('slow.fake'))
    expect(await archives.list(root)).toEqual([{ name: 'early.txt', dir: false }])
  })

  it('cancels a reader that does not answer, then stops it without spending a restart', async () => {
    let gap = 0
    let last = Date.now()
    const tick = setInterval(() => {
      gap = Math.max(gap, Date.now() - last)
      last = Date.now()
    }, 20)
    try {
      for (const name of ['hang1.fake', 'hang2.fake', 'hang3.fake', 'hang4.fake']) {
        const started = Date.now()
        expect(await archives.list(archiveRoot(put(name))), name).toEqual([])
        expect(Date.now() - started).toBeGreaterThanOrEqual(SCAN_MS + GRACE_MS - 50)
      }
      expect(await archives.readBinary(`${archiveRoot(put('stuck.fake'))}/top.csv`, 64)).toEqual({
        ok: false,
        error: 'unreadable',
      })
    } finally {
      clearInterval(tick)
    }
    expect(gap).toBeLessThan(250)
    expect(await archives.list(archiveRoot(put('tree.fake')))).toHaveLength(2)
    expect(status()).toBe('running')
  })

  it('fails while the reader restarts, keeps the cached tree, and shows plain rows once it is off', async () => {
    const local = localSource(
      () => [files],
      (path) => path,
      (name) => archives.handlesName(name),
    )
    const tree = archiveRoot(put('tree.fake'))
    expect(await archives.list(tree)).toHaveLength(2)
    expect(await local.list(files)).toContainEqual({ name: 'tree.fake', dir: false, archive: true })
    await archives.list(archiveRoot(put('crash.fake')))
    await vi.waitUntil(() => host.processes.isRunning('fakearc') === false, POLL)
    expect(await archives.list(archiveRoot(put('partial.fake')))).toEqual([])
    expect(await archives.list(tree)).toHaveLength(2)
    await vi.waitUntil(() => status() === 'running', POLL)
    expect(await archives.list(archiveRoot(put('partial.fake')))).toHaveLength(1)

    host.processes.setEnabled('fakearc', false)
    expect(await local.list(files)).toContainEqual({ name: 'tree.fake', dir: false })
    expect(await archives.list(tree)).toEqual([])
    host.processes.setEnabled('fakearc', true)
    expect(await archives.list(tree)).toHaveLength(2)
  })

  it('shows plain rows once the reader crashed for good', async () => {
    const local = localSource(
      () => [files],
      (path) => path,
      (name) => archives.handlesName(name),
    )
    for (let round = 0; round < 4; round++) {
      await vi.waitUntil(() => status() === 'running' || status() === 'idle', POLL)
      await archives.list(archiveRoot(put(`crash${round}.fake`)))
      await vi.waitUntil(() => !host.processes.isRunning('fakearc'), POLL)
    }
    await vi.waitUntil(() => status() === 'crashed', POLL)
    expect(await local.list(files)).toContainEqual({ name: 'tree.fake', dir: false })
    expect(archives.handlesName('tree.fake')).toBe(false)
    expect(existsSync(join(dataDir, 'fakearc'))).toBe(true)
  })
})
