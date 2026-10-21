import { describe, expect, it } from 'vitest'
import {
  claudeTurns,
  codexTurns,
  renderTurns,
  TRANSCRIPT_OUT_MAX,
  TRANSCRIPT_TOOL_MAX,
} from './transcriptTurns'

const lines = (...entries: object[]) => entries.map((entry) => JSON.stringify(entry))

const user = (content: unknown, extra: object = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  ...extra,
})
const assistant = (content: unknown[], extra: object = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content },
  ...extra,
})

describe('claudeTurns', () => {
  const session = lines(
    user('fix the flaky test'),
    assistant([{ type: 'thinking', thinking: 'hmm' }]),
    assistant([
      { type: 'text', text: 'Looking at it.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test\n--run' } },
    ]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    assistant([
      { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts', new_string: 'x' } },
    ]),
    assistant([{ type: 'text', text: 'Fixed.\nTests pass.' }]),
    user([{ type: 'text', text: 'and the docs?' }]),
    assistant([{ type: 'tool_use', name: 'Task', input: { prompt: 'x' } }]),
  )

  it('makes a turn of each real prompt, with one line per tool call and the last text as the answer', () => {
    expect(claudeTurns(session)).toEqual([
      {
        prompt: 'fix the flaky test',
        tools: ['Bash: pnpm test --run', 'Edit: src/a.ts'],
        final: 'Fixed.\nTests pass.',
      },
      { prompt: 'and the docs?', tools: ['Task'], final: '' },
    ])
  })

  it('skips tool results, meta entries, command echoes, sidechains and lines that are not JSON', () => {
    const turns = claudeTurns([
      'not json',
      '',
      ...lines(
        user('<command-name>/clear</command-name>'),
        user('hidden', { isMeta: true }),
        user('real prompt'),
        assistant([{ type: 'text', text: 'side' }], { isSidechain: true }),
        user('sub prompt', { isSidechain: true }),
        assistant([{ type: 'text', text: 'answer' }]),
      ),
    ])
    expect(turns).toEqual([{ prompt: 'real prompt', tools: [], final: 'answer' }])
  })

  it('ignores assistant output before the first prompt', () => {
    expect(claudeTurns(lines(assistant([{ type: 'text', text: 'orphan' }])))).toEqual([])
  })

  it('clips a long tool argument to one line', () => {
    const [turn] = claudeTurns(
      lines(
        user('go'),
        assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(500) } }]),
      ),
    )
    expect(turn.tools[0]).toHaveLength('Bash: '.length + TRANSCRIPT_TOOL_MAX)
    expect(turn.tools[0].endsWith('…')).toBe(true)
  })
})

describe('codexTurns', () => {
  const item = (payload: object) => ({
    type: 'event_msg',
    payload: { type: 'item_completed', ...payload },
  })
  const rollout = lines(
    { type: 'session_meta', payload: { cwd: '/w' } },
    item({ item: { type: 'UserMessage', content: [{ type: 'text', text: 'run the linter' }] } }),
    item({ item: { type: 'Reasoning', summary_text: ['thinking'] } }),
    item({
      item: { type: 'CommandExecution', command: ['bash', '-lc', 'pnpm lint'], exit_code: 0 },
    }),
    item({ item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Lint is clean.' }] } }),
    {
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'Lint is clean, 0 errors.' },
    },
    item({ item: { type: 'UserMessage', content: [{ type: 'text', text: 'now the tests' }] } }),
    item({ item: { type: 'CommandExecution', command: ['git', 'status'] } }),
  )

  it('reads prompts, commands and the answer, and lets the turn’s last message win', () => {
    expect(codexTurns(rollout)).toEqual([
      { prompt: 'run the linter', tools: ['shell: pnpm lint'], final: 'Lint is clean, 0 errors.' },
      { prompt: 'now the tests', tools: ['shell: git status'], final: '' },
    ])
  })

  it('ignores items before the first prompt and entries that are not events', () => {
    expect(
      codexTurns(
        lines(
          item({ item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'stray' }] } }),
          { type: 'response_item', payload: { type: 'message' } },
        ),
      ),
    ).toEqual([])
  })
})

describe('renderTurns', () => {
  it('quotes the prompt, lists tools and prints the answer in full', () => {
    expect(
      renderTurns([
        { prompt: 'a\nb', tools: ['Bash: ls'], final: 'Done.\nSecond line.' },
        { prompt: 'next', tools: [], final: '' },
      ]),
    ).toBe('> a\n> b\n· Bash: ls\nDone.\nSecond line.\n\n> next\n(no answer yet)')
  })

  it('keeps the end of a transcript that is too long and says so', () => {
    const text = renderTurns([
      { prompt: 'p', tools: [], final: 'z'.repeat(TRANSCRIPT_OUT_MAX + 10) },
    ])
    expect(text.startsWith('(older text cut)\n')).toBe(true)
    expect(text.endsWith('z')).toBe(true)
    expect(text.length).toBe(TRANSCRIPT_OUT_MAX + '(older text cut)\n'.length)
  })
})
