import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  WORKFLOW_FILE_MAX_BYTES,
  legacyWorkspaceWorkflowsDir,
  loadWorkflows,
  parseWorkflowFile,
  readWorkflowDir,
  saveWorkflow,
  workspaceWorkflowsDir,
} from './workflows'

let base: string
let userDir: string
let workDir: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-workflows-'))
  userDir = join(base, 'config', 'ostia', 'workflows')
  workDir = join(base, 'project')
  mkdirSync(userDir, { recursive: true })
  mkdirSync(workspaceWorkflowsDir(workDir), { recursive: true })
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

describe('parseWorkflowFile', () => {
  it('reads one workflow, a list, or several YAML documents', () => {
    expect(parseWorkflowFile(CLONE)).toMatchObject([
      {
        name: 'Clone a repository',
        arguments: [{ name: 'url' }, { name: 'dir', defaultValue: 'src' }],
      },
    ])
    expect(parseWorkflowFile('- {name: a, command: ls}\n- {name: b, command: pwd}\n')).toHaveLength(
      2,
    )
    expect(parseWorkflowFile('name: a\ncommand: ls\n---\nname: b\ncommand: pwd\n')).toHaveLength(2)
  })

  it('reports YAML syntax errors and invalid workflows', () => {
    expect(parseWorkflowFile('name: [unclosed\n')).toBeInstanceOf(Error)
    expect((parseWorkflowFile('- {name: a, command: ls}\n- {name: b}\n') as Error).message).toBe(
      'item 2: missing command',
    )
  })

  it('refuses YAML aliases', () => {
    expect(parseWorkflowFile('a: &x ls\nname: n\ncommand: *x\n')).toBeInstanceOf(Error)
  })
})

describe('readWorkflowDir', () => {
  it('reads .yaml and .yml files and names each by its file', () => {
    writeFileSync(join(userDir, 'clone.yaml'), CLONE)
    writeFileSync(join(userDir, 'list.yml'), 'name: List\ncommand: ls -la\n')
    writeFileSync(join(userDir, 'notes.txt'), 'name: nope\ncommand: nope\n')
    const listing = readWorkflowDir(userDir, 'user')
    expect(listing.problems).toEqual([])
    expect(listing.workflows.map((w) => [w.name, w.origin, w.source])).toEqual([
      ['Clone a repository', 'clone.yaml', 'user'],
      ['List', 'list.yml', 'user'],
    ])
  })

  it('reports a broken file as a problem and still reads the others', () => {
    writeFileSync(join(userDir, 'bad.yaml'), 'name: only a name\n')
    writeFileSync(join(userDir, 'good.yaml'), 'name: Good\ncommand: echo ok\n')
    const listing = readWorkflowDir(userDir, 'user')
    expect(listing.workflows.map((w) => w.name)).toEqual(['Good'])
    expect(listing.problems).toEqual([
      { source: 'user', origin: 'bad.yaml', error: 'missing command' },
    ])
  })

  it('skips oversized files and symbolic links', () => {
    writeFileSync(
      join(userDir, 'big.yaml'),
      `name: Big\ncommand: ${'x'.repeat(WORKFLOW_FILE_MAX_BYTES)}\n`,
    )
    const outside = join(base, 'outside.yaml')
    writeFileSync(outside, 'name: Outside\ncommand: cat /etc/passwd\n')
    symlinkSync(outside, join(userDir, 'link.yaml'))
    const listing = readWorkflowDir(userDir, 'user')
    expect(listing.workflows).toEqual([])
    expect(listing.problems.map((p) => p.origin)).toEqual(['big.yaml', 'link.yaml'])
  })

  it('does not follow a symlinked workflows folder', () => {
    const real = join(base, 'elsewhere')
    mkdirSync(real)
    writeFileSync(join(real, 'x.yaml'), 'name: X\ncommand: ls\n')
    const linked = join(base, 'linked')
    symlinkSync(real, linked)
    expect(readWorkflowDir(linked, 'user').workflows).toEqual([])
  })

  it('returns nothing for a missing folder', () => {
    expect(readWorkflowDir(join(base, 'missing'), 'user')).toEqual({ workflows: [], problems: [] })
  })
})

