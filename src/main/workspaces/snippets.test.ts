import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import {
  loadSnippets,
  parseSnippetFile,
  readSnippetDir,
  registerSnippetIpc,
  SNIPPET_FILE_MAX_BYTES,
  saveSnippet,
  workspaceSnippetsDir,
} from './snippets'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

let base: string
let userDir: string
let workDir: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-snippets-'))
  userDir = join(base, 'config', 'ostia', 'snippets')
  workDir = join(base, 'project')
  mkdirSync(userDir, { recursive: true })
  mkdirSync(workspaceSnippetsDir(workDir), { recursive: true })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const CLONE = `name: Clone a repository
command: git clone {{url}} {{dir}}
description: Clone into a folder
tags: [git]
arguments:
  - name: url
    description: Repository URL
  - name: dir
    default_value: src
`

describe('parseSnippetFile', () => {
  it('reads one snippet, a list, or several YAML documents', () => {
    expect(parseSnippetFile(CLONE)).toMatchObject([
      {
        name: 'Clone a repository',
        arguments: [{ name: 'url' }, { name: 'dir', defaultValue: 'src' }],
      },
    ])
    expect(parseSnippetFile('- {name: a, command: ls}\n- {name: b, command: pwd}\n')).toHaveLength(
      2,
    )
    expect(parseSnippetFile('name: a\ncommand: ls\n---\nname: b\ncommand: pwd\n')).toHaveLength(2)
  })

  it('reports YAML syntax errors and invalid snippets', () => {
    expect(parseSnippetFile('name: [unclosed\n')).toBeInstanceOf(Error)
    expect((parseSnippetFile('- {name: a, command: ls}\n- {name: b}\n') as Error).message).toBe(
      'item 2: missing command',
    )
  })

  it('refuses YAML aliases', () => {
    expect(parseSnippetFile('a: &x ls\nname: n\ncommand: *x\n')).toBeInstanceOf(Error)
  })
})

describe('readSnippetDir', () => {
  it('reads .yaml and .yml files and names each by its file', () => {
    writeFileSync(join(userDir, 'clone.yaml'), CLONE)
    writeFileSync(join(userDir, 'list.yml'), 'name: List\ncommand: ls -la\n')
    writeFileSync(join(userDir, 'notes.txt'), 'name: nope\ncommand: nope\n')
    const listing = readSnippetDir(userDir, 'user')
    expect(listing.problems).toEqual([])
    expect(listing.snippets.map((w) => [w.name, w.origin, w.source])).toEqual([
      ['Clone a repository', 'clone.yaml', 'user'],
      ['List', 'list.yml', 'user'],
    ])
  })

  it('reports a broken file as a problem and still reads the others', () => {
    writeFileSync(join(userDir, 'bad.yaml'), 'name: only a name\n')
    writeFileSync(join(userDir, 'good.yaml'), 'name: Good\ncommand: echo ok\n')
    const listing = readSnippetDir(userDir, 'user')
    expect(listing.snippets.map((w) => w.name)).toEqual(['Good'])
    expect(listing.problems).toEqual([
      { source: 'user', origin: 'bad.yaml', error: 'missing command' },
    ])
  })

  it('skips oversized files and symbolic links', () => {
    writeFileSync(
      join(userDir, 'big.yaml'),
      `name: Big\ncommand: ${'x'.repeat(SNIPPET_FILE_MAX_BYTES)}\n`,
    )
    const outside = join(base, 'outside.yaml')
    writeFileSync(outside, 'name: Outside\ncommand: cat /etc/passwd\n')
    symlinkSync(outside, join(userDir, 'link.yaml'))
    const listing = readSnippetDir(userDir, 'user')
    expect(listing.snippets).toEqual([])
    expect(listing.problems.map((p) => p.origin)).toEqual(['big.yaml', 'link.yaml'])
  })

  it('does not follow a symlinked snippets folder', () => {
    const real = join(base, 'elsewhere')
    mkdirSync(real)
    writeFileSync(join(real, 'x.yaml'), 'name: X\ncommand: ls\n')
    const linked = join(base, 'linked')
    symlinkSync(real, linked)
    expect(readSnippetDir(linked, 'user').snippets).toEqual([])
  })

  it('returns nothing for a missing folder', () => {
    expect(readSnippetDir(join(base, 'missing'), 'user')).toEqual({ snippets: [], problems: [] })
  })
})

