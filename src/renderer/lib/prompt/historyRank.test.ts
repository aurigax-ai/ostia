import type { ShellHistoryEntry } from '@shared/terminal/ptyApi'
import { describe, expect, it } from 'vitest'
import type { CommandBlock } from '@/stores/terminal/blocksStore'
import {
  fileOnlyCommands,
  historyFacts,
  type RankContext,
  rankedSuggestion,
  rankHistory,
  sessionBlocks,
} from './historyRank'

let clock = 0

function block(command: string, patch: Partial<CommandBlock> = {}): CommandBlock {
  clock += 1000
  return {
    id: `b${clock}`,
    paneId: 'p',
    promptLine: { line: 0 } as CommandBlock['promptLine'],
    inputLine: null,
    outputStartLine: { line: 0 } as CommandBlock['outputStartLine'],
    endLine: null,
    endCol: 0,
    command,
    exitCode: 0,
    cwd: '/w/app',
    startedAt: clock,
    endedAt: clock,
    ...patch,
  }
}

const file = (...commands: string[]): ShellHistoryEntry[] =>
  commands.map((command) => ({ command, time: null }))

const anywhere: RankContext = { cwd: null, previous: null, commands: null }

const ranked = (
  draft: string,
  entries: ReturnType<typeof historyFacts>,
  context: Partial<RankContext> = {},
): string[] => rankHistory(draft, entries, { ...anywhere, ...context }).map((e) => e.command)

describe('rankHistory', () => {
  it('offers only entries that start with the draft and are longer than it', () => {
    const facts = historyFacts(file('git status', 'gh pr list', 'git'), [])
    expect(ranked('git', facts)).toEqual(['git status'])
  })

  it('puts a command run in this folder before a newer one from elsewhere', () => {
    const facts = historyFacts(
      [],
      [[block('pnpm test:e2e', { cwd: '/w/app' }), block('pnpm test', { cwd: '/w/other' })]],
    )
    expect(ranked('pnpm', facts, { cwd: '/w/app' })).toEqual(['pnpm test:e2e', 'pnpm test'])
    expect(ranked('pnpm', facts, { cwd: '/w/other' })).toEqual(['pnpm test', 'pnpm test:e2e'])
  })

  it('puts what came right after the command that just ran before a newer match', () => {
    const facts = historyFacts(file('git add -A', 'git commit', 'ls', 'git checkout main'), [])
    expect(ranked('git c', facts, { previous: 'git add -A' })).toEqual([
      'git commit',
      'git checkout main',
    ])
    expect(ranked('git c', facts)).toEqual(['git checkout main', 'git commit'])
  })

  it('weighs how often against how recently', () => {
    const often = Array.from({ length: 40 }, () => 'make build')
    const facts = historyFacts(file(...often, 'ls', 'make clean', 'ls', 'ls', 'ls', 'ls'), [])
    expect(ranked('make', facts)).toEqual(['make build', 'make clean'])
    const once = historyFacts(file('make build', 'ls', 'make clean'), [])
    expect(ranked('make', once)).toEqual(['make clean', 'make build'])
  })

  it('drops to the end a command that failed the last time it ran here', () => {
    const facts = historyFacts(
      [],
      [[block('cargo build'), block('cargo bench', { exitCode: 101 })]],
    )
    expect(ranked('cargo', facts, { cwd: '/w/app' })).toEqual(['cargo build', 'cargo bench'])
    expect(ranked('cargo', facts, { cwd: '/w/other' })).toEqual(['cargo bench', 'cargo build'])
    const fixed = historyFacts(
      [],
      [[block('cargo build'), block('cargo bench', { exitCode: 101 }), block('cargo bench')]],
    )
    expect(ranked('cargo', fixed, { cwd: '/w/app' })).toEqual(['cargo bench', 'cargo build'])
  })

  it('does not offer a file entry whose command the shell no longer has', () => {
    const facts = historyFacts(file('nvm use 20', 'node -v', './run.sh', 'FOO=1 node x'), [
      [block('nx build')],
    ])
    const commands = new Set(['node', 'ls'])
    expect(ranked('n', facts, { commands })).toEqual(['nx build', 'node -v'])
    expect(ranked('./', facts, { commands })).toEqual(['./run.sh'])
    expect(ranked('n', facts)).toEqual(['nx build', 'node -v', 'nvm use 20'])
  })

  it('merges session and file entries, the session’s folder and exit code winning', () => {
    const facts = historyFacts(file('pnpm lint', 'pnpm build'), [[block('pnpm lint')]])
    const lint = facts.find((e) => e.command === 'pnpm lint')
    expect(facts).toHaveLength(2)
    expect(lint?.count).toBe(2)
    expect([...(lint?.folders ?? [])]).toEqual(['/w/app'])
    expect(ranked('pnpm', facts, { cwd: '/w/app' })).toEqual(['pnpm lint', 'pnpm build'])
  })
})

describe('rankedSuggestion', () => {
  it('is the rest of the top-ranked match, and nothing for a blank draft', () => {
    const facts = historyFacts(file('git status', 'git stash'), [])
    expect(rankedSuggestion('git st', facts, anywhere)).toBe('ash')
    expect(rankedSuggestion('  ', facts, anywhere)).toBe('')
    expect(rankedSuggestion('zz', facts, anywhere)).toBe('')
  })
})

describe('sessionBlocks', () => {
  it('orders this pane last, so its commands count as the newest, and leaves hidden panes out', () => {
    const byPane = {
      mine: [block('a')],
      other: [block('b')],
      scratch: [block('c')],
    }
    const lists = sessionBlocks(byPane, 'mine', new Set(['scratch']))
    expect(lists.map((list) => list.map((b) => b.command))).toEqual([['b'], ['a']])
  })
})

describe('fileOnlyCommands', () => {
  it('lists the file’s commands newest first, once each, without the session’s', () => {
    expect(fileOnlyCommands(file('a', 'b', 'a', 'c', ' '), ['c'])).toEqual(['a', 'b'])
  })
})
