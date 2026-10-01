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
    })
    expect(JSON.stringify(target)).not.toContain('nc -X')
  })
})
