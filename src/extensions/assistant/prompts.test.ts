import { describe, expect, it } from 'vitest'
import {
  CURSOR_MARK,
  chatPrompt,
  cleanCompletion,
  cleanTerminal,
  commandPrompt,
  commandSchema,
  commandsFrom,
  completionPrompt,
  parseCorrection,
  reviewFrom,
  reviewPrompt,
  reviewSchema,
  terminalPrompt,
  typoPrompt,
} from './prompts'

function lastUser(prompt: { messages: { role: string; content: unknown }[] }): string {
  return String(prompt.messages.at(-1)?.content)
}

describe('typo prompt', () => {
  it('sends the draft as is and asks for the corrected message only', () => {
    const prompt = typoPrompt('fix teh tests in `src/app.ts`')
    expect(prompt.messages).toEqual([{ role: 'user', content: 'fix teh tests in `src/app.ts`' }])
    expect(prompt.system).toMatch(/Never change code, file paths/)
    expect(prompt.temperature).toBeLessThanOrEqual(0.2)
  })
})

describe('parseCorrection', () => {
  it('returns the corrected draft keeping the original outer whitespace', () => {
    expect(parseCorrection('fix the tests', '  fix teh tests\n')).toBe('  fix the tests\n')
  })

  it('strips quotes and fences the model added', () => {
    expect(parseCorrection('"fix the tests"', 'fix teh tests')).toBe('fix the tests')
    expect(parseCorrection('```\nfix the tests\n```', 'fix teh tests')).toBe('fix the tests')
  })

  it('reports nothing when unchanged, empty or rewritten out of proportion', () => {
    expect(parseCorrection('fix the tests', 'fix the tests')).toBeNull()
    expect(parseCorrection('', 'fix teh tests')).toBeNull()
    expect(
      parseCorrection(
        'Here is a much longer rewritten version of your prompt with extra detail added',
        'fix teh tests',
      ),
    ).toBeNull()
  })
})

describe('review', () => {
  it('names the agent in the system prompt', () => {
    expect(reviewPrompt('do it', 'claude').system).toMatch(/coding agent claude/)
  })

  it('accepts a string score, clamps it and caps notes', () => {
    const parsed = reviewSchema.parse({
      score: '7',
      notes: ['Name the file', ' ', 'Say how to verify', 'a', 'b', 'c', 'd'],
    })
    expect(reviewFrom(parsed)).toEqual({
      score: 5,
      notes: ['Name the file', 'Say how to verify', 'a', 'b', 'c'],
    })
  })

  it('is empty without a score or notes', () => {
    expect(reviewFrom({ score: Number.NaN, notes: [] })).toBeNull()
  })
})

describe('command suggestions', () => {
  it('describes the shell, OS and cwd with the request', () => {
    const prompt = commandPrompt({
      query: 'find big files',
      shell: 'zsh',
      platform: 'linux',
      cwd: '/home/u/p',
    })
    expect(lastUser(prompt)).toBe(
      'Shell: zsh\nOS: linux\nWorking directory: /home/u/p\nRequest: find big files',
    )
  })

  it('drops multi-line, empty, duplicate and extra suggestions', () => {
    const parsed = commandSchema.parse({
      suggestions: [
        { command: 'du -sh * | sort -h', description: 'sizes' },
        { command: 'a\nb' },
        { command: ' ' },
        { command: 'ls -S' },
        { command: 'ls -S', description: 'again' },
        { command: 'x' },
        { command: 'y' },
      ],
    })
    expect(commandsFrom(parsed)).toEqual([
      { command: 'du -sh * | sort -h', description: 'sizes' },
      { command: 'ls -S' },
      { command: 'x' },
    ])
  })
})

describe('inline completion', () => {
  it('marks the cursor between prefix and suffix and includes neighbors', () => {
    const prompt = completionPrompt({
      path: '/p/a.ts',
      language: 'typescript',
      prefix: 'const x = ',
      suffix: '\nexport {}',
      neighbors: [{ path: '/p/b.ts', text: 'export const y = 1' }],
    })
    const content = lastUser(prompt)
    expect(content).toContain(`const x = ${CURSOR_MARK}\nexport {}`)
    expect(content).toContain('Other open file /p/b.ts')
    expect(content.indexOf('/p/b.ts')).toBeLessThan(content.indexOf('File /p/a.ts'))
  })

  it('strips fences, the echoed line and the repeated next line', () => {
    expect(cleanCompletion('```ts\nconst x = 42;\n```', 'let a\nconst x = ', '\n')).toBe('42;')
    expect(cleanCompletion('foo(1)\n}', 'call ', '}\nrest')).toBe('foo(1)')
    expect(cleanCompletion(`a${CURSOR_MARK}b  \n`, '', '')).toBe('ab')
  })

  it('drops indentation the prefix already has and a closing brace the suffix holds', () => {
    const prefix = 'function multiply(a, b) {\n  '
    expect(cleanCompletion('  return a * b\n}', prefix, '\n}\n')).toBe('return a * b')
  })
})

describe('terminal completion', () => {
  it('sends the line with cwd, shell, recent commands with exit codes and chip context', () => {
    const prompt = terminalPrompt({
      line: 'git comm',
      cwd: '/p',
      shell: 'zsh',
      platform: 'linux',
      history: [{ command: 'git add -A', exitCode: 0 }, { command: 'make' }],
      context: [{ label: 'Git branch', text: 'main' }],
    })
    expect(lastUser(prompt)).toBe(
      'Shell: zsh\nOS: linux\nWorking directory: /p\nGit branch: main\nRecent commands:\n$ git add -A   # exit 0\n$ make\nCurrent line: git comm',
    )
    expect(prompt.temperature).toBe(0)
    expect(prompt.maxOutputTokens).toBeLessThanOrEqual(64)
  })

  it('keeps only what continues the typed line, on one line', () => {
    expect(cleanTerminal('git commit -m "x"', 'git comm')).toBe('it -m "x"')
    expect(cleanTerminal('ls -la\nls -l', 'ls -')).toBe('la')
    expect(cleanTerminal('```sh\ndocker ps -a\n```', 'docker ps ')).toBe('-a')
    expect(cleanTerminal('$ cd ..', 'cd ')).toBe('..')
  })

  it('offers nothing when the answer does not start with the line or adds nothing', () => {
    expect(cleanTerminal('git diff', 'ls -')).toBe('')
    expect(cleanTerminal('ls -', 'ls -')).toBe('')
    expect(cleanTerminal('', 'ls')).toBe('')
  })
})

describe('chat prompt', () => {
  it('appends shared context as labeled sections after the instructions', () => {
    const prompt = chatPrompt({
      messages: [{ role: 'user', content: 'why?' }],
      context: [{ kind: 'error', label: 'npm test', text: 'exit 1' }],
    })
    expect(prompt.system).toMatch(/fenced block with a language tag/)
    expect(prompt.system).toContain('## npm test (error)\n```\nexit 1\n```')
    expect(prompt.messages).toEqual([{ role: 'user', content: 'why?' }])
  })

  it('has no context section when nothing was shared', () => {
    expect(
      chatPrompt({ messages: [{ role: 'user', content: 'hi' }], context: [] }).system,
    ).not.toMatch(/Context the user shared/)
  })
})
