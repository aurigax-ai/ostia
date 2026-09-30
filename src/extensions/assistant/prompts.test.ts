import { describe, expect, it } from 'vitest'
import {
  CURSOR_MARK,
  chatPrompt,
  cleanCompletion,
  commandPrompt,
  completionPrompt,
  parseCommands,
  parseCorrection,
  parseReview,
  reviewPrompt,
  typoPrompt,
} from './prompts'

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

  it('parses JSON inside fences, clamps the score and caps notes', () => {
    const raw =
      'Sure!\n```json\n{"score": 7, "notes": ["Name the file", "", "Say how to verify", "a", "b", "c", "d"]}\n```'
    expect(parseReview(raw)).toEqual({
      score: 5,
      notes: ['Name the file', 'Say how to verify', 'a', 'b', 'c'],
    })
  })

  it('returns null for text that is not a review', () => {
    expect(parseReview('looks fine to me')).toBeNull()
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
    expect(prompt.messages[0].content).toBe(
      'Shell: zsh\nOS: linux\nWorking directory: /home/u/p\nRequest: find big files',
    )
  })

  it('parses objects, bare arrays and strings, dropping multi-line and extra entries', () => {
    expect(
      parseCommands(
        '{"suggestions":[{"command":"du -sh * | sort -h","description":"sizes"},{"command":"a\\nb"},{"command":"ls -S"},{"command":"x"},{"command":"y"}]}',
      ),
    ).toEqual([
      { command: 'du -sh * | sort -h', description: 'sizes' },
      { command: 'ls -S' },
      { command: 'x' },
    ])
    expect(parseCommands('["ls -la"]')).toEqual([{ command: 'ls -la' }])
    expect(parseCommands('no idea')).toEqual([])
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
    const content = prompt.messages[0].content
    expect(content).toContain(`const x = ${CURSOR_MARK}\nexport {}`)
    expect(content).toContain('Other open file /p/b.ts')
    expect(content.indexOf('/p/b.ts')).toBeLessThan(content.indexOf('File /p/a.ts'))
  })

  it('strips fences, the echoed line and the repeated next line', () => {
    expect(cleanCompletion('```ts\nconst x = 42;\n```', 'let a\nconst x = ', '\n')).toBe('42;')
    expect(cleanCompletion('foo(1)\n}', 'call ', '}\nrest')).toBe('foo(1)')
    expect(cleanCompletion(`a${CURSOR_MARK}b  \n`, '', '')).toBe('ab')
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
