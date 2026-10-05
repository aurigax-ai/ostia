import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCompletionSpec } from '../shared/completionSpec'
import { loadCompletionSpec } from './completionSpecs'

let base: string
let user: string
let ext: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-specs-'))
  user = join(base, 'user')
  ext = join(base, 'ext')
  mkdirSync(user)
  mkdirSync(ext)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const spec = (description: string) =>
  JSON.stringify({ names: ['tool'], description, subcommands: [{ names: ['run'] }] })

describe('loadCompletionSpec', () => {
  it('prefers the user folder over extension folders', () => {
    writeFileSync(join(ext, 'tool.json'), spec('from the extension'))
    expect(loadCompletionSpec('tool', [user, ext])?.description).toBe('from the extension')
    writeFileSync(join(user, 'tool.json'), spec('mine'))
    expect(loadCompletionSpec('tool', [user, ext])?.description).toBe('mine')
  })

  it('refuses command names that could leave the folder', () => {
    writeFileSync(join(base, 'tool.json'), spec('outside'))
    for (const name of ['../tool', 'a/b', '', '.hidden', 'x'.repeat(65)]) {
      expect(loadCompletionSpec(name, [user])).toBeNull()
    }
  })

  it('skips invalid, oversized and symlinked files and falls through to the next folder', () => {
    writeFileSync(join(user, 'tool.json'), '{"names": "not-a-list"}')
    writeFileSync(join(ext, 'tool.json'), spec('valid'))
    expect(loadCompletionSpec('tool', [user, ext])?.description).toBe('valid')
    writeFileSync(join(base, 'real.json'), spec('linked'))
    symlinkSync(join(base, 'real.json'), join(user, 'linked.json'))
    expect(loadCompletionSpec('linked', [user])).toBeNull()
    writeFileSync(join(user, 'big.json'), ' '.repeat(4 * 1024 * 1024 + 1))
    expect(loadCompletionSpec('big', [user])).toBeNull()
  })

  it('rereads a spec after it changes', () => {
    writeFileSync(join(user, 'tool.json'), spec('one'))
    expect(loadCompletionSpec('tool', [user])?.description).toBe('one')
    writeFileSync(join(user, 'tool.json'), spec('second'))
    expect(loadCompletionSpec('tool', [user])?.description).toBe('second')
  })
})

describe('Fig spec conversion', () => {
  it('turns every Fig spec into one that passes the validator', async () => {
    const { writeFigSpecs } = await import('../../scripts/completionSpecs.mjs')
    const out = join(base, 'fig')
    const count = await writeFigSpecs(out)
    const files = readdirSync(out).filter((f) => f.endsWith('.json'))
    expect(readFileSync(join(out, 'LICENSE-withfig-autocomplete'), 'utf8')).toMatch(
      /ISC|Permission/,
    )
    expect(count).toBe(files.length)
    expect(count).toBeGreaterThan(500)
    const failures = files.filter(
      (f) => parseCompletionSpec(JSON.parse(readFileSync(join(out, f), 'utf8'))) instanceof Error,
    )
    expect(failures).toEqual([])
    const git = parseCompletionSpec(JSON.parse(readFileSync(join(out, 'git.json'), 'utf8')))
    if (git instanceof Error) throw git
    const checkout = git.subcommands?.find((c) => c.names.includes('checkout'))
    expect(checkout?.description).toBeTruthy()
    expect(checkout?.options?.some((o) => o.names.includes('-b'))).toBe(true)
  }, 60_000)
})
