import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { offlineAttention, saveAttentionOffline } from './offlineAttention'

const root = mkdtempSync(join(tmpdir(), 'ostia-offline-attention-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const stdin = (text: string) => async () => text

describe('attention reported while the app cannot be reached', () => {
  it('KSH-C85 writes what a Claude hook reports into the kept pane state file', async () => {
    const tokenFile = join(root, 'token')
    writeFileSync(`${tokenFile}.state`, '')
    const env = { OSTIA_TOKEN_FILE: tokenFile }
    const payload = JSON.stringify({ notification_type: 'permission_prompt', message: 'Run rm?' })
    expect(await saveAttentionOffline(['claude-hook', 'Notification'], stdin(payload), env)).toBe(
      true,
    )
    expect(JSON.parse(readFileSync(`${tokenFile}.state`, 'utf8'))).toEqual({
      state: 'waiting',
      message: 'Run rm?',
    })
    expect(await saveAttentionOffline(['claude-hook', 'Stop'], stdin('{}'), env)).toBe(true)
    expect(JSON.parse(readFileSync(`${tokenFile}.state`, 'utf8')).state).toBe('done')
  })

  it('KSH-C85 writes what the Codex hooks report through the state verb, and clears on clear', async () => {
    const tokenFile = join(root, 'codex-token')
    const env = { OSTIA_TOKEN_FILE: tokenFile }
    const payload = JSON.stringify({ tool_name: 'shell' })
    expect(await saveAttentionOffline(['state', 'waiting', '-'], stdin(payload), env)).toBe(true)
    expect(JSON.parse(readFileSync(`${tokenFile}.state`, 'utf8'))).toEqual({
      state: 'waiting',
      message: 'Needs your permission to use shell',
    })
    expect(await saveAttentionOffline(['state', 'clear'], stdin(''), env)).toBe(true)
    expect(readFileSync(`${tokenFile}.state`, 'utf8')).toBe('')
  })

  it('leaves the file alone when a hook has nothing to report, and handles nothing else', async () => {
    const tokenFile = join(root, 'quiet-token')
    writeFileSync(`${tokenFile}.state`, '{"state":"working"}')
    const env = { OSTIA_TOKEN_FILE: tokenFile }
    const idle = JSON.stringify({ notification_type: 'idle_prompt' })
    expect(await saveAttentionOffline(['claude-hook', 'Notification'], stdin(idle), env)).toBe(true)
    expect(readFileSync(`${tokenFile}.state`, 'utf8')).toBe('{"state":"working"}')
    expect(await saveAttentionOffline(['whoami'], stdin(''), env)).toBe(false)
    expect(await saveAttentionOffline(['state', 'done', '--pane', 'other'], stdin(''), env)).toBe(
      false,
    )
    expect(await offlineAttention(['state', 'bogus'], stdin(''))).toBeNull()
  })

  it('does nothing in a pane that is not kept', async () => {
    expect(await saveAttentionOffline(['state', 'done'], stdin(''), {})).toBe(false)
  })
})
