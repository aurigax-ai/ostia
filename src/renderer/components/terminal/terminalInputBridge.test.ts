import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePhoneSizeStore } from '@/stores/terminal/phoneSizeStore'
import { terminalInputBridge } from './terminalInputBridge'

const actions = vi.hoisted(() => ({ typeable: true }))

vi.mock('@/lib/terminal/blockActions', () => ({
  canTypeInto: () => actions.typeable,
  insertCommand: vi.fn(() => true),
}))

function bridge() {
  const term = { focus: vi.fn(), paste: vi.fn() }
  return terminalInputBridge({
    paneId: 'p1',
    termRef: { current: term as never },
    setSuppressedPrompt: vi.fn(),
  })
}

beforeEach(() => {
  actions.typeable = true
  usePhoneSizeStore.setState({ byPane: {} })
})

afterEach(() => vi.clearAllMocks())

describe('terminalInputBridge and a phone size hold', () => {
  it.each([
    ['submit', (b: ReturnType<typeof bridge>) => b.submitInput('')],
    ['hand-off', (b: ReturnType<typeof bridge>) => b.handOffInput('draft', '\r')],
    ['shell keys', (b: ReturnType<typeof bridge>) => b.sendShellKeys('\x03')],
  ])('releases the hold the human set when the input editor does a %s', (_name, act) => {
    usePhoneSizeStore.getState().hold('p1', { cols: 44, useDesktop: vi.fn() })
    act(bridge())
    expect(window.ostia.pty.releaseHold).toHaveBeenCalledWith('p1')
  })

  it('sends no release for a pane nobody holds, and none when the prompt is not typeable', () => {
    bridge().sendShellKeys('\x03')
    expect(window.ostia.pty.releaseHold).not.toHaveBeenCalled()
    usePhoneSizeStore.getState().hold('p1', { cols: 44, useDesktop: vi.fn() })
    actions.typeable = false
    bridge().sendShellKeys('\x03')
    expect(window.ostia.pty.releaseHold).not.toHaveBeenCalled()
  })

  it('keeps the input untagged: the keys go to the pty without a human source', () => {
    usePhoneSizeStore.getState().hold('p1', { cols: 44, useDesktop: vi.fn() })
    bridge().sendShellKeys('\x03')
    expect(window.ostia.pty.write).toHaveBeenCalledWith('p1', '\x03')
  })
})
