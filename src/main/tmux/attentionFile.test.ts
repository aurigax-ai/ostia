import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  attentionFileFor,
  parseSavedAttention,
  readSavedAttention,
  writeSavedAttention,
} from './attentionFile'

const root = mkdtempSync(join(tmpdir(), 'ostia-attention-file-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('saved attention file', () => {
  it('KSH-C85 keeps a state and its message in a 0600 file beside the token file', () => {
    const file = attentionFileFor(join(root, 'token'))
    expect(file).toBe(join(root, 'token.state'))
    writeSavedAttention(file, { state: 'waiting', message: 'Needs your permission to use Bash' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readSavedAttention(file)).toEqual({
      state: 'waiting',
      message: 'Needs your permission to use Bash',
    })
    writeSavedAttention(file, null)
    expect(readSavedAttention(file)).toBeNull()
  })

  it('reads nothing from a missing file, and takes only a known state and a short message from what a sandboxed shell wrote', () => {
    expect(readSavedAttention(join(root, 'missing.state'))).toBeNull()
    expect(parseSavedAttention('not json')).toBeNull()
    expect(parseSavedAttention('{"state":"none"}')).toBeNull()
    expect(parseSavedAttention('{"state":"owned","message":"x"}')).toBeNull()
    expect(parseSavedAttention('[]')).toBeNull()
    expect(parseSavedAttention(JSON.stringify({ state: 'done', message: 7, extra: true }))).toEqual(
      {
        state: 'done',
      },
    )
    expect(
      parseSavedAttention(JSON.stringify({ state: 'error', message: 'x'.repeat(900) })),
    ).toEqual({ state: 'error', message: 'x'.repeat(300) })
    const huge = join(root, 'huge.state')
    writeFileSync(huge, JSON.stringify({ state: 'done', message: 'y'.repeat(10_000) }))
    expect(readSavedAttention(huge)).toBeNull()
  })
})
