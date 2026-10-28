import type { SpecCommand } from '@shared/terminal/completionSpec'
import { describe, expect, it, vi } from 'vitest'
import type { CommandBlock } from '@/stores/terminal/blocksStore'
import {
  applyCompletionItem,
  argumentCandidates,
  caretOnFirstLine,
  commandCandidates,
  completionScope,
  completionToken,
  escapeAtCaret,
  escapeShellWord,
  inputHistory,
  isCommandWord,
  rankCommands,
  recentCommands,
  suggestionWord,
} from './inputEditor'

function block(paneId: string, command: string, startedAt: number): CommandBlock {
  return {
    id: `${paneId}-${startedAt}`,
    paneId,
    promptLine: { line: 0 },
    inputLine: null,
    outputStartLine: { line: 0 },
    endLine: null,
    endCol: 0,
    command,
    exitCode: 0,
    cwd: '/w',
    startedAt,
    endedAt: null,
  }
}

describe('inputHistory', () => {
  it('lists the pane’s own commands newest first, then other panes by time, without repeats', () => {
    const byPane = {
      a: [block('a', 'ls', 1), block('a', 'git status', 5)],
      b: [block('b', 'make', 9), block('b', 'ls', 10), block('b', '  ', 11)],
      c: [block('c', 'npm test', 7)],
    }
    expect(inputHistory(byPane, 'a')).toEqual(['git status', 'ls', 'make', 'npm test'])
  })

  it('returns other panes’ commands when the pane has none', () => {
    expect(inputHistory({ b: [block('b', 'make', 1)] }, 'a')).toEqual(['make'])
  })

  it('never suggests a scratch pane’s commands to another pane, but keeps the pane’s own', () => {
    const byPane = {
      a: [block('a', 'ls', 1)],
      s: [block('s', 'curl secret.example', 9)],
    }
    const scratch = new Set(['s'])
    expect(inputHistory(byPane, 'a', scratch)).toEqual(['ls'])
    expect(inputHistory(byPane, 's', scratch)).toEqual(['curl secret.example', 'ls'])
  })

  it('after a restart, the second entry up in a resumed tab is another tab’s agent launch', () => {
    const coordinator =
      "cd /w && claude --resume d27bd196 --agent research -n 'Ostia coordinator' --effort medium"
    const byPane = {
      coordinator: [
        block('coordinator', 'claude --resume d27bd196', 1),
        block('coordinator', coordinator, 2),
      ],
      bugs: [block('bugs', 'claude --resume 25f360be', 3)],
    }
    expect(inputHistory(byPane, 'bugs').slice(0, 2)).toEqual([
      'claude --resume 25f360be',
      coordinator,
    ])
  })
})

describe('caretOnFirstLine', () => {
  it('is true only before the first newline', () => {
    const text = 'one\ntwo'
    expect(caretOnFirstLine(text, 2)).toBe(true)
    expect(caretOnFirstLine(text, 5)).toBe(false)
  })
})

describe('completionToken', () => {
  it('takes the word before the caret and unescapes spaces', () => {
    expect(completionToken('cat src/re', 10)).toEqual({ start: 4, word: 'src/re' })
    expect(completionToken('ls my\\ fi', 9)).toEqual({ start: 3, word: 'my fi' })
    expect(completionToken('ls ', 3)).toEqual({ start: 3, word: '' })
  })

  it('keeps a quoted word with spaces whole and drops its quotes', () => {
    expect(completionToken('ls "my dir/fi', 13)).toEqual({ start: 3, word: 'my dir/fi' })
    expect(completionToken("ls 'my dir/fi", 13)).toEqual({ start: 3, word: 'my dir/fi' })
    expect(completionToken('ls "a b" c', 10)).toEqual({ start: 9, word: 'c' })
    expect(completionToken('ls "a\\"b c', 10)).toEqual({ start: 3, word: 'a"b c' })
  })
})

describe('completionScope', () => {
  it('is the directory part of the word plus a leading option dash', () => {
    expect(completionScope('avail-m')).toBe('')
    expect(completionScope('~/Work/goji/av')).toBe('~/Work/goji/')
    expect(completionScope('avail/')).toBe('avail/')
    expect(completionScope('-v')).toBe('-')
    expect(completionScope('--for')).toBe('--')
  })
})

describe('escapeShellWord', () => {
  it('backslash-escapes characters the shell would split or expand', () => {
    expect(escapeShellWord("a b'$(c)")).toBe("a\\ b\\'\\$\\(c\\)")
  })
})

