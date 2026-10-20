import { describe, expect, it } from 'vitest'
import { lastTurns } from './agentStream'
import { ClaudeStream } from './claudeStream'

const lines = (...entries: object[]) => entries.map((entry) => JSON.stringify(entry))

const prompt = (uuid: string, text: string, extra: object = {}) => ({
  type: 'user',
  uuid,
  message: { role: 'user', content: text },
  ...extra,
})
const assistant = (uuid: string, content: unknown[], stop?: string, extra: object = {}) => ({
  type: 'assistant',
  uuid,
  message: { role: 'assistant', content, ...(stop ? { stop_reason: stop } : {}) },
  ...extra,
})
const result = (toolUseId: string, content: string, extra: object = {}, isError = false) => ({
  type: 'user',
  uuid: `r-${toolUseId}`,
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  },
  ...extra,
})

describe('ClaudeStream', () => {
  it('turns a prompt, narration, a tool call and its result into one ordered stream', () => {
    const events = new ClaudeStream().feed(
      lines(
        prompt('u1', 'fix the export'),
        assistant('a1', [{ type: 'thinking', thinking: 'hmm' }]),
        assistant('a2', [{ type: 'text', text: 'Looking at it.' }]),
        assistant('a3', [
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'pnpm test' } },
        ]),
        result('tu1', 'ok 61 passed', { toolUseResult: { stdout: 'ok 61 passed' } }),
        assistant('a4', [{ type: 'text', text: 'All pass.' }], 'end_turn'),
      ),
    )
    expect(events).toEqual([
      { type: 'turn.started', turn: 'u1' },
      { type: 'prompt', turn: 'u1', id: 'u1', text: 'fix the export' },
      { type: 'text', turn: 'u1', id: 'a2:0', text: 'Looking at it.' },
      { type: 'tool', turn: 'u1', id: 'tu1', kind: 'command', name: 'Bash', input: 'pnpm test' },
      { type: 'tool.result', turn: 'u1', id: 'tu1', output: 'ok 61 passed', exitCode: 0 },
      { type: 'text', turn: 'u1', id: 'a4:0', text: 'All pass.' },
      { type: 'turn.ended', turn: 'u1', status: 'done' },
    ])
  })

  it('reports a failing command with its exit code and the error flag', () => {
    const events = new ClaudeStream().feed(
      lines(
        prompt('u1', 'run it'),
        assistant('a1', [
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'false' } },
        ]),
        result('tu1', 'Exit code 1\nboom', {}, true),
      ),
    )
    expect(events.at(-1)).toEqual({
      type: 'tool.result',
      turn: 'u1',
      id: 'tu1',
      output: 'Exit code 1\nboom',
      exitCode: 1,
      isError: true,
    })
  })

  it('sends an edit as a unified diff built from the structured patch', () => {
    const events = new ClaudeStream().feed(
      lines(
        prompt('u1', 'guard it'),
        assistant('a1', [
          { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/p/month.ts' } },
        ]),
        result('tu1', 'updated', {
          toolUseResult: {
            filePath: '/p/month.ts',
            structuredPatch: [
              {
                oldStart: 41,
                oldLines: 2,
                newStart: 41,
                newLines: 3,
                lines: [
                  ' const rows = header(month)',
                  '-rows.push(total)',
                  '+if (!rows.includes(total)) {',
                  '+  rows.push(total)',
                ],
              },
            ],
          },
        }),
      ),
    )
    expect(events.find((e) => e.type === 'tool')).toMatchObject({
      kind: 'edit',
      target: '/p/month.ts',
    })
    expect(events.find((e) => e.type === 'edit')).toEqual({
      type: 'edit',
      turn: 'u1',
      id: 'tu1',
      path: '/p/month.ts',
      change: 'update',
      diff: [
        '--- a//p/month.ts',
        '+++ b//p/month.ts',
        '@@ -41,2 +41,3 @@',
        ' const rows = header(month)',
        '-rows.push(total)',
        '+if (!rows.includes(total)) {',
        '+  rows.push(total)',
      ].join('\n'),
    })
  })

  it('sends a created file as an all-added diff', () => {
    const events = new ClaudeStream().feed(
      lines(
        prompt('u1', 'new file'),
        assistant('a1', [
          { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: 'a.ts' } },
        ]),
        result('tu1', 'created', {
          toolUseResult: { type: 'create', filePath: 'a.ts', content: 'x\ny', structuredPatch: [] },
        }),
      ),
    )
    expect(events.find((e) => e.type === 'edit')).toMatchObject({
      change: 'add',
      diff: '--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+x\n+y',
    })
  })

  it('sends TodoWrite as a plan and no tool line', () => {
    const events = new ClaudeStream().feed(
      lines(
        prompt('u1', 'plan it'),
        assistant('a1', [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Guard totals', status: 'completed', activeForm: 'Guarding' },
                { content: 'Push', status: 'in_progress', activeForm: 'Pushing' },
                { content: 'Changelog', status: 'pending', activeForm: 'Noting' },
              ],
            },
          },
        ]),
        result('tu1', 'Todos updated'),
      ),
    )
    expect(events.map((e) => e.type)).toEqual(['turn.started', 'prompt', 'plan'])
    expect(events[2]).toEqual({
      type: 'plan',
      turn: 'u1',
      id: 'tu1',
      items: [
        { text: 'Guard totals', status: 'done' },
        { text: 'Push', status: 'active' },
        { text: 'Changelog', status: 'pending' },
      ],
    })
  })

  it('ends a turn on turn_duration and ignores meta, sidechain and command echoes', () => {
    const events = new ClaudeStream().feed(
      lines(
        prompt('u0', 'x', { isMeta: true }),
        prompt('u1', '<command-name>/clear</command-name>'),
        prompt('u2', 'real prompt'),
        assistant('a1', [{ type: 'text', text: 'sub' }], undefined, { isSidechain: true }),
        assistant('a2', [{ type: 'text', text: 'main' }]),
        { type: 'system', subtype: 'turn_duration', uuid: 'd1' },
      ),
    )
    expect(events.map((e) => e.type)).toEqual(['turn.started', 'prompt', 'text', 'turn.ended'])
  })

  it('opens an implicit turn when the window starts inside one, and an interrupted turn ends at the next prompt', () => {
    const events = new ClaudeStream().feed(
      lines(
        assistant('a1', [{ type: 'text', text: 'tail of an earlier turn' }]),
        prompt('u1', 'next'),
      ),
    )
    expect(events).toEqual([
      { type: 'turn.started', turn: 't1' },
      { type: 'text', turn: 't1', id: 'a1:0', text: 'tail of an earlier turn' },
      { type: 'turn.ended', turn: 't1', status: 'interrupted' },
      { type: 'turn.started', turn: 'u1' },
      { type: 'prompt', turn: 'u1', id: 'u1', text: 'next' },
    ])
  })

  it('keeps state across feeds so a result in a later read still pairs with its call', () => {
    const stream = new ClaudeStream()
    stream.feed(
      lines(
        prompt('u1', 'go'),
        assistant('a1', [
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.ts' } },
        ]),
      ),
    )
    const later = stream.feed(lines(result('tu1', 'contents')))
    expect(later).toEqual([{ type: 'tool.result', turn: 'u1', id: 'tu1', output: 'contents' }])
  })

  it('skips a half-written line and keeps every real record', () => {
    const events = new ClaudeStream().feed([JSON.stringify(prompt('u1', 'a')), '{"type":"ass', ''])
    expect(events.map((e) => e.type)).toEqual(['turn.started', 'prompt'])
  })
})

describe('lastTurns', () => {
  it('keeps the last n turns whole', () => {
    const events = new ClaudeStream().feed(
      lines(
        prompt('u1', 'a'),
        assistant('a1', [{ type: 'text', text: 'x' }], 'end_turn'),
        prompt('u2', 'b'),
        prompt('u3', 'c'),
      ),
    )
    const last = lastTurns(events, 2)
    expect(last.filter((e) => e.type === 'turn.started')).toEqual([
      { type: 'turn.started', turn: 'u2' },
      { type: 'turn.started', turn: 'u3' },
    ])
    expect(lastTurns(events, 9)).toEqual(events)
  })
})
