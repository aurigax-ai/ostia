import { describe, expect, it, vi } from 'vitest'
import { answerInboxAction } from './inboxIpc'

describe('the inbox action from a window', () => {
  const owner = (workspaceId: string) => (workspaceId === 'w1' ? '7' : undefined)

  it('forwards the action when the sender owns the workspace', () => {
    const slots = { inboxAction: vi.fn(() => true) }
    expect(answerInboxAction(slots, owner, '7', 'activity', 'w1', 'abcdefghij')).toBe(true)
    expect(slots.inboxAction).toHaveBeenCalledWith('activity', 'w1', 'abcdefghij')
  })

  it('refuses another window, an unowned workspace and arguments that are not strings', () => {
    const slots = { inboxAction: vi.fn(() => true) }
    expect(answerInboxAction(slots, owner, '8', 'activity', 'w1', 'abcdefghij')).toBe(false)
    expect(answerInboxAction(slots, owner, '7', 'activity', 'w2', 'abcdefghij')).toBe(false)
    expect(answerInboxAction(slots, owner, '7', 1, 'w1', 'abcdefghij')).toBe(false)
    expect(answerInboxAction(slots, owner, '7', 'activity', {}, 'abcdefghij')).toBe(false)
    expect(answerInboxAction(slots, owner, '7', 'activity', 'w1', null)).toBe(false)
    expect(slots.inboxAction).not.toHaveBeenCalled()
  })

  it('answers false when the slots hold no such item', () => {
    const slots = { inboxAction: vi.fn(() => false) }
    expect(answerInboxAction(slots, owner, '7', 'activity', 'w1', 'abcdefghij')).toBe(false)
  })
})
