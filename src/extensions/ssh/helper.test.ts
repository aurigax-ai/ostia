import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { helperSource } from '../../../test/fixtures/ssh/remoteHost'
import { helperBundle, posixCksum, versionToken } from './helper'
import { hostKey, planConnect, planHelper } from './plan'

function systemCksum(data: Buffer): string {
  return spawnSync('cksum', { input: data, encoding: 'utf8' }).stdout.trim()
}

describe('posixCksum', () => {
  it('matches the cksum program for empty, short and binary input', () => {
    const samples = [
      Buffer.alloc(0),
      Buffer.from('hello\n'),
      Buffer.from(Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256)),
    ]
    for (const sample of samples) {
      expect(`${posixCksum(sample)} ${sample.length}`).toBe(systemCksum(sample))
    }
    expect(versionToken(Buffer.from('hello\n'))).toBe(
      systemCksum(Buffer.from('hello\n')).replace(' ', '-'),
    )
  })
})

describe('helper bundle', () => {
  const helper = helperBundle(helperSource())

  it('SSH-C41 builds each fixed command as one sh -c word every login shell reads the same', () => {
    for (const command of Object.values(helper.commands)) {
      const prefix = "exec sh -c '"
      expect(command.startsWith(prefix)).toBe(true)
      expect(command.endsWith("'")).toBe(true)
      const word = command.slice(prefix.length, -1)
      expect(word).not.toMatch(/['!\\\n\r\t]/)
      expect([...word].every((c) => c >= ' ' && c <= '~')).toBe(true)
      expect(command.length).toBeLessThan(2048)
    }
  })

  it('names the version after the script and puts it under ~/.pine/helper', () => {
    expect(helper.version).toMatch(/^[0-9a-f]{12}$/)
    expect(helper.path).toBe(`~/.pine/helper/${helper.version}/helper.sh`)
    const other = helperBundle(Buffer.concat([helperSource(), Buffer.from('\n')]))
    expect(other.version).not.toBe(helper.version)
    expect(other.commands.run).not.toBe(helper.commands.run)
  })

  it('SSH-C40 adds only -T before the separator and a fixed command after the destination', () => {
    const plan = planConnect(['-J', 'b1', '-p', '2200', 'dev@db'])
    if (!plan) throw new Error('plan')
    expect(planHelper(plan, 'run', helper)).toEqual([
      'ssh',
      '-J',
      'b1',
      '-p',
      '2200',
      '-T',
      '--',
      'dev@db',
      helper.commands.run,
    ])
    const other = planConnect(['web'])
    if (!other) throw new Error('plan')
    expect(planHelper(other, 'install', helper)).toEqual([
      'ssh',
      '-T',
      '--',
      'web',
      helper.commands.install,
    ])
    expect(planHelper(other, 'remove', helper).at(-1)).toBe(helper.commands.remove)
    expect(hostKey(plan)).toBe('dev@db:2200')
    expect(hostKey(other)).toBe('web')
  })
})
