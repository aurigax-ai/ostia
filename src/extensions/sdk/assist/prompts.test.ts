import { describe, expect, it } from 'vitest'
import {
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

const POINT = 'interface Point {\n  x: number\n  y: number\n}\n\n'
const DISTANCE = 'export function distance(a: Point, b: Point): number {\n'
const MIDPOINT = 'export function midpoint(a: Point, b: Point): Point {\n'

describe('inline completion', () => {
  it('frames prefix and suffix for fill-in-the-middle after worked examples', () => {
    const prompt = completionPrompt({
      path: '/p/a.ts',
      language: 'typescript',
      prefix: 'const x = ',
      suffix: '\nexport {}',
      neighbors: [{ path: '/p/b.ts', text: 'export const y = 1' }],
    })
    const content = lastUser(prompt)
    expect(content).toContain('<prefix>const x = </prefix>\n<suffix>\nexport {}</suffix>')
    expect(content).toContain('Other open file /p/b.ts')
    expect(content.indexOf('/p/b.ts')).toBeLessThan(content.indexOf('File /p/a.ts'))
    expect(prompt.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    expect(prompt.system).toMatch(/never repeat code from the prefix or the suffix/)
  })

  it('strips fences, tags, the echoed line and the repeated next line', () => {
    expect(cleanCompletion('```ts\nconst x = 42;\n```', 'let a\nconst x = ', '\n')).toBe('42;')
    expect(cleanCompletion('foo(1)\n}', 'call ', '}\nrest')).toBe('foo(1)')
    expect(cleanCompletion('a<prefix>b</suffix>  \n', '', '')).toBe('ab')
  })

  it('drops indentation the prefix already has and a closing brace the suffix holds', () => {
    const prefix = 'function multiply(a, b) {\n  '
    expect(cleanCompletion('  return a * b\n}', prefix, '\n}\n')).toBe('return a * b')
  })

  it('drops an unindented echo of the current line and indents the lines after it', () => {
    const prefix = `${POINT}${DISTANCE}  const dx = `
    const raw = 'const dx = b.x - a.x\nconst dy = b.y - a.y\nreturn Math.sqrt(dx * dx + dy * dy)'
    expect(cleanCompletion(raw, prefix, '\n}\n')).toBe(
      'b.x - a.x\n  const dy = b.y - a.y\n  return Math.sqrt(dx * dx + dy * dy)',
    )
  })

  it('drops an echo of the whole function before the cursor', () => {
    const body = '  const dx = b.x - a.x\n  const dy = b.y - a.y\n'
    const prefix = `${POINT}${DISTANCE}${body}  return Math.sqrt(`
    const raw = `${DISTANCE}${body}  return Math.sqrt(dx * dx + dy * dy)\n}`
    expect(cleanCompletion(raw, prefix, '\n}\n')).toBe('dx * dx + dy * dy)')
  })

  it('drops an echo that lost the indentation of every line', () => {
    const prefix = `${POINT}${DISTANCE}  const dx = b.x - a.x\n  return Math.sqrt(`
    const raw = `${DISTANCE}const dx = b.x - a.x\nreturn Math.sqrt(dx * dx)\n}`
    expect(cleanCompletion(raw, prefix, '\n}\n')).toBe('dx * dx)')
  })

  it('drops a re-echoed header on a new function body and keeps the body indented', () => {
    const prefix = `${POINT}${DISTANCE}  return 0\n}\n\n${MIDPOINT}  `
    const body = ['const x = (a.x + b.x) / 2', 'const y = (a.y + b.y) / 2', 'return { x, y }']
    const want = 'const x = (a.x + b.x) / 2\n  const y = (a.y + b.y) / 2\n  return { x, y }'
    expect(cleanCompletion(`${MIDPOINT}${body.join('\n')}\n}`, prefix, '\n}\n')).toBe(want)
    const indented = body.map((l) => `  ${l}`).join('\n')
    expect(cleanCompletion(`${MIDPOINT}${indented}\n}`, prefix, '\n}\n')).toBe(want)
  })

  it('drops an echo of the end of the current line', () => {
    const prefix = `${DISTANCE}  return Math.sqrt(`
    expect(cleanCompletion('Math.sqrt(dx * dx + dy * dy)', prefix, ')\n}')).toBe(
      'dx * dx + dy * dy',
    )
  })

  it('indents continuation lines the model wrote flush left', () => {
    const prefix = 'function f() {\n  const total = items'
    const raw = '.length\nconsole.log(total)\nreturn total'
    expect(cleanCompletion(raw, prefix, '\n}')).toBe(
      '.length\n  console.log(total)\n  return total',
    )
  })

  it('keeps continuation lines that are already indented and a dedenting closer', () => {
    const prefix = 'function f(xs) {\n  for (const x of xs) {'
    expect(cleanCompletion('\n    use(x)\n  }', prefix, '\n  return xs\n}')).toBe(
      '\n    use(x)\n  }',
    )
  })

  it('keeps a closing brace that closes what the completion opened', () => {
    const prefix = `${MIDPOINT}  return `
    expect(cleanCompletion('{\n    x: 0,\n    y: 0\n  }', prefix, '\n}\n')).toBe(
      '{\n    x: 0,\n    y: 0\n  }',
    )
  })

  it('drops a closing paren that nothing before it opened', () => {
    const prefix = `${POINT}${DISTANCE}  const dx = `
    expect(cleanCompletion('b.x - a.x)', prefix, '\n}\n')).toBe('b.x - a.x')
    expect(cleanCompletion('f(a))', prefix, '\n}\n')).toBe('f(a)')
  })

  it('keeps a completion at column 0 as written', () => {
    expect(cleanCompletion('    return 1', 'def f():\n', '\n')).toBe('    return 1')
  })

  it('drops lines the suffix already holds', () => {
    const prefix = `${DISTANCE}  const dx = `
    const suffix = '\n  const dy = b.y - a.y\n  return Math.sqrt(dx * dx + dy * dy)\n}\n'
    const raw = 'b.x - a.x\nconst dy = b.y - a.y\nreturn Math.sqrt(dx * dx + dy * dy)'
    expect(cleanCompletion(raw, prefix, suffix)).toBe('b.x - a.x')
  })

  it('does not take a short identifier for an echo', () => {
    expect(cleanCompletion('xs.length', 'const n = x', '')).toBe('xs.length')
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

  it('names the file and lines of a selection so the edit tools can target it', () => {
    const system = chatPrompt({
      messages: [{ role: 'user', content: 'rename this' }],
      context: [
        {
          kind: 'selection',
          label: 'Selection a.ts:3-4',
          text: 'const a = 1',
          path: '/proj/a.ts',
          startLine: 3,
          endLine: 4,
        },
        {
          kind: 'editor',
          label: 'Open file b.ts',
          text: 'The file the user has open in the editor, cursor at line 7.',
          path: '/proj/b.ts',
        },
        {
          kind: 'selection',
          label: 'Selection a.ts:9',
          text: 'x',
          path: '/proj/a.ts',
          startLine: 9,
          endLine: 9,
        },
      ],
      tools: [{ name: 'edit_file', description: 'Edit', inputSchema: { type: 'object' } }],
    }).system
    expect(system).toContain(
      '## Selection a.ts:3-4 (selection)\nFile: /proj/a.ts, lines 3-4\n```\nconst a = 1\n```',
    )
    expect(system).toContain('## Open file b.ts (editor)\nFile: /proj/b.ts\n```')
    expect(system).toContain('File: /proj/a.ts, line 9\n')
    expect(system).toMatch(/call edit_file with the exact text to replace/)
    expect(system).toMatch(/use that path with the read and edit tools/)
  })

  it('does not mention edit tools when the chat has no tools', () => {
    expect(
      chatPrompt({ messages: [{ role: 'user', content: 'hi' }], context: [] }).system,
    ).not.toMatch(/edit_file/)
  })

  it('has no context section when nothing was shared', () => {
    expect(
      chatPrompt({ messages: [{ role: 'user', content: 'hi' }], context: [] }).system,
    ).not.toMatch(/Context the user shared/)
  })

  it('turns a tool turn into a tool call and its done, failed or denied result', () => {
    const prompt = chatPrompt({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'Looking.',
          tools: [
            { id: 'a', name: 'read_file', input: { path: 'x' }, state: 'done', output: 'text' },
            { id: 'b', name: 'mcp__s__t', input: {}, state: 'error', error: 'boom' },
            { id: 'c', name: 'write_file', input: { path: 'x' }, state: 'denied' },
          ],
        },
      ],
      context: [],
      tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }],
    })
    expect(prompt.system).toMatch(/denied call means the user said no/)
    expect(prompt.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool-call', toolCallId: 'a', toolName: 'read_file', input: { path: 'x' } },
        { type: 'tool-call', toolCallId: 'b', toolName: 'mcp__s__t', input: {} },
        { type: 'tool-call', toolCallId: 'c', toolName: 'write_file', input: { path: 'x' } },
      ],
    })
    expect(prompt.messages[2]).toMatchObject({
      role: 'tool',
      content: [
        { toolCallId: 'a', output: { type: 'text', value: 'text' } },
        { toolCallId: 'b', output: { type: 'error-text', value: 'boom' } },
        { toolCallId: 'c', output: { type: 'execution-denied' } },
      ],
    })
  })
})
