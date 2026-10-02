import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTarget } from './target'

function captured(name: string): string {
  return readFileSync(join(process.cwd(), 'test', 'fixtures', 'ssh', `${name}.txt`), 'utf8')
}

describe('parseTarget', () => {
  it('SSH-C8 reads user, host name, port and the jump hops from ssh -G output', () => {
    expect(parseTarget('db', captured('db'))).toEqual({
      alias: 'db',
      user: 'dev',
      hostname: '10.0.0.5',
      port: 2200,
      jump: ['b1', 'ops@b2:2222'],
      proxyCommand: false,
      remoteCommand: false,
    })
  })

  it('SSH-C9 reports a proxy command only as a flag and no hops when none are set', () => {
    const target = parseTarget('px', captured('px'))
    expect(target).toEqual({
      alias: 'px',
      user: 'dev',
      hostname: 'px.example.com',
      port: 22,
      jump: [],
      proxyCommand: true,
      remoteCommand: false,
    })
    expect(JSON.stringify(target)).not.toContain('nc -X')
  })

  it('SSH-C29 reports a RemoteCommand from the ssh config only as a flag, never its text', () => {
    const target = parseTarget('rc', captured('rc'))
    expect(target.remoteCommand).toBe(true)
    expect(JSON.stringify(target)).not.toContain('tmux')
  })

  it('SSH-C29 treats a session type other than the default as a config that decides what runs', () => {
    const base = ['user dev', 'hostname h', 'port 22']
    expect(parseTarget('h', [...base, 'sessiontype none'].join('\n')).remoteCommand).toBe(true)
    expect(parseTarget('h', [...base, 'sessiontype subsystem'].join('\n')).remoteCommand).toBe(true)
    expect(parseTarget('h', [...base, 'sessiontype default'].join('\n')).remoteCommand).toBe(false)
  })
})
