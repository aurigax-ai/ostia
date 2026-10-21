import { describe, expect, it } from 'vitest'
import { capTimelines, clip, clock, RUN_RESULT_LIMIT, timelineOf } from './timeline'

const FILE = { id: 'sess-1', path: '/x', project: 'p', modified: 0 }
const at = (m: number) => `2026-10-21T0${m}:00:00.000Z`
const human = { kind: 'human' }

const records = [
  { type: 'ai-title', aiTitle: 'Retry loop' },
  {
    type: 'user',
    timestamp: at(1),
    cwd: '/w',
    gitBranch: 'main',
    origin: human,
    message: { content: 'fix the retry loop' },
  },
  { type: 'user', timestamp: at(1), isMeta: true, message: { content: 'meta' } },
  { type: 'user', timestamp: at(1), message: { content: 'system noise' } },
  {
    type: 'assistant',
    timestamp: at(2),
    message: {
      content: [
        { type: 'text', text: 'I will   look\nat it' },
        {
          type: 'tool_use',
          id: 'u1',
          name: 'Bash',
          input: { description: 'run tests', command: 'pnpm test' },
        },
        { type: 'tool_use', id: 'u2', name: 'AskUserQuestion', input: { question: 'q' } },
      ],
    },
  },
  {
    type: 'user',
    timestamp: at(3),
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'u1', content: 'ok\n3 passed', is_error: false },
      ],
    },
  },
  {
    type: 'user',
    timestamp: at(4),
    toolUseResult: { answers: { 'Which?': 'A' } },
    message: { content: [{ type: 'tool_result', tool_use_id: 'u2', content: 'x' }] },
  },
  {
    type: 'assistant',
    isSidechain: true,
    timestamp: at(5),
    message: { content: [{ type: 'text', text: 'hidden' }] },
  },
  {
    type: 'attachment',
    timestamp: at(6),
    attachment: { type: 'queued_command', origin: human, prompt: 'then ship it', timestamp: at(6) },
  },
].map((r) => JSON.stringify(r))

describe('handoff timeline', () => {
  const lines = timelineOf(FILE, [...records, 'not json'])

  it('heads the timeline with the title, span, folder and branch', () => {
    expect(lines[0]).toMatch(
      /^# session sess-1 \| Retry loop \| \d\d-\d\d \d\d:\d\d → \d\d-\d\d \d\d:\d\d \| cwd \/w \| branch main$/,
    )
  })

  it('keeps human prompts, agent text and runs, and drops sidechains and system noise', () => {
    const body = lines.slice(1).map((l) => l.replace(/^\[[^\]]+\] /, ''))
    expect(body).toEqual([
      'USER: fix the retry loop',
      'AGENT: I will look at it',
      'RUN Bash: run tests: pnpm test → ok | 3 passed',
      'USER ANSWER: Which? → A',
      'USER: then ship it',
    ])
  })

  it('says empty for a file with no timestamps', () => {
    expect(timelineOf(FILE, ['{}'])[0]).toContain('| empty |')
  })

  it('clips long text with an ellipsis', () => {
    expect(clip('a b'.repeat(100), RUN_RESULT_LIMIT)).toHaveLength(RUN_RESULT_LIMIT)
    expect(clock({})).toBe('--:--')
  })

  it('keeps the newest characters when a call is over the cap', () => {
    const capped = capTimelines(['x'.repeat(50), 'y'.repeat(50)], 60)
    expect(capped.startsWith('… the first 42 characters are left out')).toBe(true)
    expect(capped.endsWith('y'.repeat(50))).toBe(true)
    expect(capTimelines(['short'], 60)).toBe('short')
  })
})
