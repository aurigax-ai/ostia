import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHAT_READ_FILE_MAX } from '../shared/chatTools'
import { listTool, previewTool, readTool, searchTool, writeTool } from './chatFsTools'

let base: string
let home: string
let project: string
let other: string
let outsideRoots: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pine-chat-fs-'))
  home = join(base, 'home')
  project = join(home, 'project')
  other = join(home, 'other')
  outsideRoots = join(base, 'elsewhere')
  for (const dir of [project, other, outsideRoots, join(project, 'node_modules', 'x')]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(project, 'a.txt'), 'one\ntwo\nthree needle\nfour')
  writeFileSync(join(project, 'node_modules', 'x', 'dep.txt'), 'needle in a dependency')
  writeFileSync(join(other, 'notes.txt'), 'private notes')
  writeFileSync(join(outsideRoots, 'secret.txt'), 'not for the assistant')
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

const roots = (): string[] => [home]

describe('readTool', () => {
  it('reads a file inside the workspace folder with line bounds', async () => {
    const res = await readTool(
      { path: join(project, 'a.txt'), root: project, outside: false, offset: 2, limit: 2 },
      roots(),
    )
    expect(res).toMatchObject({ ok: true, text: 'two\nthree needle', startLine: 2, endLine: 3 })
    expect(res.ok && res.truncated).toBe(true)
  })

  it('needs the outside flag for a file outside the workspace folder', async () => {
    const target = { path: join(other, 'notes.txt'), root: project }
    expect(await readTool({ ...target, outside: false }, roots())).toMatchObject({
      ok: false,
      error: 'outside-folder',
    })
    expect(await readTool({ ...target, outside: true }, roots())).toMatchObject({
      ok: true,
      text: 'private notes',
    })
  })

  it('never reads outside the allowed roots, also through a symlink or ..', async () => {
    const direct = { path: join(outsideRoots, 'secret.txt'), root: project, outside: true }
    expect(await readTool(direct, roots())).toMatchObject({ ok: false, error: 'not-allowed' })
    symlinkSync(join(outsideRoots, 'secret.txt'), join(project, 'link.txt'))
    const linked = { path: join(project, 'link.txt'), root: project, outside: true }
    expect(await readTool(linked, roots())).toMatchObject({ ok: false, error: 'not-allowed' })
    const dotdot = { path: `${project}/../../elsewhere/secret.txt`, root: project, outside: true }
    expect(await readTool(dotdot, roots())).toMatchObject({ ok: false, error: 'not-allowed' })
  })

  it('treats a symlink that leaves the workspace folder as outside it', async () => {
    symlinkSync(join(other, 'notes.txt'), join(project, 'notes-link.txt'))
    const req = { path: join(project, 'notes-link.txt'), root: project, outside: false }
    expect(await readTool(req, roots())).toMatchObject({ ok: false, error: 'outside-folder' })
  })

  it('refuses relative paths, binary files and files over the cap', async () => {
    expect(await readTool({ path: 'a.txt', root: project, outside: false }, roots())).toMatchObject(
      { ok: false, error: 'invalid' },
    )
    writeFileSync(join(project, 'bin'), Buffer.from([1, 0, 2]))
    expect(
      await readTool({ path: join(project, 'bin'), root: project, outside: false }, roots()),
    ).toMatchObject({ ok: false, error: 'binary' })
    writeFileSync(join(project, 'big'), Buffer.alloc(CHAT_READ_FILE_MAX + 1, 97))
    expect(
      await readTool({ path: join(project, 'big'), root: project, outside: false }, roots()),
    ).toMatchObject({ ok: false, error: 'too-large' })
  })
})

describe('listTool and searchTool', () => {
  it('lists folders first', async () => {
    const res = await listTool({ path: project, root: project, outside: false }, roots())
    expect(res.ok && res.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'dir:node_modules',
      'file:a.txt',
    ])
  })

  it('finds names and contents but skips node_modules', async () => {
    const res = await searchTool(
      { path: project, root: project, outside: false, query: 'NEEDLE' },
      roots(),
    )
    expect(res.ok && res.matches).toEqual([{ path: 'a.txt', line: 3, text: 'three needle' }])
  })
})

describe('previewTool and writeTool', () => {
  it('shows the current text, then writes and creates files', async () => {
    const path = join(project, 'a.txt')
    expect(await previewTool({ path, root: project, outside: true }, roots())).toMatchObject({
      ok: true,
      exists: true,
      text: 'one\ntwo\nthree needle\nfour',
    })
    expect(
      await writeTool({ path, root: project, outside: true, content: 'new' }, roots()),
    ).toMatchObject({ ok: true, created: false, bytes: 3 })
    expect(readFileSync(path, 'utf8')).toBe('new')
    const fresh = join(project, 'sub', 'b.txt')
    expect(await previewTool({ path: fresh, root: project, outside: true }, roots())).toMatchObject(
      { ok: true, exists: false, text: '' },
    )
    expect(
      await writeTool({ path: fresh, root: project, outside: true, content: 'b' }, roots()),
    ).toMatchObject({ ok: true, created: true })
    expect(readFileSync(fresh, 'utf8')).toBe('b')
  })

  it('refuses to write through a symlink or outside the roots', async () => {
    symlinkSync(join(other, 'notes.txt'), join(project, 'l.txt'))
    expect(
      await writeTool(
        { path: join(project, 'l.txt'), root: project, outside: true, content: 'x' },
        roots(),
      ),
    ).toMatchObject({ ok: false, error: 'not-a-file' })
    expect(readFileSync(join(other, 'notes.txt'), 'utf8')).toBe('private notes')
    expect(
      await writeTool(
        { path: join(outsideRoots, 'new.txt'), root: project, outside: true, content: 'x' },
        roots(),
      ),
    ).toMatchObject({ ok: false, error: 'not-allowed' })
    symlinkSync(outsideRoots, join(project, 'escape'))
    expect(
      await writeTool(
        { path: join(project, 'escape', 'new.txt'), root: project, outside: true, content: 'x' },
        roots(),
      ),
    ).toMatchObject({ ok: false, error: 'not-allowed' })
  })
})