describe('loadWorkflows', () => {
  it('lists workspace, user, then extension workflows', () => {
    writeFileSync(
      join(workspaceWorkflowsDir(workDir), 'test.yaml'),
      'name: Test\ncommand: pnpm test\n',
    )
    writeFileSync(join(userDir, 'clone.yaml'), CLONE)
    const listing = loadWorkflows({
      userDir,
      workDir,
      extensions: [
        {
          extId: 'ops',
          workflows: [{ name: 'Deploy', command: 'make deploy', tags: [], arguments: [] }],
        },
      ],
    })
    expect(listing.workflows.map((w) => [w.source, w.origin, w.name])).toEqual([
      ['workspace', 'test.yaml', 'Test'],
      ['user', 'clone.yaml', 'Clone a repository'],
      ['extension', 'ops', 'Deploy'],
    ])
  })

  it('also lists workflows an older version kept in <workDir>/.pine/workflows, new folder first', () => {
    const legacy = legacyWorkspaceWorkflowsDir(workDir)
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(workspaceWorkflowsDir(workDir), 'test.yaml'), 'name: Test\ncommand: new\n')
    writeFileSync(join(legacy, 'test.yaml'), 'name: Test\ncommand: old\n')
    writeFileSync(join(legacy, 'build.yaml'), 'name: Build\ncommand: make\n')
    writeFileSync(join(legacy, 'broken.yaml'), 'name: [\n')
    const listing = loadWorkflows({ userDir, workDir, extensions: [] })
    expect(listing.workflows.map((w) => [w.origin, w.command])).toEqual([
      ['test.yaml', 'new'],
      ['build.yaml', 'make'],
    ])
    expect(listing.problems.map((p) => p.origin)).toEqual(['broken.yaml'])
    expect(legacy).toBe(join(workDir, '.pine', 'workflows'))
    expect(workspaceWorkflowsDir(workDir)).toBe(join(workDir, '.ostia', 'workflows'))
  })

  it('reads only user and extension workflows without a workspace', () => {
    writeFileSync(
      join(workspaceWorkflowsDir(workDir), 'test.yaml'),
      'name: Test\ncommand: pnpm test\n',
    )
    expect(loadWorkflows({ userDir, extensions: [] }).workflows).toEqual([])
  })
})

describe('saveWorkflow', () => {
  it('writes a Warp-format YAML file named after the workflow, private to the user', () => {
    const fresh = join(base, 'fresh', 'workflows')
    const res = saveWorkflow(fresh, {
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
    expect(readWorkflowDir(fresh, 'user').workflows[0]).toMatchObject({ name: 'Tail a log' })
  })

  it('never overwrites an existing file', () => {
    writeFileSync(join(userDir, 'build.yaml'), 'name: Mine\ncommand: make\n')
    expect(saveWorkflow(userDir, { name: 'Build', command: 'make all' })).toEqual({
      ok: true,
      file: 'build-2.yaml',
    })
    expect(readFileSync(join(userDir, 'build.yaml'), 'utf8')).toContain('Mine')
    expect(readdirSync(userDir).sort()).toEqual(['build-2.yaml', 'build.yaml'])
  })

  it('keeps the file inside the workflows folder whatever the name', () => {
    const res = saveWorkflow(userDir, { name: '../../../evil', command: 'ls' })
    expect(res).toEqual({ ok: true, file: 'evil.yaml' })
    expect(readdirSync(userDir)).toEqual(['evil.yaml'])
  })

  it('refuses an invalid workflow', () => {
    expect(saveWorkflow(userDir, { name: 'x' })).toEqual({ ok: false, error: 'missing command' })
    expect(readdirSync(userDir)).toEqual([])
  })
})
