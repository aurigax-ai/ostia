import { describe, expect, it } from 'vitest'
import { agentPrompt, offerText, workspaceFolder } from './extensionAgents'

describe('offerText', () => {
  it('keeps one trimmed line and refuses any control character, Enter included', () => {
    expect(offerText('  Work on SHOP-7  ')).toBe('Work on SHOP-7')
    for (const raw of ['a\r', 'a\nb', 'a\x1b[201~', 'a\tb', '\x7f', ' ', 42]) {
      expect(offerText(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

describe('agentPrompt', () => {
  it('allows newlines and tabs but no other control character', () => {
    expect(agentPrompt('line one\n\tline two\n')).toBe('line one\n\tline two')
    expect(agentPrompt('a\r\nb')).toBeNull()
    expect(agentPrompt('a\x1bb')).toBeNull()
  })
})

describe('workspaceFolder', () => {
  it('expands the home folder and drops anything that is not absolute', () => {
    expect(workspaceFolder('~', '/home/u')).toBe('/home/u')
    expect(workspaceFolder('~/shop', '/home/u')).toBe('/home/u/shop')
    expect(workspaceFolder('/srv/shop', '/home/u')).toBe('/srv/shop')
    expect(workspaceFolder('shop', '/home/u')).toBeUndefined()
    expect(workspaceFolder(undefined, '/home/u')).toBeUndefined()
  })
})
