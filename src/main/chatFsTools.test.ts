import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatEdit } from '../shared/chatEdits'
import { CHAT_READ_FILE_MAX, CHAT_WRITE_MAX } from '../shared/chatTools'
import {
  listTool,
  planEditTool,
  previewTool,
  readTool,
  searchTool,
  undoTool,
  versionOf,
  writeTool,
} from './chatFsTools'

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

const inFolder = (path: string) => ({ path, root: project, outside: false, symlinks: false })

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
  it('shows the current text and version, then writes and creates files', async () => {
    const path = join(project, 'a.txt')
    const before = await previewTool({ path, root: project }, roots())
    expect(before).toMatchObject({
      ok: true,
      exists: true,
      text: 'one\ntwo\nthree needle\nfour',
      outside: false,
      symlink: false,
    })
    const base = before.ok ? before.version : null
    expect(base).toBe(versionOf('one\ntwo\nthree needle\nfour'))
    expect(await writeTool({ ...inFolder(path), content: 'new', base }, roots())).toMatchObject({
      ok: true,
      created: false,
      bytes: 3,
      version: versionOf('new'),
    })
    expect(readFileSync(path, 'utf8')).toBe('new')
    const fresh = join(project, 'sub', 'b.txt')
    expect(await previewTool({ path: fresh, root: project }, roots())).toMatchObject({
      ok: true,
      exists: false,
      text: '',
      version: null,
    })
    expect(
      await writeTool({ ...inFolder(fresh), content: 'b', base: null }, roots()),
    ).toMatchObject({ ok: true, created: true })
    expect(readFileSync(fresh, 'utf8')).toBe('b')
  })

  it('says a path outside the workspace folder is outside and writes it only when allowed', async () => {
    const path = join(other, 'notes.txt')
    const preview = await previewTool({ path, root: project }, roots())
    expect(preview).toMatchObject({ ok: true, outside: true })
    const base = preview.ok ? preview.version : null
    expect(await writeTool({ ...inFolder(path), content: 'x', base }, roots())).toMatchObject({
      ok: false,
      error: 'outside-folder',
    })
    expect(readFileSync(path, 'utf8')).toBe('private notes')
    expect(
      await writeTool({ ...inFolder(path), outside: true, content: 'x', base }, roots()),
    ).toMatchObject({ ok: true })
    expect(readFileSync(path, 'utf8')).toBe('x')
  })

  it('refuses to write when the file changed, appeared or vanished since the preview', async () => {
    const path = join(project, 'a.txt')
    const stale = versionOf('something else')
    expect(
      await writeTool({ ...inFolder(path), content: 'new', base: stale }, roots()),
    ).toMatchObject({ ok: false, error: 'changed' })
    expect(
      await writeTool({ ...inFolder(path), content: 'new', base: null }, roots()),
    ).toMatchObject({ ok: false, error: 'changed' })
    expect(
      await writeTool(
        { ...inFolder(join(project, 'gone.txt')), content: 'x', base: stale },
        roots(),
      ),
    ).toMatchObject({ ok: false, error: 'changed' })
    expect(readFileSync(path, 'utf8')).toBe('one\ntwo\nthree needle\nfour')
  })

  it('refuses a file symlink, the roots, and a symlinked folder unless the human allowed it', async () => {
    symlinkSync(join(other, 'notes.txt'), join(project, 'l.txt'))
    const link = { ...inFolder(join(project, 'l.txt')), outside: true, content: 'x', base: null }
    expect(await writeTool(link, roots())).toMatchObject({ ok: false, error: 'through-symlink' })
    expect(await writeTool({ ...link, symlinks: true }, roots())).toMatchObject({
      ok: false,
      error: 'not-a-file',
    })
    expect(readFileSync(join(other, 'notes.txt'), 'utf8')).toBe('private notes')
    expect(
      await writeTool(
        { ...inFolder(join(outsideRoots, 'new.txt')), outside: true, content: 'x', base: null },
        roots(),
      ),
    ).toMatchObject({ ok: false, error: 'not-allowed' })
    symlinkSync(outsideRoots, join(project, 'escape'))
    expect(
      await writeTool(
        {
          ...inFolder(join(project, 'escape', 'new.txt')),
          outside: true,
          symlinks: true,
          content: 'x',
          base: null,
        },
        roots(),
      ),
    ).toMatchObject({ ok: false, error: 'not-allowed' })
    mkdirSync(join(project, 'real'))
    symlinkSync(join(project, 'real'), join(project, 'alias'))
    const aliased = join(project, 'alias', 'c.txt')
    expect(await previewTool({ path: aliased, root: project }, roots())).toMatchObject({
      ok: true,
      outside: false,
      symlink: true,
    })
    expect(
      await writeTool({ ...inFolder(aliased), content: 'c', base: null }, roots()),
    ).toMatchObject({ ok: false, error: 'through-symlink' })
    expect(
      await writeTool({ ...inFolder(aliased), symlinks: true, content: 'c', base: null }, roots()),
    ).toMatchObject({ ok: true, created: true })
    expect(readFileSync(join(project, 'real', 'c.txt'), 'utf8')).toBe('c')
  })

  it('refuses content over the size cap', async () => {
    const big = 'x'.repeat(CHAT_WRITE_MAX + 1)
    expect(
      await writeTool({ ...inFolder(join(project, 'big.txt')), content: big, base: null }, roots()),
    ).toMatchObject({ ok: false, error: 'too-large' })
  })

  it('does not treat a workspace folder reached through a symlink as a symlinked write', async () => {
    symlinkSync(project, join(home, 'shortcut'))
    const viaLink = join(home, 'shortcut')
    expect(
      await previewTool({ path: join(viaLink, 'a.txt'), root: viaLink }, roots()),
    ).toMatchObject({ ok: true, outside: false, symlink: false })
  })
})

