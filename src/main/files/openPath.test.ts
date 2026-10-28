import { chmodSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: {},
}))

const { canOpenDefault, isProgram, openUnlessProgram } = await import('./openPath')

describe('isProgram', () => {
  it('treats launchers, scripts and executable files as programs', () => {
    expect(isProgram('/h/app.desktop', 0o644, true)).toBe(true)
    expect(isProgram('/h/run.sh', 0o644, true)).toBe(true)
    expect(isProgram('/h/tool', 0o755, true)).toBe(true)
    expect(isProgram('/h/Setup.EXE', 0o644, true)).toBe(true)
  })

  it('treats Windows and macOS launchers as programs, since there the extension is the only guard', () => {
    for (const name of ['a.ps1', 'a.VBS', 'a.hta', 'a.lnk', 'a.url', 'a.reg', 'a.pyw']) {
      expect(isProgram(`/h/${name}`, 0o644, true)).toBe(true)
    }
    for (const name of ['a.fileloc', 'a.webloc', 'a.terminal', 'a.tool', 'a.pkg', 'a.workflow']) {
      expect(isProgram(`/h/${name}`, 0o644, true)).toBe(true)
    }
  })

  it('lets documents and folders through', () => {
    expect(isProgram('/h/notes.md', 0o644, true)).toBe(false)
    expect(isProgram('/h/report.pdf', 0o600, true)).toBe(false)
    expect(isProgram('/h/folder', 0o755, false)).toBe(false)
  })
})

describe('openUnlessProgram', () => {
  let dir: string
  const openPath = vi.fn(async (_path: string) => '')
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-open-path-'))
    openPath.mockClear()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('opens a document and refuses one whose first bytes are a program, for the file menu too', async () => {
    const doc = join(dir, 'report.csv')
    writeFileSync(doc, 'a,b\n1,2\n')
    expect(await openUnlessProgram(doc, statSync(doc), openPath)).toEqual({ ok: true })
    const script = join(dir, 'report2.csv')
    writeFileSync(script, '#!/usr/bin/env python3\n')
    expect(await openUnlessProgram(script, statSync(script), openPath)).toEqual({
      ok: false,
      error: 'program',
    })
    expect(openPath).toHaveBeenCalledTimes(1)
  })

  it('reads a launcher header and a shebang after a BOM, and opens a doc that only mentions them', async () => {
    const write = (name: string, body: string | Buffer): string => {
      const path = join(dir, name)
      writeFileSync(path, body)
      return path
    }
    const refused = [
      write('a.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('#!/bin/sh\n')])),
      write('b.txt', '# tool\r\n\r\n  [Desktop Entry]\r\nExec=sh\r\n'),
    ]
    for (const path of refused) {
      expect(await openUnlessProgram(path, statSync(path), openPath)).toEqual({
        ok: false,
        error: 'program',
      })
    }
    const doc = write('c.md', 'Write a [Desktop Entry] header, or start with #! on line one.\n')
    expect(await openUnlessProgram(doc, statSync(doc), openPath)).toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledTimes(1)
  })

  it('sniffs a hostile file of comment lines at once, without backtracking', async () => {
    const path = join(dir, 'notes.txt')
    writeFileSync(path, `#${'\r\n#'.repeat(100_000)}x`)
    const started = performance.now()
    expect(await openUnlessProgram(path, statSync(path), openPath)).toEqual({ ok: true })
    expect(performance.now() - started).toBeLessThan(1_000)
  }, 5_000)

  it('refuses a file replaced or made executable between the check and the open', async () => {
    const doc = join(dir, 'report.csv')
    writeFileSync(doc, 'a,b\n')
    const checked = statSync(doc)
    const swap = join(dir, 'swap.csv')
    writeFileSync(swap, 'c,d\n')
    renameSync(swap, doc)
    expect(await openUnlessProgram(doc, checked, openPath)).toEqual({
      ok: false,
      error: 'not-found',
    })

    const other = join(dir, 'other.csv')
    writeFileSync(other, 'e,f\n', { mode: 0o644 })
    const before = statSync(other)
    chmodSync(other, 0o600)
    expect(await openUnlessProgram(other, before, openPath)).toEqual({
      ok: false,
      error: 'not-found',
    })
    expect(openPath).not.toHaveBeenCalled()
  })
})

describe('canOpenDefault', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-can-open-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('agrees with openUnlessProgram and launches nothing', async () => {
    const doc = join(dir, 'model.blend')
    writeFileSync(doc, 'BLENDER')
    const script = join(dir, 'setup.exe')
    writeFileSync(script, 'MZ')
    const disguised = join(dir, 'notes.txt')
    writeFileSync(disguised, '#!/bin/sh\n')
    expect(await canOpenDefault(doc, statSync(doc))).toBe(true)
    expect(await canOpenDefault(script, statSync(script))).toBe(false)
    expect(await canOpenDefault(disguised, statSync(disguised))).toBe(false)
  })
})
