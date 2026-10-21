import { describe, expect, it } from 'vitest'
import { isTerminalReply } from './terminalReplies'

describe('isTerminalReply', () => {
  it.each([
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['primary device attributes', '\x1b[?1;2c'],
    ['secondary device attributes', '\x1b[>0;276;0c'],
    ['status report', '\x1b[0n'],
    ['cursor position', '\x1b[24;80R'],
    ['extended cursor position', '\x1b[?24;80;1R'],
    ['mode report', '\x1b[?2004;2$y'],
    ['window size report', '\x1b[8;24;80t'],
    ['keyboard protocol report', '\x1b[?0u'],
    ['colour report', '\x1b]11;rgb:1e1e/1e1e/1e1e\x07'],
    ['colour report with a string terminator', '\x1b]4;1;rgb:cdcd/0000/0000\x1b\\'],
    ['string report', '\x1bP1+r544e\x1b\\'],
    ['several replies in one frame', '\x1b[I\x1b[?1;2c\x1b[24;80R'],
  ])('treats a %s as a reply', (_name, data) => {
    expect(isTerminalReply(data)).toBe(true)
  })

  it.each([
    ['a letter', 'a'],
    ['a line', 'ls\r'],
    ['enter', '\r'],
    ['interrupt', '\x03'],
    ['escape', '\x1b'],
    ['an arrow', '\x1b[A'],
    ['a function key', '\x1b[15~'],
    ['a modified F3', '\x1b[1;5R'],
    ['a paste', '\x1b[200~hello\x1b[201~'],
    ['a reply followed by a key', '\x1b[Ia'],
    ['a key followed by a reply', 'a\x1b[I'],
    ['nothing', ''],
  ])('treats %s as input', (_name, data) => {
    expect(isTerminalReply(data)).toBe(false)
  })
})
