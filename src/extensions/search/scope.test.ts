import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ExtensionCaller } from '../sdk'
import { agentRoot, formatMatches, insideRoot, panelQuery } from './scope'

const dir = mkdtempSync(join(tmpdir(), 'ostia-search-scope-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const pane = (extra: Partial<ExtensionCaller>): ExtensionCaller => ({
  kind: 'pane',
  capabilities: ['read-board'],
  ...extra,
})

describe('agentRoot', () => {
  it('searches from the caller cwd', () => {
    expect(agentRoot(pane({ cwd: dir, workDir: '/elsewhere' }))).toBe(dir)
  })

  it('refuses a sandboxed caller, whose files the host must not read for it', () => {
    expect(agentRoot(pane({ cwd: dir, sandboxed: true }))).toMatchObject({
      ok: false,
      error: 'sandboxed',
    })
  })

  it('refuses a caller in a remote shell', () => {
    const remote = pane({ cwd: dir, remote: { host: 'box', path: '/srv' } as never })
    expect(agentRoot(remote)).toMatchObject({ ok: false, error: 'remote-folder' })
  })

  it('refuses a folder that does not exist', () => {
    expect(agentRoot(pane({ cwd: join(dir, 'gone') }))).toMatchObject({
      ok: false,
      error: 'no-folder',
    })
  })
})

describe('insideRoot', () => {
  it('resolves a relative path inside the folder', () => {
    expect(insideRoot('/w', 'src/a.ts')).toBe('/w/src/a.ts')
  })

  it('refuses an absolute path, a path that climbs out and the folder itself', () => {
    expect(insideRoot('/w', '/etc/passwd')).toBeNull()
    expect(insideRoot('/w', '../x')).toBeNull()
    expect(insideRoot('/w', 'a/../../x')).toBeNull()
    expect(insideRoot('/w', '.')).toBeNull()
    expect(insideRoot('/w', 7)).toBeNull()
  })
})

describe('panelQuery', () => {
  it('keeps only true switches and non-empty globs', () => {
    expect(
      panelQuery({ text: 'x', regex: 'yes', include: ['src/**', ' ', 3], exclude: 'dist' }),
    ).toEqual({
      text: 'x',
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      include: ['src/**'],
      exclude: [],
    })
  })

  it('refuses an empty or oversized text', () => {
    expect(panelQuery({ text: '' })).toBeNull()
    expect(panelQuery({ text: 'x'.repeat(1001) })).toBeNull()
  })
})

describe('formatMatches', () => {
  it('prints one grep-style line per match and a count', () => {
    const text = formatMatches({
      files: [{ path: 'a.ts', matches: [{ line: 3, column: 5, text: 'let x', ranges: [] }] }],
      matches: 1,
      truncated: false,
    })
    expect(text).toBe('a.ts:3:5: let x\n1 match in 1 file')
  })

  it('says when it stopped early', () => {
    const text = formatMatches({ files: [], matches: 0, truncated: true })
    expect(text).toContain('No matches')
    expect(text).toContain('Stopped at')
  })
})
