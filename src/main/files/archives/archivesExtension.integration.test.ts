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

  it('expands a .tar.xz like a zip and opens an entry, then shows a plain row once disabled', async () => {
    const path = join(files, 'bundle.tar.xz')
    writeFileSync(path, await xz(tarOf(FILES, false)))
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
    expect(readdirSync(files)).toEqual(['bundle.tar.xz'])
    expect(readdirSync(join(dir, 'data', 'archives', 'archive-reads'))).toEqual([])

    const local = localSource(
      () => [files],
      (p) => p,
      (name) => archives.handlesName(name),
    )
    expect(await local.list(files)).toEqual([{ name: 'bundle.tar.xz', dir: false, archive: true }])
    host.processes.setEnabled('archives', false)
    expect(await local.list(files)).toEqual([{ name: 'bundle.tar.xz', dir: false }])
    expect(await archives.list(root)).toEqual([])
  })
})
