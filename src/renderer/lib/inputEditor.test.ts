import { describe, expect, it, vi } from 'vitest'
import type { CommandBlock } from '../stores/blocksStore'
import {
  applyCompletionItem,
  caretOnFirstLine,
  completeCommand,
  completeName,
  completePath,
  completionToken,
  escapeShellWord,
  historySuggestion,
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
})

describe('completeName', () => {
  const entries = [
    { name: 'src', dir: true },
    { name: 'scripts', dir: true },
    { name: 'README.md', dir: false },
    { name: '.git', dir: true },
    { name: 'my file.txt', dir: false },
  ]

  it('completes a unique directory with a slash', () => {
    expect(completeName(entries, 'sr')).toEqual({ insert: 'c/', candidates: [] })
  })

  it('completes a unique file with a space and escapes shell characters', () => {
    expect(completeName(entries, 'R')).toEqual({ insert: 'EADME.md ', candidates: [] })
    expect(completeName(entries, 'my')).toEqual({ insert: '\\ file.txt ', candidates: [] })
  })

  it('extends to the common prefix and lists every candidate when ambiguous', () => {
    const result = completeName(entries, 's')
    expect(result.insert).toBe('')
    expect(result.candidates.map((e) => e.name)).toEqual(['src', 'scripts'])
  })

  it('hides dotfiles unless the word starts with a dot', () => {
    expect(completeName(entries, '').candidates.map((e) => e.name)).not.toContain('.git')
    expect(completeName(entries, '.g')).toEqual({ insert: 'it/', candidates: [] })
  })

  it('reports no completion when nothing matches', () => {
    expect(completeName(entries, 'zzz')).toEqual({ insert: '', candidates: [] })
  })
})

describe('escapeShellWord', () => {
  it('backslash-escapes characters the shell would split or expand', () => {
    expect(escapeShellWord("a b'$(c)")).toBe("a\\ b\\'\\$\\(c\\)")
  })
})

describe('completePath', () => {
  it('lists the directory of the word relative to the cwd', async () => {
    const list = vi.fn().mockResolvedValue([{ name: 'renderer', dir: true }])
    const result = await completePath('cd src/re', 9, '/home/u/proj', list)
    expect(list).toHaveBeenCalledWith('/home/u/proj/src')
    expect(result.insert).toBe('nderer/')
  })

  it('lists the cwd itself for a bare word and absolute or home paths as given', async () => {
    const list = vi.fn().mockResolvedValue([])
    await completePath('ls', 2, '/w', list)
    await completePath('ls /etc/', 8, '/w', list)
    await completePath('ls ~/Doc', 8, '/w', list)
    expect(list.mock.calls.map((c) => c[0])).toEqual(['/w', '/etc', '~/'])
  })
})

describe('historySuggestion', () => {
  const history = ['git status', 'git commit -m "wip"', 'ls -la', 'git status --short']

  it('completes the draft with the first history entry it prefixes', () => {
    expect(historySuggestion('git', history)).toBe(' status')
    expect(historySuggestion('git c', history)).toBe('ommit -m "wip"')
    expect(historySuggestion('git status ', history)).toBe('--short')
  })

  it('suggests nothing for an empty draft, an exact entry or no match', () => {
    expect(historySuggestion('', history)).toBe('')
    expect(historySuggestion('  ', history)).toBe('')
    expect(historySuggestion('ls -la', history)).toBe('')
    expect(historySuggestion('make', history)).toBe('')
  })

  it('follows the history order, so this pane’s newest command wins over other panes', () => {
    const byPane = {
      other: [block('other', 'npm run lint', 9)],
      mine: [block('mine', 'npm test', 1), block('mine', 'npm run build', 2)],
    }
    const ordered = inputHistory(byPane, 'mine')
    expect(historySuggestion('npm ', ordered)).toBe('run build')
    expect(historySuggestion('npm run l', ordered)).toBe('int')
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
    expect(rankCommands(names, 'gi', ['git-lfs'])).toEqual([
      'git-lfs',
      'gio',
      'git',
      'gist',
      'gitk',
    ])
    expect(rankCommands(names, 'gi', [])).toEqual(['gio', 'git', 'gist', 'gitk', 'git-lfs'])
  })

  it('matches only names starting with the prefix, case-sensitively', () => {
    expect(rankCommands(['Make', 'make', 'cmake'], 'ma', [])).toEqual(['make'])
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

describe('completeCommand', () => {
  it('finishes a unique command with a trailing space', () => {
    expect(completeCommand(['docker', 'dig'], 'doc', [])).toEqual({
      insert: 'ker ',
      candidates: [],
    })
  })

  it('extends to the common prefix and lists every ranked match', () => {
    expect(completeCommand(['python3', 'python', 'pip'], 'py', ['python3'])).toEqual({
      insert: 'thon',
      candidates: [
        { name: 'python3', dir: false },
        { name: 'python', dir: false },
      ],
    })
  })

  it('returns nothing when no command matches', () => {
    expect(completeCommand(['ls'], 'zz', [])).toEqual({ insert: '', candidates: [] })
  })
})

describe('isCommandWord', () => {
  it('is true only for a command-position word without a slash', () => {
    expect(isCommandWord('gi', 2)).toBe(true)
    expect(isCommandWord('ls && ca', 8)).toBe(true)
    expect(isCommandWord('cat pa', 6)).toBe(false)
    expect(isCommandWord('./scr', 5)).toBe(false)
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
})
