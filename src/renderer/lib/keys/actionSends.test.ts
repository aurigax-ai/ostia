import { describe, expect, it } from 'vitest'
import { SEND_ACTION_KEYS, actionSend, sendActionKey } from './actionSends'

describe('sendActionKey', () => {
  it('names the common line editing sends and leaves others unnamed', () => {
    expect(sendActionKey({ type: 'hex', value: '0x01' })).toBe('lineStart')
    expect(sendActionKey({ type: 'escape', value: 'd' })).toBe('deleteWordForward')
    expect(sendActionKey({ type: 'text', value: 'clear\n' })).toBeNull()
  })

  it('reads every action’s own send back as that action, and Ctrl+W as delete previous word', () => {
    for (const key of SEND_ACTION_KEYS) expect(sendActionKey(actionSend(key))).toBe(key)
    expect(sendActionKey({ type: 'hex', value: '0x17' })).toBe('deleteWordBack')
  })
})
