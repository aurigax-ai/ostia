import type { SpecCommand } from '@shared/completionSpec'
import { describe, expect, it } from 'vitest'
import { commandWords, specAnswer } from './specCompletion'

const git: SpecCommand = {
  names: ['git'],
  options: [
    {
      names: ['-C'],
      description: 'Run as if started in path',
      args: [{ template: ['folders'] }],
      isPersistent: true,
    },
    { names: ['--version'], description: 'Print the version' },
  ],
  subcommands: [
    {
      names: ['checkout', 'co'],
      description: 'Switch branches',
      options: [
        { names: ['-b'], description: 'Create a branch', args: [{ name: 'branch' }] },
        { names: ['-f', '--force'], description: 'Throw away local changes' },
      ],
      args: [
        { name: 'branch', isOptional: true, suggestions: [{ name: 'main' }, { name: 'dev' }] },
      ],
    },
    { names: ['cherry-pick'], description: 'Apply a commit' },
    { names: ['add'], args: [{ template: ['filepaths'], isVariadic: true }] },
    {
      names: ['remote'],
      subcommands: [{ names: ['add'], description: 'Add a remote' }],
    },
  ],
}

const names = (answer: ReturnType<typeof specAnswer>): string[] =>
  answer.kind === 'items' ? answer.items.map((i) => i.name) : []

describe('commandWords', () => {
  it('reads the command and finished words of the last simple command', () => {
    expect(commandWords('git checkout ')).toEqual({ command: 'git', args: ['checkout'] })
    expect(commandWords('cd src && git -C "my dir" co ')).toEqual({
      command: 'git',
      args: ['-C', 'my dir', 'co'],
    })
    expect(commandWords('FOO=1 npm run ')).toEqual({ command: 'npm', args: ['run'] })
  })

  it('returns null inside a comment or with no command yet', () => {
    expect(commandWords('# git ')).toBeNull()
    expect(commandWords('')).toBeNull()
  })
})

describe('specAnswer', () => {
  it('lists subcommands with descriptions by prefix, under any of their names', () => {
    const answer = specAnswer(git, [], 'ch')
    expect(answer).toEqual({
      kind: 'items',
      items: [
        { name: 'checkout', description: 'Switch branches', kind: 'subcommand' },
        { name: 'cherry-pick', description: 'Apply a commit', kind: 'subcommand' },
      ],
    })
    expect(names(specAnswer(git, [], 'c'))).toContain('checkout')
    expect(names(specAnswer(git, [], 'co'))).toEqual(['co'])
  })

  it('walks into subcommands, including aliases, and offers their options and argument values', () => {
    expect(names(specAnswer(git, ['co'], '--'))).toEqual(['--force'])
    expect(names(specAnswer(git, ['checkout'], ''))).toEqual(['main', 'dev'])
    expect(names(specAnswer(git, ['remote'], ''))).toEqual(['add'])
  })

  it('offers options not used yet, including persistent ones from parents', () => {
    expect(names(specAnswer(git, ['checkout', '-f'], '-'))).toEqual(['-b', '-C'])
    expect(names(specAnswer(git, ['checkout', '-fb', 'x'], '-'))).toEqual(['-C'])
  })

  it('skips an option’s argument and asks for paths when the argument is a folder', () => {
    expect(specAnswer(git, ['-C'], '')).toEqual({ kind: 'paths', foldersOnly: true })
    expect(names(specAnswer(git, ['-C', 'repo'], 'ch'))).toEqual(['checkout', 'cherry-pick'])
    expect(names(specAnswer(git, ['-C=repo'], 'ch'))).toEqual(['checkout', 'cherry-pick'])
  })

  it('completes paths for file arguments, repeatedly for a variadic one', () => {
    expect(specAnswer(git, ['add'], 'sr')).toEqual({ kind: 'paths', foldersOnly: false })
    expect(specAnswer(git, ['add', 'a.ts', 'b.ts'], '')).toEqual({
      kind: 'paths',
      foldersOnly: false,
    })
  })

  it('stops offering subcommands after a positional argument or --', () => {
    expect(specAnswer(git, ['checkout', 'main'], '')).toEqual({ kind: 'none' })
    expect(specAnswer(git, ['--'], 'ch')).toEqual({ kind: 'none' })
  })
})
