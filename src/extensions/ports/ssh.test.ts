import { describe, expect, it } from 'vitest'
import { sshArgs, sshLabel, sshLogin } from './ssh'

const sshTarget = (args: string[]): string | null => sshLogin(args)?.host ?? null

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

describe('sshLogin', () => {
  it('keeps the user from user@host, -l or an ssh:// URL', () => {
    expect(sshLogin(['deploy@prod-1'])).toEqual({ user: 'deploy', host: 'prod-1' })
    expect(sshLogin(['-l', 'root', 'box'])).toEqual({ user: 'root', host: 'box' })
    expect(sshLogin(['-lroot', '-p', '22', 'box'])).toEqual({ user: 'root', host: 'box' })
    expect(sshLogin(['-l', 'root', 'me@box'])).toEqual({ user: 'me', host: 'box' })
    expect(sshLogin(['ssh://me@box.lan:2222'])).toEqual({ user: 'me', host: 'box.lan' })
    expect(sshLogin(['box'])).toEqual({ host: 'box' })
  })

  it('drops a user name that is not plain text but keeps the host', () => {
    expect(sshLogin(['$(id)@box'])).toEqual({ host: 'box' })
    expect(sshLogin(['-l', 'a\u001b[31m', 'box'])).toEqual({ host: 'box' })
  })

  it('SSH-C27 reads the login of a session the ssh extension opened through a bastion', () => {
    const login = sshLogin(['-J', 'b1', '-p', '2200', '--', 'dev@db'])
    expect(login).toEqual({ user: 'dev', host: 'db' })
    expect(login && sshLabel(login)).toBe('dev@db')
    expect(sshLogin(['-p', '2200', '-t', '--', 'dev@db', "exec sh -c 'p=x'"])).toEqual({
      user: 'dev',
      host: 'db',
    })
  })

  it('labels a login as user@host, or the host alone', () => {
    expect(sshLabel({ user: 'deploy', host: 'build-box' })).toBe('deploy@build-box')
    expect(sshLabel({ host: 'build-box' })).toBe('build-box')
  })
})
