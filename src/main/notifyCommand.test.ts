import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expandNotifyCommand, runNotifyCommand } from './notifyCommand'

const values = { title: 'Build done', body: 'ok; rm -rf /', pane: 'p1' }

describe('expandNotifyCommand', () => {
  it('substitutes placeholders inside each argument without re-splitting the values', () => {
    expect(expandNotifyCommand('notify-send {title} "{title}: {body}" {pane}', values)).toEqual([
      'notify-send',
      'Build done',
      'Build done: ok; rm -rf /',
      'p1',
    ])
  })

  it('returns null for an empty or unterminated template', () => {
    expect(expandNotifyCommand('   ', values)).toBeNull()
    expect(expandNotifyCommand('say "unterminated', values)).toBeNull()
  })

  it('leaves unknown placeholders alone', () => {
    expect(expandNotifyCommand('echo {file}', values)).toEqual(['echo', '{file}'])
  })
})

describe('runNotifyCommand', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  async function waitFor(path: string): Promise<void> {
    for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 30))
  }

  it('runs the program directly with the expanded argv, so shell metacharacters stay data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pine-notify-cmd-'))
    dirs.push(dir)
    const script = join(dir, 'hook.sh')
    const out = join(dir, 'out.txt')
    writeFileSync(script, `#!/bin/sh\nprintf '%s|%s|%s' "$1" "$2" "$3" > "${out}"\n`)
    chmodSync(script, 0o755)

    expect(runNotifyCommand(`${script} {title} {body} {pane}`, values)).toBe(true)
    await waitFor(out)

    expect(readFileSync(out, 'utf8')).toBe('Build done|ok; rm -rf /|p1')
  })

  it('does nothing for an empty command and survives a missing program', () => {
    expect(runNotifyCommand('', values)).toBe(false)
    expect(runNotifyCommand('/no/such/pine-program {title}', values)).toBe(true)
  })
})
