import { describe, expect, it } from 'vitest'
import { NODE_ENTRY } from '../../../shared/remote/remoteNode'
import { nodeBundle } from './bundle'

const file = (name: string, text: string) => ({ name, data: Buffer.from(text) })

describe('nodeBundle', () => {
  it('REM-U3 versions by content and joins the files in order', () => {
    const a = nodeBundle([file(NODE_ENTRY, 'a\n'), file('b.js', 'b\nb\n')])
    const same = nodeBundle([file(NODE_ENTRY, 'a\n'), file('b.js', 'b\nb\n')])
    const other = nodeBundle([file(NODE_ENTRY, 'a\n'), file('b.js', 'c\nb\n')])
    expect(a.version).toMatch(/^[0-9a-f]{12}$/)
    expect(same.version).toBe(a.version)
    expect(other.version).not.toBe(a.version)
    expect(a.data.toString()).toBe('a\nb\nb\n')
  })

  it('REM-U4 refuses a file that does not end with a newline and a bundle without the runner', () => {
    expect(() => nodeBundle([file(NODE_ENTRY, 'a')])).toThrow(/newline/)
    expect(() => nodeBundle([file('b.js', 'b\n')])).toThrow(/missing/)
  })

  it('REM-U5 builds each remote command as one sh -c word', () => {
    const bundle = nodeBundle([file(NODE_ENTRY, 'a\n')])
    for (const command of [bundle.install, bundle.run('ping')]) {
      expect(command.startsWith("exec sh -c '")).toBe(true)
      expect(command.endsWith("'")).toBe(true)
      expect(command.slice(12, -1)).not.toContain("'")
    }
  })
})