describe('planEditTool', () => {
  const path = (): string => join(project, 'a.txt')
  const plan = (edits: ChatEdit[], target = path(), outside = false) =>
    planEditTool({ path: target, root: project, edits, outside }, roots())

  it('replaces one unique string and leaves the file untouched', async () => {
    const res = await plan([{ oldText: 'two', newText: '2' }])
    expect(res).toMatchObject({
      ok: true,
      before: 'one\ntwo\nthree needle\nfour',
      after: 'one\n2\nthree needle\nfour',
      outside: false,
      symlink: false,
    })
    expect(readFileSync(path(), 'utf8')).toBe('one\ntwo\nthree needle\nfour')
  })

  it('applies several replacements in order', async () => {
    const res = await plan([
      { oldText: 'one', newText: 'uno' },
      { oldText: 'uno\ntwo', newText: 'uno\ndos' },
    ])
    expect(res.ok && res.after).toBe('uno\ndos\nthree needle\nfour')
  })

  it('says which edit found nothing', async () => {
    expect(
      await plan([
        { oldText: 'one', newText: 'uno' },
        { oldText: 'missing', newText: 'x' },
      ]),
    ).toMatchObject({ ok: false, error: 'no-match', edit: 1 })
  })

  it('refuses text that is not unique unless every match is wanted', async () => {
    writeFileSync(path(), 'a b a b a')
    expect(await plan([{ oldText: 'a', newText: 'c' }])).toMatchObject({
      ok: false,
      error: 'ambiguous',
      edit: 0,
      count: 3,
    })
    const all = await plan([{ oldText: 'a', newText: 'c', replaceAll: true }])
    expect(all.ok && all.after).toBe('c b c b c')
  })

  it('refuses an edit that changes nothing', async () => {
    expect(await plan([{ oldText: 'two', newText: 'two' }])).toMatchObject({
      ok: false,
      error: 'no-change',
    })
  })

  it('matches text written with LF in a CRLF file and keeps CRLF', async () => {
    writeFileSync(path(), 'one\r\ntwo\r\nthree')
    const res = await plan([{ oldText: 'one\ntwo', newText: 'one\n2' }])
    expect(res.ok && res.after).toBe('one\r\n2\r\nthree')
  })

  it('hands back the version of the text it planned on, so a later change stops the write', async () => {
    const planned = await plan([{ oldText: 'two', newText: '2' }])
    if (!planned.ok) throw new Error('no plan')
    const read = await readTool({ path: path(), root: project, outside: false }, roots())
    expect(read.ok && read.version).toBe(planned.version)
    writeFileSync(path(), 'one\ntwo\nchanged by someone else')
    expect(
      await writeTool(
        { ...inFolder(path()), content: planned.after, base: planned.version },
        roots(),
      ),
    ).toMatchObject({ ok: false, error: 'changed' })
    expect(readFileSync(path(), 'utf8')).toBe('one\ntwo\nchanged by someone else')
  })

  it('needs an existing regular text file under the size cap', async () => {
    const edit = [{ oldText: 'a', newText: 'b' }]
    expect(await plan(edit, join(project, 'nope.txt'))).toMatchObject({
      ok: false,
      error: 'not-found',
    })
    symlinkSync(path(), join(project, 'l.txt'))
    expect(await plan(edit, join(project, 'l.txt'))).toMatchObject({
      ok: false,
      error: 'not-a-file',
    })
    writeFileSync(join(project, 'bin'), Buffer.from([97, 0, 98]))
    expect(await plan(edit, join(project, 'bin'))).toMatchObject({
      ok: false,
      error: 'binary',
    })
    writeFileSync(join(project, 'big.txt'), 'a'.repeat(CHAT_WRITE_MAX + 1))
    expect(await plan(edit, join(project, 'big.txt'))).toMatchObject({
      ok: false,
      error: 'too-large',
    })
    writeFileSync(join(project, 'grows.txt'), 'a')
    expect(
      await plan(
        [{ oldText: 'a', newText: 'b'.repeat(CHAT_WRITE_MAX + 1) }],
        join(project, 'grows.txt'),
      ),
    ).toMatchObject({ ok: false, error: 'too-large' })
  })

  it('refuses empty or malformed edit lists and paths outside the roots', async () => {
    expect(await plan([])).toMatchObject({ ok: false, error: 'invalid' })
    expect(await plan([{ oldText: '', newText: 'x' }])).toMatchObject({
      ok: false,
      error: 'invalid',
    })
    expect(
      await plan([{ oldText: 'a', newText: 'b' }], join(outsideRoots, 'secret.txt')),
    ).toMatchObject({ ok: false, error: 'not-allowed' })
  })

  it('tells nothing about a file outside the workspace folder until the human allowed reading it', async () => {
    const outsideFile = join(other, 'notes.txt')
    expect(await plan([{ oldText: 'nope', newText: 'x' }], outsideFile)).toEqual({
      ok: false,
      error: 'outside-folder',
      path: outsideFile,
    })
    expect(
      await plan([{ oldText: 'private', newText: 'public' }], outsideFile, true),
    ).toMatchObject({ ok: true, outside: true })
  })

  it('refuses a text file that is not UTF-8 instead of rewriting its bytes', async () => {
    writeFileSync(path(), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    expect(await plan([{ oldText: 'caf', newText: 'bar' }])).toMatchObject({
      ok: false,
      error: 'binary',
    })
    expect(await previewTool({ path: path(), root: project }, roots())).toMatchObject({
      ok: false,
      error: 'binary',
    })
  })
})

describe('undoTool', () => {
  it('restores the previous content while the file is still what was written', async () => {
    const path = join(project, 'a.txt')
    const wrote = versionOf('one\ntwo\nthree needle\nfour')
    expect(await undoTool({ ...inFolder(path), wrote, restore: 'before' }, roots())).toMatchObject({
      ok: true,
      removed: false,
      version: versionOf('before'),
    })
    expect(readFileSync(path, 'utf8')).toBe('before')
  })

  it('removes a file the chat created', async () => {
    const path = join(project, 'made.txt')
    writeFileSync(path, 'made')
    expect(
      await undoTool({ ...inFolder(path), wrote: versionOf('made'), restore: null }, roots()),
    ).toMatchObject({ ok: true, removed: true, version: null })
    expect(existsSync(path)).toBe(false)
  })

  it('leaves the file alone when it changed or vanished after the write', async () => {
    const path = join(project, 'a.txt')
    expect(
      await undoTool(
        { ...inFolder(path), wrote: versionOf('what pine wrote'), restore: 'x' },
        roots(),
      ),
    ).toMatchObject({ ok: false, error: 'changed' })
    expect(readFileSync(path, 'utf8')).toBe('one\ntwo\nthree needle\nfour')
    expect(
      await undoTool(
        { ...inFolder(join(project, 'gone.txt')), wrote: versionOf('x'), restore: null },
        roots(),
      ),
    ).toMatchObject({ ok: false, error: 'changed' })
  })

  it('stays inside the workspace folder unless the human allowed outside', async () => {
    const path = join(other, 'notes.txt')
    expect(
      await undoTool(
        { ...inFolder(path), wrote: versionOf('private notes'), restore: 'x' },
        roots(),
      ),
    ).toMatchObject({ ok: false, error: 'outside-folder' })
    expect(readFileSync(path, 'utf8')).toBe('private notes')
  })
})
