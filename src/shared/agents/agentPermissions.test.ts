import { describe, expect, it } from 'vitest'
import { normalizePermissionAsk, permissionDetail } from './agentPermissions'
import { QUESTION_CONTEXT_MAX } from './questions'

describe('permissionDetail', () => {
  it('shows a command as is', () => {
    expect(permissionDetail({ command: 'rm -rf build', description: 'clean' })).toBe('rm -rf build')
  })

  it('shows a file edit as a path and a diff', () => {
    expect(
      permissionDetail({
        file_path: '/w/a.ts',
        old_string: 'let a = 1',
        new_string: 'const a = 1',
      }),
    ).toBe('/w/a.ts\n- let a = 1\n+ const a = 1')
  })

  it('shows a new file’s content', () => {
    expect(permissionDetail({ file_path: '/w/b.md', content: '# B' })).toBe('/w/b.md\n+ # B')
  })

  it('falls back to the input as JSON', () => {
    expect(permissionDetail({ url: 'https://example.com' })).toBe(
      '{\n  "url": "https://example.com"\n}',
    )
  })
})

describe('normalizePermissionAsk', () => {
  it('strips control characters and clips the detail', () => {
    const parsed = normalizePermissionAsk({
      agent: 'claude',
      tool: 'Bash\u001b[31m',
      detail: `echo \u0007hi\n${'x'.repeat(QUESTION_CONTEXT_MAX)}`,
      always: false,
    })
    expect(parsed?.permission).toEqual({ agent: 'claude', tool: 'Bash[31m' })
    expect(parsed?.content.question).toBe('Bash[31m: echo hi')
    expect(parsed?.content.context.length).toBe(QUESTION_CONTEXT_MAX)
    expect(parsed?.content.choices).toEqual(['once', 'deny'])
  })

  it('offers Always allow only when asked to', () => {
    const parsed = normalizePermissionAsk({
      agent: 'claude',
      tool: 'Bash',
      detail: '',
      always: true,
    })
    expect(parsed?.content.choices).toEqual(['once', 'always', 'deny'])
    expect(parsed?.content.question).toBe('Bash')
  })

  it('refuses an unknown agent or a missing tool', () => {
    expect(normalizePermissionAsk({ agent: 'x', tool: 'Bash', detail: '' })).toBeNull()
    expect(normalizePermissionAsk({ agent: 'codex', tool: ' ', detail: '' })).toBeNull()
  })
})