describe('argumentCandidates', () => {
  const noSpec = { spec: async () => null }

  it('lists every entry of the word’s directory relative to the cwd, unfiltered', async () => {
    const entries = [
      { name: 'renderer', dir: true },
      { name: 'main', dir: true },
    ]
    const list = vi.fn().mockResolvedValue(entries)
    const pool = await argumentCandidates('cd src/re', 9, '/home/u/proj', { ...noSpec, list })
    expect(list).toHaveBeenCalledWith('/home/u/proj/src')
    expect(pool).toEqual(entries)
  })

  it('completes a lone ~ to the home folder without listing the cwd', async () => {
    const list = vi.fn().mockResolvedValue([{ name: '~notes', dir: false }])
    expect(await argumentCandidates('ls ~', 4, '/w', { ...noSpec, list })).toEqual([
      { name: '~', dir: true },
    ])
    expect(await argumentCandidates('ls ~gem', 7, '/w', { ...noSpec, list })).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })

  it('lists the home folder, its parent and $HOME for their typed forms', async () => {
    const list = vi.fn().mockResolvedValue([])
    await argumentCandidates('ls ~/', 5, '/w', { ...noSpec, list })
    await argumentCandidates('ls ~/../', 8, '/w', { ...noSpec, list })
    await argumentCandidates('ls $HOME/.c', 11, '/w', { ...noSpec, list })
    await argumentCandidates('ls ${HOME}/', 11, '/w', { ...noSpec, list })
    expect(list.mock.calls.map((c) => c[0])).toEqual(['~/', '~/..', '~/', '~/'])
  })

  it('offers .. for a word made only of dots', async () => {
    const list = vi.fn().mockResolvedValue([{ name: '.git', dir: true }])
    expect(await argumentCandidates('cd ..', 5, '/w/a', { ...noSpec, list })).toEqual([
      { name: '..', dir: true },
      { name: '.git', dir: true },
    ])
    expect(await argumentCandidates('cd ../.', 7, '/w/a', { ...noSpec, list })).toEqual([
      { name: '..', dir: true },
      { name: '.git', dir: true },
    ])
    expect(list.mock.calls.map((c) => c[0])).toEqual(['/w/a', '/w'])
    expect(await argumentCandidates('cd .g', 5, '/w/a', { ...noSpec, list })).toEqual([
      { name: '.git', dir: true },
    ])
  })

  it('lists the folder named inside an open quote', async () => {
    const list = vi.fn().mockResolvedValue([])
    await argumentCandidates('cat "my dir/fi', 14, '/w', { ...noSpec, list })
    expect(list).toHaveBeenCalledWith('/w/my dir')
  })

  it('lists the cwd itself for a bare word and absolute or home paths as given', async () => {
    const list = vi.fn().mockResolvedValue([])
    await argumentCandidates('ls ', 3, '/w', { ...noSpec, list })
    await argumentCandidates('ls /etc/', 8, '/w', { ...noSpec, list })
    await argumentCandidates('ls ~/Doc', 8, '/w', { ...noSpec, list })
    expect(list.mock.calls.map((c) => c[0])).toEqual(['/w', '/etc', '~/'])
  })

  it('offers every spec item of the same kind as the word, not only its prefix matches', async () => {
    const spec = async () => ({
      names: ['git'],
      subcommands: [{ names: ['checkout'] }, { names: ['cherry-pick'] }, { names: ['add'] }],
      options: [{ names: ['--version'] }, { names: ['--help'] }],
    })
    const list = vi.fn().mockResolvedValue([])
    const names = async (text: string) =>
      (await argumentCandidates(text, text.length, '/w', { spec, list })).map((i) => i.name)
    expect(await names('git ch')).toEqual(['checkout', 'cherry-pick', 'add'])
    expect(await names('git --v')).toEqual(['--version', '--help'])
    expect(list).not.toHaveBeenCalled()
  })

  it('keeps only folders when the spec asks for folders', async () => {
    const spec = async (): Promise<SpecCommand> => ({
      names: ['cd'],
      args: [{ template: ['folders'] }],
    })
    const list = vi.fn().mockResolvedValue([
      { name: 'src', dir: true },
      { name: 'README.md', dir: false },
    ])
    expect(await argumentCandidates('cd s', 4, '/w', { spec, list })).toEqual([
      { name: 'src', dir: true },
    ])
  })
})

describe('suggestionWord', () => {
  it('takes the leading spaces and the next word of the suggestion', () => {
    expect(suggestionWord(' status --short')).toBe(' status')
    expect(suggestionWord('atus --short')).toBe('atus')
    expect(suggestionWord('last')).toBe('last')
    expect(suggestionWord('   ')).toBe('   ')
  })
})

describe('rankCommands', () => {
  it('puts recently run commands first, then shorter names, then alphabetical', () => {
    const names = ['gitk', 'git', 'gist', 'git-lfs', 'gio', 'grep']
    expect(rankCommands(names, ['git-lfs'])).toEqual([
      'git-lfs',
      'gio',
      'git',
      'gist',
      'gitk',
      'grep',
    ])
    expect(rankCommands(names, [])).toEqual(['gio', 'git', 'gist', 'gitk', 'grep', 'git-lfs'])
  })
})

