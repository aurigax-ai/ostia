import { describe, expect, it } from 'vitest'
import { sshArgs, sshTarget } from './ssh'

describe('sshArgs', () => {
  it('takes the arguments after the ssh program, also when an interpreter ran it', () => {
    expect(sshArgs(['ssh', '-p', '22', 'box', ''])).toEqual(['-p', '22', 'box'])
    expect(sshArgs(['/usr/bin/ssh', 'box'])).toEqual(['box'])
    expect(sshArgs(['/bin/sh', '/tmp/bin/ssh', 'me@box'])).toEqual(['me@box'])
  })
})

describe('sshTarget', () => {
  it('returns the host of a plain destination', () => {
    expect(sshTarget(['prod-1'])).toBe('prod-1')
    expect(sshTarget(['deploy@prod-1.example.com'])).toBe('prod-1.example.com')
  })

  it('skips options and the values they take, attached or separate', () => {
    expect(sshTarget(['-p', '2222', '-i', '/k/id', 'me@box'])).toBe('box')
    expect(sshTarget(['-p2222', '-o', 'ServerAliveInterval=30', 'box'])).toBe('box')
    expect(sshTarget(['-tA', '-L', '8080:localhost:80', 'box', 'htop'])).toBe('box')
    expect(sshTarget(['-vvv', '-J', 'jump', 'inner'])).toBe('inner')
  })

  it('reads the destination after -- and from an ssh:// URL', () => {
    expect(sshTarget(['-4', '--', 'box'])).toBe('box')
    expect(sshTarget(['ssh://me@box.lan:2222'])).toBe('box.lan')
    expect(sshTarget(['ssh://[::1]:22'])).toBe('[::1]')
  })

  it('shows nothing for invocations that open no session', () => {
    expect(sshTarget(['-V'])).toBeNull()
    expect(sshTarget(['-G', 'box'])).toBeNull()
    expect(sshTarget(['-O', 'exit', 'box'])).toBeNull()
    expect(sshTarget([])).toBeNull()
    expect(sshTarget(['-p', '22'])).toBeNull()
  })

  it('refuses a destination that is not a plain host name', () => {
    expect(sshTarget(['$(reboot)'])).toBeNull()
    expect(sshTarget(['box\u001b[31m'])).toBeNull()
    expect(sshTarget(['me@'])).toBeNull()
  })
})
