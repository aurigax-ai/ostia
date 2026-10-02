import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expandTemplate, openInExternalEditor, resolveEditorTemplate } from './externalEditor'

describe('expandTemplate', () => {
  it('substitutes file, line and column inside a single argument', () => {
    expect(
      expandTemplate('code -g {file}:{line}:{column}', { file: '/a/b.ts', line: 12, column: 3 }),
    ).toEqual(['code', '-g', '/a/b.ts:12:3'])
  })

  it('keeps a hostile path as one literal argv element (no shell parsing)', () => {
    const file = '/tmp/x; rm -rf ~ $(whoami) `id` "q" {line}.txt'
    const argv = expandTemplate('code -g {file}:{line}', { file, line: 7 })
    expect(argv).toEqual(['code', '-g', `${file}:7`])
  })

  it('defaults line and column to 1 when missing or invalid', () => {
    expect(expandTemplate('zed {file}:{line}:{column}', { file: '/f', line: 0 })).toEqual([
      'zed',
      '/f:1:1',
    ])
  })

  it('appends the file when the template has no {file}', () => {
    expect(expandTemplate('gedit', { file: '/with space/f.txt' })).toEqual([
      'gedit',
      '/with space/f.txt',
    ])
  })

  it('rejects an empty or malformed template', () => {
    expect(expandTemplate('   ', { file: '/f' })).toBeNull()
    expect(expandTemplate("code '{file}", { file: '/f' })).toBeNull()
  })
})

describe('resolveEditorTemplate', () => {
  const onPath = (bins: string[]) => (p: string) => bins.some((b) => p === `/bin/${b}`)

  it('auto-detects code before cursor and zed', () => {
    expect(resolveEditorTemplate('auto', '/usr/local/bin:/bin', onPath(['zed', 'code']))).toBe(
      'code -g {file}:{line}:{column}',
    )
    expect(resolveEditorTemplate('auto', '/bin', onPath(['zed']))).toBe(
      'zed {file}:{line}:{column}',
    )
  })

  it('returns null when auto finds nothing or the setting is empty', () => {
    expect(resolveEditorTemplate('auto', '/bin', onPath([]))).toBeNull()
    expect(resolveEditorTemplate('  ', '/bin', onPath(['code']))).toBeNull()
  })

  it('uses a custom template verbatim', () => {
    expect(resolveEditorTemplate('nvim +{line} {file}', '', onPath([]))).toBe('nvim +{line} {file}')
  })
})

describe('openInExternalEditor', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('refuses a relative path', async () => {
    expect(await openInExternalEditor({ template: 'true', file: 'rel.txt' })).toEqual({
      ok: false,
      error: 'invalid-path',
    })
  })

  it('reports no-editor for an empty setting', async () => {
    expect(await openInExternalEditor({ template: '', file: '/f' })).toEqual({
      ok: false,
      error: 'no-editor',
    })
  })

  it('spawns the program with argv and reports what it ran', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pine-ext-editor-'))
    const out = join(dir, 'args.txt')
    const script = join(dir, 'fake-editor')
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\n`)
    chmodSync(script, 0o755)
    const file = join(dir, 'a b; echo pwned.txt')
    const res = await openInExternalEditor({
      template: `${script} -g {file}:{line}`,
      file,
      line: 4,
    })
    expect(res).toEqual({ ok: true, argv: [script, '-g', `${file}:4`] })
    for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 20))
    expect(readFileSync(out, 'utf8')).toBe(`-g\n${file}:4\n`)
  })

  it('reports spawn-failed for a missing program', async () => {
    const res = await openInExternalEditor({ template: '/nonexistent/editor {file}', file: '/f' })
    expect(res).toMatchObject({ ok: false, error: 'spawn-failed' })
  })
})
