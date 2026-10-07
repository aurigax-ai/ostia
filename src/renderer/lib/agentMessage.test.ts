import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { ENTER_AFTER_PASTE_MS } from './agentEnter'
import { canMessageAgent, planAgentMessage, sendToAgent } from './agentMessage'
import { registerTerminal } from './terminalHandles'

const PANE = 'pane-agent'

let blocksInit: ReturnType<typeof useBlocksStore.getState>
let attentionInit: ReturnType<typeof useAttentionStore.getState>
let term: { paste: ReturnType<typeof vi.fn> }
let unregister: () => void

beforeAll(() => {
  blocksInit = useBlocksStore.getState()
  attentionInit = useAttentionStore.getState()
})

beforeEach(() => {
  vi.useFakeTimers()
  term = { paste: vi.fn() }
  unregister = registerTerminal(PANE, term as unknown as Terminal)
})

afterEach(() => {
  unregister()
  vi.useRealTimers()
  useBlocksStore.setState(blocksInit, true)
  useAttentionStore.setState(attentionInit, true)
})

function agentRunning(): void {
  useBlocksStore.setState({
    drafts: {},
    running: { [PANE]: 'b1' },
    agentBlocks: { [PANE]: { blockId: 'b1', agent: 'claude' } },
  })
}

function plainCommandRunning(): void {
  useBlocksStore.setState({ drafts: {}, running: { [PANE]: 'b1' }, agentBlocks: {} })
}

function idlePrompt(): void {
  useBlocksStore.setState({ drafts: { [PANE]: {} as never }, running: {}, agentBlocks: {} })
}

describe('sendToAgent', () => {
  it('pastes the message into a pane running an agent and then presses Enter', () => {
    agentRunning()
    expect(sendToAgent(PANE, 'rebase onto main')).toBe(true)
    expect(term.paste).toHaveBeenCalledWith('rebase onto main')
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(ENTER_AFTER_PASTE_MS)
    expect(window.ostia.pty.write).toHaveBeenCalledWith(PANE, '\r')
  })

  it('types nothing into a shell at an idle prompt', () => {
    idlePrompt()
    expect(canMessageAgent(PANE)).toBe(false)
    expect(sendToAgent(PANE, 'rm -rf build')).toBe(false)
    vi.advanceTimersByTime(ENTER_AFTER_PASTE_MS)
    expect(term.paste).not.toHaveBeenCalled()
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
  })

  it('types nothing into a pane running a plain command', () => {
    plainCommandRunning()
    expect(sendToAgent(PANE, 'y')).toBe(false)
    expect(term.paste).not.toHaveBeenCalled()
  })

  it('reaches a command that reported waiting, which counts as an agent', () => {
    plainCommandRunning()
    useAttentionStore.getState().dispatch(PANE, { type: 'set', state: 'waiting', at: 1 })
    expect(sendToAgent(PANE, 'yes')).toBe(true)
  })

  it('does not press Enter when the agent ended before the key was due', () => {
    agentRunning()
    sendToAgent(PANE, 'hello')
    idlePrompt()
    vi.advanceTimersByTime(ENTER_AFTER_PASTE_MS)
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
  })

  it('sends nothing for an empty message or a pane without a terminal', () => {
    agentRunning()
    expect(sendToAgent(PANE, '')).toBe(false)
    expect(sendToAgent('other-pane', 'hi')).toBe(false)
    expect(term.paste).not.toHaveBeenCalled()
  })
})

describe('planAgentMessage', () => {
  it('sends one line as it is, without its surrounding blank space', () => {
    expect(planAgentMessage('  go on \n', true)).toEqual({ text: 'go on', confirm: false })
  })

  it('strips control characters from one line', () => {
    expect(planAgentMessage('go\x1b[31m on\x03', true)).toEqual({
      text: 'go[31m on',
      confirm: false,
    })
  })

  it('asks before several lines while the human keeps the risky-paste warning on', () => {
    expect(planAgentMessage('one\ntwo', true)).toEqual({ text: 'one\ntwo', confirm: true })
    expect(planAgentMessage('one\ntwo', false)).toEqual({ text: 'one\ntwo', confirm: false })
  })
})
