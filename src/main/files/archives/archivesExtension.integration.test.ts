import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { XzCompressor } from '@napi-rs/lzma'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tarOf } from '../../../../test/fixtures/archives/archives'
import { archiveRoot } from '../../../shared/archives/archivePaths'
import type { CommandResult } from '../../../shared/control/commands'
import { registerControlServer, stopControlServer } from '../../control/controlServer'
import { ExtensionHost } from '../../extensions/extensionHost'
import { registerExtensionMethods } from '../../extensions/extensionMethods'
import { ExtensionStore } from '../../extensions/extensionStore'
import { localSource } from '../fileSources'
import { Archives } from './archives'
import { ExtensionReaders } from './extensionReader'

const builtinExtensions = resolve(__dirname, '../../../../out/extensions')
const FILES = [
  { name: 'docs/readme.txt', data: 'hello' },
  { name: 'docs/deep/note.md', data: '# note' },
  { name: 'top.csv', data: 'a,b' },
]

async function bzip2(bytes: Uint8Array): Promise<Buffer> {
  return execFileSync('bzip2', ['-9', '-c'], { input: bytes })
}

async function xz(bytes: Uint8Array): Promise<Buffer> {
  const compressor = new XzCompressor({ preset: 0 })
  return Buffer.concat([compressor.update(bytes), await compressor.finish()])
}

describe('the built-in archives extension behind Files (real process, real socket)', () => {
  let dir: string
  let files: string
  let host: ExtensionHost
  let archives: Archives

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-archives-ext-'))
    files = join(dir, 'files')
    mkdirSync(files)
    const socketPath = join(dir, 'control.sock')
    host = new ExtensionHost({
      roots: [{ dir: builtinExtensions, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      dataDir: join(dir, 'data'),
      workDirForWorkspace: () => undefined,
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      readyTimeoutMs: 8000,
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
    const readers = new ExtensionReaders(() => host.archives)
    archives = new Archives(
      (path) => (path.startsWith(`${files}/`) ? path : null),
      undefined,
      readers,
    )
  })

  afterAll(() => {
    host.processes.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['bundle.tar.xz', xz],
    ['bundle.tar.bz2', bzip2],
  ])('expands %s like a zip and opens an entry without extracting it', async (name, compress) => {
    const path = join(files, name)
    writeFileSync(path, await compress(tarOf(FILES, false)))
    const root = archiveRoot(path)
    expect(await archives.list(root)).toEqual([
      { name: 'docs', dir: true },
      { name: 'top.csv', dir: false },
    ])
    expect(await archives.list(`${root}/docs`)).toEqual([
      { name: 'deep', dir: true },
      { name: 'readme.txt', dir: false },
    ])
    expect(await archives.readText(`${root}/docs/deep/note.md`, 1024)).toMatchObject({
      ok: true,
      text: '# note',
    })
    expect(readdirSync(files)).toContain(name)
    expect(readdirSync(join(dir, 'data', 'archives', 'archive-reads'))).toEqual([])
  })

  it('shows plain rows for its archives once it is disabled', async () => {
    const local = localSource(
      () => [files],
      (p) => p,
      (name) => archives.handlesName(name),
    )
    expect(await local.list(files)).toEqual([
      { name: 'bundle.tar.bz2', dir: false, archive: true },
      { name: 'bundle.tar.xz', dir: false, archive: true },
    ])
    host.processes.setEnabled('archives', false)
    expect(await local.list(files)).toEqual([
      { name: 'bundle.tar.bz2', dir: false },
      { name: 'bundle.tar.xz', dir: false },
    ])
    expect(await archives.list(archiveRoot(join(files, 'bundle.tar.xz')))).toEqual([])
  })
})