describe('recentCommands', () => {
  it('takes each history entry’s command name once, newest first', () => {
    expect(recentCommands(['git push', 'FOO=1 make', 'git pull', '# note'])).toEqual([
      'git',
      'make',
    ])
  })
})

describe('commandCandidates', () => {
  it('offers every command name in rank order as a non-directory item', () => {
    expect(commandCandidates(['python3', 'python', 'pip'], ['python3'])).toEqual([
      { name: 'python3', dir: false },
      { name: 'pip', dir: false },
      { name: 'python', dir: false },
    ])
  })
})

describe('escapeAtCaret', () => {
  it('escapes for the quote that is open at the caret', () => {
    expect(escapeAtCaret('ls ', 3, 'a b')).toBe('a\\ b')
    expect(escapeAtCaret('ls "', 4, 'a "b" $c')).toBe('a \\"b\\" \\$c')
    expect(escapeAtCaret("ls '", 4, "it's")).toBe("it'\\''s")
  })
})

describe('isCommandWord', () => {
  it('is true only for a command-position word without a slash', () => {
    expect(isCommandWord('gi', 2)).toBe(true)
    expect(isCommandWord('ls && ca', 8)).toBe(true)
    expect(isCommandWord('cat pa', 6)).toBe(false)
    expect(isCommandWord('./scr', 5)).toBe(false)
    expect(isCommandWord('~', 1)).toBe(false)
  })
})

describe('applyCompletionItem', () => {
  it('replaces the word before the caret, keeping its directory part', () => {
    expect(applyCompletionItem('cd src/co tail', 9, { name: 'components', dir: true })).toEqual({
      text: 'cd src/components/ tail',
      caret: 18,
    })
    expect(applyCompletionItem('pyt', 3, { name: 'python3', dir: false })).toEqual({
      text: 'python3 ',
      caret: 8,
    })
    expect(applyCompletionItem('cat my\\ f', 9, { name: 'my file', dir: false })).toEqual({
      text: 'cat my\\ file ',
      caret: 13,
    })
  })

  it('completes a lone ~ to ~/', () => {
    expect(applyCompletionItem('ls ~', 4, { name: '~', dir: true })).toEqual({
      text: 'ls ~/',
      caret: 5,
    })
  })

  it('stays inside an open quote and closes it after a file', () => {
    expect(applyCompletionItem('cat "my dir/fi', 14, { name: 'file one', dir: false })).toEqual({
      text: 'cat "my dir/file one" ',
      caret: 22,
    })
    expect(applyCompletionItem("cd 'my d", 8, { name: 'my dir', dir: true })).toEqual({
      text: "cd 'my dir/",
      caret: 11,
    })
    expect(applyCompletionItem("cd a/'my d", 10, { name: 'my dir', dir: true })).toEqual({
      text: "cd a/'my dir/",
      caret: 13,
    })
    expect(applyCompletionItem('cat my\\ dir/"fi', 15, { name: 'a b', dir: false })).toEqual({
      text: 'cat my\\ dir/"a b" ',
      caret: 18,
    })
  })
})

describe('argumentCandidates with history', () => {
  const spec = vi.fn(async (command: string) =>
    command === 'cd' ? { names: ['cd'], args: [{ template: ['folders' as const] }] } : null,
  )
  const list = vi.fn(async (path: string) =>
    path === '/w'
      ? [
          { name: 'src', dir: true },
          { name: 'notes.txt', dir: false },
        ]
      : path === '/w/src'
        ? [{ name: 'main', dir: true }]
        : [],
  )
  const history = (...found: string[]) => ({ arguments: () => found, label: 'From history' })

  it('adds history arguments after the folder’s, marked, without repeating a name', async () => {
    const sources = { spec, list, history: history('build-box', 'src', 'feature/x') }
    expect(await argumentCandidates('ssh ', 4, '/w', sources)).toEqual([
      { name: 'src', dir: true },
      { name: 'notes.txt', dir: false },
      { name: 'build-box', dir: false, description: 'From history' },
      { name: 'feature/x', dir: false, description: 'From history' },
    ])
  })

  it('offers a history path only where a path is expected if it still exists', async () => {
    const sources = { spec, list, history: history('src/main', 'src/gone', 'notes.txt', 'old') }
    expect(await argumentCandidates('cd ', 3, '/w', sources)).toEqual([
      { name: 'src', dir: true },
      { name: 'src/main', dir: true, description: 'From history' },
    ])
  })

  it('keeps only history arguments under the folder already typed', async () => {
    const sources = { spec, list, history: history('src/main', 'docs/api') }
    expect(await argumentCandidates('ssh src/', 8, '/w', sources)).toEqual([
      { name: 'main', dir: true },
    ])
  })
})
