import { describe, expect, it } from 'vitest'
import { firstCommand, isCommandPosition, tokenizeShell } from './shellTokens'

const kinds = (text: string): Array<[string, string]> =>
  tokenizeShell(text)
    .filter((t) => t.kind !== 'space')
    .map((t) => [t.kind, t.text])

describe('tokenizeShell', () => {
  it('covers every character of the draft exactly once, in order', () => {
    const drafts = [
      'git commit -m "fix: a \\"quoted\\" bug" && echo $? # done',
      "FOO=1 BAR='x y' make -j8 2>&1 | tee build.log; ls\\\n  -la",
      'echo ${HOME}/$(date +%s) `id -u` $((1 + 2)) "unterminated',
      '',
      '\\',
      '$',
    ]
    for (const draft of drafts) {
      const tokens = tokenizeShell(draft)
      expect(tokens.map((t) => t.text).join('')).toBe(draft)
      tokens.forEach((t, i) => {
        expect(t.text).toBe(draft.slice(t.start, t.end))
        if (i > 0) expect(t.start).toBe(tokens[i - 1].end)
      })
    }
  })

  it('marks the command name, its flags and plain arguments', () => {
    expect(kinds('git commit --amend -v file.txt')).toEqual([
      ['command', 'git'],
      ['argument', 'commit'],
      ['flag', '--amend'],
      ['flag', '-v'],
      ['argument', 'file.txt'],
    ])
  })

  it('starts a new command after each operator but not after a redirection', () => {
    expect(kinds('ls -la | grep x && make; echo hi > out.txt 2>&1')).toEqual([
      ['command', 'ls'],
      ['flag', '-la'],
      ['operator', '|'],
      ['command', 'grep'],
      ['argument', 'x'],
      ['operator', '&&'],
      ['command', 'make'],
      ['operator', ';'],
      ['command', 'echo'],
      ['argument', 'hi'],
      ['operator', '>'],
      ['argument', 'out.txt'],
      ['operator', '2>&'],
      ['argument', '1'],
    ])
  })

  it('reads single, double and ANSI-C strings, escapes and unterminated quotes', () => {
    expect(kinds(`echo 'a b' "c \\" d" $'e\\n' "open`)).toEqual([
      ['command', 'echo'],
      ['string', "'a b'"],
      ['string', '"c \\" d"'],
      ['string', "$'e\\n'"],
      ['string', '"open'],
    ])
  })

  it('reads variables, parameter expansions, arithmetic and backticks', () => {
    expect(kinds('echo $HOME ${PATH%%:*} $1 $? $((2*3)) `pwd`')).toEqual([
      ['command', 'echo'],
      ['variable', '$HOME'],
      ['variable', '${PATH%%:*}'],
      ['variable', '$1'],
      ['variable', '$?'],
      ['variable', '$((2*3))'],
      ['variable', '`pwd`'],
    ])
  })

  it('treats a command substitution as a new command', () => {
    expect(kinds('echo $(date +%s)')).toEqual([
      ['command', 'echo'],
      ['operator', '$('],
      ['command', 'date'],
      ['argument', '+%s'],
      ['operator', ')'],
    ])
  })

  it('skips leading assignments and keywords to find the command', () => {
    expect(kinds('FOO=1 BAR="x" env')).toEqual([
      ['assignment', 'FOO=1'],
      ['assignment', 'BAR='],
      ['string', '"x"'],
      ['command', 'env'],
    ])
    expect(kinds('if true; then ls; fi')).toEqual([
      ['command', 'if'],
      ['command', 'true'],
      ['operator', ';'],
      ['command', 'then'],
      ['command', 'ls'],
      ['operator', ';'],
      ['command', 'fi'],
    ])
  })

  it('reads a comment only at the start of a word', () => {
    expect(kinds('echo a#b # the rest | not a pipe')).toEqual([
      ['command', 'echo'],
      ['argument', 'a#b'],
      ['comment', '# the rest | not a pipe'],
    ])
  })

  it('keeps a flag with an attached quoted value together', () => {
    expect(kinds('grep --regexp="a b" x')).toEqual([
      ['command', 'grep'],
      ['flag', '--regexp='],
      ['string', '"a b"'],
      ['argument', 'x'],
    ])
  })

  it('starts a command on each new line and joins escaped line breaks', () => {
    expect(kinds('make \\\n  -j2\nls')).toEqual([
      ['command', 'make'],
      ['flag', '-j2'],
      ['operator', '\n'],
      ['command', 'ls'],
    ])
    expect(kinds('my\\ tool arg')).toEqual([
      ['command', 'my\\ tool'],
      ['argument', 'arg'],
    ])
  })
})

describe('isCommandPosition', () => {
  it('is true for the first word and after operators, false for arguments', () => {
    expect(isCommandPosition('gi', 0)).toBe(true)
    expect(isCommandPosition('ls | gr', 5)).toBe(true)
    expect(isCommandPosition('FOO=1 ma', 6)).toBe(true)
    expect(isCommandPosition('git che', 4)).toBe(false)
    expect(isCommandPosition('echo > fi', 7)).toBe(false)
  })
})

describe('firstCommand', () => {
  it('returns the command word of a line, past assignments', () => {
    expect(firstCommand('FOO=1 make build')).toBe('make')
    expect(firstCommand('  # nothing')).toBeNull()
  })
})
