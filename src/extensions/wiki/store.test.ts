import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_BODY_BYTES,
  deletePage,
  getPage,
  listPages,
  searchPages,
  setPage,
  wikiPath,
} from './store'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pine-wiki-'))
  path = join(dir, 'wiki.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('wiki store', () => {
  it('scopes project pages to the workDir and refuses a project scope without one', () => {
    expect(wikiPath('project', dir)).toBe(join(dir, '.pine', 'wiki.json'))
    expect(wikiPath('project', undefined)).toMatchObject({ ok: false, error: 'no-project-workdir' })
    expect(typeof wikiPath('global', undefined)).toBe('string')
  })

  it('round-trips pages through set/get/list/search/delete', () => {
    expect(setPage(path, 'setup', 'install **pine** first', 'Setup')).toEqual({ ok: true })
    expect(getPage(path, 'setup')).toMatchObject({ slug: 'setup', title: 'Setup' })
    expect(listPages(path).map((p) => p.slug)).toEqual(['setup'])
    expect(searchPages(path, 'PINE')).toEqual([
      { slug: 'setup', title: 'Setup', snippet: 'install **pine** first' },
    ])
    expect(deletePage(path, 'setup')).toEqual({ ok: true })
    expect(getPage(path, 'setup')).toEqual({ ok: false, error: 'not-found' })
  })

  it('rejects prototype slugs and oversized bodies', () => {
    expect(setPage(path, '__proto__', 'x', undefined)).toEqual({ ok: false, error: 'invalid-slug' })
    expect(setPage(path, 'a.constructor', 'x', undefined)).toEqual({
      ok: false,
      error: 'invalid-slug',
    })
    expect(setPage(path, 'big', 'x'.repeat(MAX_BODY_BYTES + 1), undefined)).toEqual({
      ok: false,
      error: 'too-large',
    })
  })

  it('does not resolve inherited keys as pages', () => {
    writeFileSync(path, '{"__proto__":{"title":"x","body":"y","updatedAt":""}}')
    expect(getPage(path, 'toString')).toEqual({ ok: false, error: 'not-found' })
    expect(listPages(path)).toEqual([])
  })
})
