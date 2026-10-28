import { describe, expect, it } from 'vitest'
import type { StreamEvent } from '../../shared/agents/agentStream'
import { readLine, SessionPrinter } from './portalSession'

function printed(run: (printer: SessionPrinter) => void): string {
  let out = ''
  run(
    new SessionPrinter((text) => {
      out += text
    }),
  )
  return out
}

describe('the manager session printer', () => {
  it('PIM-C15 prints the connected line and the prompt mark', () => {
    expect(printed((p) => p.banner())).toBe(
      'ostia: connected to the manager session. Ctrl+\\ detaches; the session keeps running.\n\n> ',
    )
  })

  it('PIM-C15 prints a tool name line, the reply text and the next prompt at the end of the turn', () => {
    const events: StreamEvent[] = [
      { type: 'turn.started', turn: 't1' },
      { type: 'prompt', turn: 't1', id: 'p', text: 'what is running?' },
      { type: 'tool', turn: 't1', id: 'c1', kind: 'other', name: 'ostia_workspaces' },
      { type: 'text', turn: 't1', id: 'x', text: 'You have 1 workspace.' },
      { type: 'turn.ended', turn: 't1', status: 'done' },
    ]
    const out = printed((p) => {
      p.typed('what is running?')
      p.events(events)
    })
    expect(out).toBe('\n  ostia_workspaces\nYou have 1 workspace.\n\n> ')
  })

  it('PIM-C15 prints one waiting line while a card waits, and a failed tool by its name', () => {
    const out = printed((p) => {
      p.events([{ type: 'tool', turn: 't1', id: 'c1', kind: 'other', name: 'ostia_agent_run' }])
      p.waiting()
      p.events([{ type: 'tool.result', turn: 't1', id: 'c1', output: 'denied', isError: true }])
    })
    expect(out).toBe(
      '  ostia_agent_run\n  waiting for approval in the Ostia window\n  ostia_agent_run: failed\n',
    )
  })

  it('PIM-C15 shows a prompt typed in the Ostia window but not the one this client sent', () => {
    const out = printed((p) => {
      p.typed('mine')
      p.events([
        { type: 'prompt', turn: 't1', id: 'a', text: 'mine' },
        { type: 'prompt', turn: 't2', id: 'b', text: 'from the window' },
      ])
    })
    expect(out).toBe('\n> from the window\n')
  })
})

describe('readLine', () => {
  it('PIM-C16 keeps the typed text, echoes it and submits a line on Enter', () => {
    const first = readLine('', 'hel')
    expect(first).toEqual({ buffer: 'hel', input: { edit: 'hel', submitted: [], detach: false } })
    const second = readLine(first.buffer, 'lo\r')
    expect(second.input.submitted).toEqual(['hello'])
    expect(second.buffer).toBe('')
  })

  it('PIM-C16 erases on Backspace and drops arrow-key sequences', () => {
    const read = readLine('', 'ab\x7f\x1b[Ac\r')
    expect(read.input.submitted).toEqual(['ac'])
    expect(read.input.edit).toBe('ab\b \bc')
  })

  it('PIM-C16 detaches on Ctrl+\\ and submits nothing after it', () => {
    const read = readLine('', 'hi\x1cmore\r')
    expect(read.input.detach).toBe(true)
    expect(read.input.submitted).toEqual([])
  })
})
