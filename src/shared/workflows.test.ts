import { describe, expect, it } from 'vitest'
import {
  type Workflow,
  commandParts,
  defaultValues,
  parseWorkflow,
  placeholderNames,
  renderWorkflow,
  workflowArguments,
  workflowDocument,
  workflowFileStem,
} from './workflows'

function parsed(raw: unknown): Workflow {
  const w = parseWorkflow(raw)
  if (w instanceof Error) throw w
  return w
}

describe('commandParts', () => {
  it('splits a command into text and placeholders', () => {
    expect(commandParts('git checkout -b {{branch}} origin/{{base}}')).toEqual([
      { text: 'git checkout -b ' },
      { arg: 'branch' },
      { text: ' origin/' },
      { arg: 'base' },
    ])
  })

  it('treats triple braces as an escaped literal placeholder', () => {
    expect(commandParts('echo {{{name}}} {{name}}')).toEqual([
      { text: 'echo {{name}} ' },
      { arg: 'name' },
    ])
  })

  it('leaves template syntax that is not a placeholder name alone', () => {
    expect(commandParts("docker ps --format '{{.Names}} {{ json . }}'")).toEqual([
      { text: "docker ps --format '{{.Names}} {{ json . }}'" },
    ])
  })
})

describe('placeholderNames', () => {
  it('lists each placeholder once, in order of appearance', () => {
    expect(placeholderNames('cp {{src}} {{dst}} && ls {{dst}}')).toEqual(['src', 'dst'])
  })
})

describe('renderWorkflow', () => {
  it('substitutes every occurrence of each argument verbatim', () => {
    expect(renderWorkflow('cp {{src}} {{dst}}; ls {{dst}}', { src: 'a b', dst: '/tmp' })).toBe(
      'cp a b /tmp; ls /tmp',
    )
  })

  it('renders a missing value as empty and keeps escaped braces literal', () => {
    expect(renderWorkflow('echo {{{x}}} {{x}}!', {})).toBe('echo {{x}} !')
  })
})

describe('parseWorkflow', () => {
  it('reads the Warp workflow format', () => {
    const w = parsed({
      name: 'Clone a repo',
      command: 'git clone {{url}} {{dir}}',
      description: 'Clones a repository',
      tags: ['git', 'git'],
      arguments: [
        { name: 'url', description: 'Repository URL', default_value: null },
        { name: 'dir', default_value: 7 },
      ],
      shells: ['zsh'],
      author: 'me',
      source_url: 'https://example.com/w',
    })
    expect(w).toEqual({
      name: 'Clone a repo',
      command: 'git clone {{url}} {{dir}}',
      description: 'Clones a repository',
      tags: ['git'],
      arguments: [
        { name: 'url', description: 'Repository URL' },
        { name: 'dir', defaultValue: '7' },
      ],
      shells: ['zsh'],
      author: 'me',
      sourceUrl: 'https://example.com/w',
    })
  })

  it('rejects a workflow without a name or command', () => {
    expect(parseWorkflow({ command: 'ls' })).toBeInstanceOf(Error)
    expect(parseWorkflow({ name: 'x', command: '   ' })).toBeInstanceOf(Error)
    expect(parseWorkflow(['name'])).toBeInstanceOf(Error)
  })

  it('rejects bad argument names, duplicates and non-web source urls', () => {
    expect(
      parseWorkflow({ name: 'x', command: 'ls', arguments: [{ name: 'a b' }] }),
    ).toBeInstanceOf(Error)
    expect(
      parseWorkflow({ name: 'x', command: 'ls', arguments: [{ name: 'a' }, { name: 'a' }] }),
    ).toBeInstanceOf(Error)
    expect(
      (parseWorkflow({ name: 'x', command: 'ls', source_url: 'javascript:alert(1)' }) as Error)
        .message,
    ).toContain('source_url')
  })

  it('rejects oversized fields', () => {
    expect(parseWorkflow({ name: 'x', command: 'a'.repeat(9000) })).toBeInstanceOf(Error)
    expect(parseWorkflow({ name: 'x', command: 'ls', tags: Array(40).fill('t') })).toBeInstanceOf(
      Error,
    )
  })
})

describe('workflowArguments', () => {
  it('follows the placeholders and takes metadata from the declared arguments', () => {
    const w = parsed({
      name: 'x',
      command: 'ssh {{host}} -p {{port}}',
      arguments: [{ name: 'port', default_value: '22' }, { name: 'unused' }],
    })
    expect(workflowArguments(w)).toEqual([{ name: 'host' }, { name: 'port', defaultValue: '22' }])
    expect(defaultValues(w)).toEqual({ host: '', port: '22' })
  })
})

describe('workflowDocument', () => {
  it('round-trips through parseWorkflow', () => {
    const w = parsed({
      name: 'x',
      command: 'echo {{a}}',
      tags: ['t'],
      arguments: [{ name: 'a', description: 'd', default_value: 'v' }],
    })
    expect(workflowDocument(w)).toEqual({
      name: 'x',
      command: 'echo {{a}}',
      tags: ['t'],
      arguments: [{ name: 'a', description: 'd', default_value: 'v' }],
    })
    expect(parsed(workflowDocument(w))).toEqual(w)
  })
})

describe('workflowFileStem', () => {
  it('makes a safe file name from any workflow name', () => {
    expect(workflowFileStem('Deploy to Prod!')).toBe('deploy-to-prod')
    expect(workflowFileStem('../../etc/passwd')).toBe('etc-passwd')
    expect(workflowFileStem('部署')).toBe('workflow')
  })
})