describe('loadSnippets', () => {
  it('lists workspace, user, then extension snippets', () => {
    writeFileSync(
      join(workspaceSnippetsDir(workDir), 'test.yaml'),
      'name: Test\ncommand: pnpm test\n',
    )
    writeFileSync(join(userDir, 'clone.yaml'), CLONE)
    const listing = loadSnippets({
      userDir,
      workDir,
      extensions: [
        {
          extId: 'ops',
          snippets: [{ name: 'Deploy', command: 'make deploy', tags: [], arguments: [] }],
        },
      ],
    })
    expect(listing.snippets.map((w) => [w.source, w.origin, w.name])).toEqual([
      ['workspace', 'test.yaml', 'Test'],
      ['user', 'clone.yaml', 'Clone a repository'],
      ['extension', 'ops', 'Deploy'],
    ])
  })

  it('reads only user and extension snippets without a workspace', () => {
    writeFileSync(
      join(workspaceSnippetsDir(workDir), 'test.yaml'),
      'name: Test\ncommand: pnpm test\n',
    )
    expect(loadSnippets({ userDir, extensions: [] }).snippets).toEqual([])
  })
})

describe('saveSnippet', () => {
  it('writes a Warp-format YAML file named after the snippet, private to the user', () => {
    const fresh = join(base, 'fresh', 'snippets')
    const res = saveSnippet(fresh, {
      name: 'Tail a log',
      command: 'tail -f {{file}}',
      arguments: [{ name: 'file', default_value: 'app.log' }],
    })
    expect(res).toEqual({ ok: true, file: 'tail-a-log.yaml' })
    const path = join(fresh, 'tail-a-log.yaml')
    expect(parse(readFileSync(path, 'utf8'))).toEqual({
      name: 'Tail a log',
      command: 'tail -f {{file}}',
      arguments: [{ name: 'file', default_value: 'app.log' }],
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readSnippetDir(fresh, 'user').snippets[0]).toMatchObject({ name: 'Tail a log' })
  })

  it('never overwrites an existing file', () => {
    writeFileSync(join(userDir, 'build.yaml'), 'name: Mine\ncommand: make\n')
    expect(saveSnippet(userDir, { name: 'Build', command: 'make all' })).toEqual({
      ok: true,
      file: 'build-2.yaml',
    })
    expect(readFileSync(join(userDir, 'build.yaml'), 'utf8')).toContain('Mine')
    expect(readdirSync(userDir).sort()).toEqual(['build-2.yaml', 'build.yaml'])
  })

  it('keeps the file inside the snippets folder whatever the name', () => {
    const res = saveSnippet(userDir, { name: '../../../evil', command: 'ls' })
    expect(res).toEqual({ ok: true, file: 'evil.yaml' })
    expect(readdirSync(userDir)).toEqual(['evil.yaml'])
  })

  it('saves a snippet from the dialog next to the existing ones and lists it', () => {
    writeFileSync(join(userDir, 'greet.yaml'), 'name: Greet someone\ncommand: echo hi\n')
    registerSnippetIpc({
      userDir,
      roots: () => [base],
      workDirForWorkspace: () => undefined,
      extensionSnippets: () => [],
    })
    const handler = (channel: string) =>
      vi.mocked(ipcMain.handle).mock.calls.find(([c]) => c === channel)?.[1] as (
        e: unknown,
        arg: unknown,
      ) => unknown

    expect(
      handler('snippets:save')(null, {
        name: 'Greet again',
        command: 'echo again_{{name}}',
        arguments: [{ name: 'name', default_value: 'ostia' }],
      }),
    ).toEqual({ ok: true, file: 'greet-again.yaml' })
    expect(readdirSync(userDir).sort()).toEqual(['greet-again.yaml', 'greet.yaml'])
    expect(readFileSync(join(userDir, 'greet-again.yaml'), 'utf8')).toBe(
      'name: Greet again\ncommand: echo again_{{name}}\narguments:\n  - name: name\n    default_value: ostia\n',
    )
    expect(
      (handler('snippets:list')(null, null) as ReturnType<typeof loadSnippets>).snippets.map(
        (w) => w.name,
      ),
    ).toEqual(['Greet again', 'Greet someone'])
  })

  it('refuses an invalid snippet', () => {
    expect(saveSnippet(userDir, { name: 'x' })).toEqual({ ok: false, error: 'missing command' })
    expect(readdirSync(userDir)).toEqual([])
  })
})
