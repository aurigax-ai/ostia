import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRegularFile, resolvePreviewFile } from './previewFiles'

let base: string
let folder: string
let page: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-preview-test-')))
  folder = join(base, 'site')
  mkdirSync(join(folder, 'assets'), { recursive: true })
  page = join(folder, 'page.html')
  writeFileSync(page, '<!doctype html><title>t</title>')
  writeFileSync(join(folder, 'data.json'), '{"a":1}')
  writeFileSync(join(folder, 'assets', 'app.js'), 'export const a = 1')
  writeFileSync(join(base, 'outside.txt'), 'outside')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('resolvePreviewFile', () => {
  const source = (): { file: string; root: string | null } => ({ file: page, root: folder })

  it('serves the page itself at /', () => {
    expect(resolvePreviewFile(source(), '/')).toMatchObject({ ok: true, path: page })
  })

  it('serves regular files beside the page and below', () => {
    expect(resolvePreviewFile(source(), '/data.json')).toMatchObject({
      ok: true,
      path: join(folder, 'data.json'),
      size: 7,
    })
    expect(resolvePreviewFile(source(), '/assets/app.js')).toMatchObject({ ok: true })
    expect(resolvePreviewFile(source(), '/assets/a%70p.js')).toMatchObject({ ok: true })
  })

  it('refuses a path that leaves the folder', () => {
    for (const path of ['/../outside.txt', '/assets/../../outside.txt', '/%2e%2e/outside.txt']) {
      expect(resolvePreviewFile(source(), path), path).toEqual({ ok: false, status: 404 })
    }
  })

  it('refuses a symlink, and a file reached through a symlinked folder that leaves', () => {
    symlinkSync(join(base, 'outside.txt'), join(folder, 'link.txt'))
    symlinkSync(base, join(folder, 'up'))
    expect(resolvePreviewFile(source(), '/link.txt')).toEqual({ ok: false, status: 404 })
    expect(resolvePreviewFile(source(), '/up/outside.txt')).toEqual({ ok: false, status: 404 })
  })

  it('refuses credential paths, folders, missing files and bad escapes', () => {
    mkdirSync(join(folder, '.ssh'))
    writeFileSync(join(folder, '.ssh', 'id_ed25519'), 'key')
    writeFileSync(join(folder, '.env'), 'A=1')
    writeFileSync(join(folder, '.env.local'), 'A=1')
    for (const path of ['/.ssh/id_ed25519', '/.env', '/.env.local', '/assets', '/nope.js']) {
      expect(resolvePreviewFile(source(), path), path).toEqual({ ok: false, status: 404 })
    }
    expect(resolvePreviewFile(source(), '/%E0%A4%A')).toEqual({ ok: false, status: 400 })
  })

  it('serves only the page when its folder is not a file root', () => {
    const lone = { file: page, root: null }
    expect(resolvePreviewFile(lone, '/')).toMatchObject({ ok: true })
    expect(resolvePreviewFile(lone, '/data.json')).toEqual({ ok: false, status: 404 })
  })
})

describe('reading a resolved preview file', () => {
  const source = (): { file: string; root: string | null } => ({ file: page, root: folder })

  async function readPreview(pathname: string, maxBytes: number) {
    const found = resolvePreviewFile(source(), pathname)
    return found.ok ? readRegularFile(found.path, maxBytes) : found
  }

  it('reads the file it resolved, within what is left of the load', async () => {
    const read = await readPreview('/data.json', 100)
    expect(read.ok && read.body.toString()).toBe('{"a":1}')
    expect(await readPreview('/data.json', 6)).toEqual({ ok: false, status: 413 })
    expect(await readPreview('/../outside.txt', 100)).toEqual({
      ok: false,
      status: 404,
    })
  })

  it('never waits on a FIFO put where a file was, also when it appears after the check', async () => {
    const pipe = join(folder, 'pipe.json')
    execFileSync('mkfifo', [pipe])
    const started = Date.now()
    expect(await readPreview('/pipe.json', 100)).toEqual({ ok: false, status: 404 })
    expect(await readRegularFile(pipe, 100)).toEqual({ ok: false, status: 404 })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('refuses a page that became a symlink after the preview was opened', async () => {
    rmSync(page)
    symlinkSync(join(base, 'outside.txt'), page)
    expect(await readPreview('/', 100)).toEqual({ ok: false, status: 404 })
  })

  it('refuses a file whose folder was replaced by a symlink to somewhere else', async () => {
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'app.js'), 'secret')
    rmSync(join(folder, 'assets'), { recursive: true })
    symlinkSync(elsewhere, join(folder, 'assets'))
    expect(await readPreview('/assets/app.js', 100)).toEqual({
      ok: false,
      status: 404,
    })
  })
})
