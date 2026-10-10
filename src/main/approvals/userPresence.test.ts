import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en, zhHant } from '../../shared/app/dict'
import { POLKIT_ACTION } from '../../shared/permissions/scriptTokens'

const showMessageBox = vi.hoisted(() => vi.fn())
const canPromptTouchID = vi.hoisted(() => vi.fn())
const promptTouchID = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  dialog: { showMessageBox },
  systemPreferences: { canPromptTouchID, promptTouchID },
}))

const {
  electronPresenceDeps,
  fallbackOptions,
  installPolkitCommand,
  runPkcheck,
  verifyUserPresence,
} = await import('./userPresence')
type Deps = Parameters<typeof verifyUserPresence>[1]
type PkcheckRun = Awaited<ReturnType<Deps['pkcheck']>>

const REASON = 'generate the script token "ceo"'
const never = () => new Promise<never>(() => {})

type Mock = ReturnType<typeof vi.fn>

function deps(over: Partial<Deps> = {}): Deps & { prompt: Mock; pkcheck: Mock; confirm: Mock } {
  const d: Deps = {
    platform: 'darwin',
    touchId: { canPrompt: () => true, prompt: vi.fn(async () => {}) },
    policyInstalled: () => true,
    pkcheck: vi.fn(async (): Promise<PkcheckRun> => ({ code: 0, stderr: '' })),
    confirm: vi.fn(async () => true),
    pid: 4242,
    timeoutMs: 1_000,
    ...over,
  }
  return Object.assign(d, { prompt: d.touchId.prompt }) as never
}

function mac(prompt: () => Promise<void>, over: Partial<Deps> = {}) {
  return deps({ touchId: { canPrompt: () => true, prompt: vi.fn(prompt) }, ...over })
}

function linux(run: PkcheckRun | (() => Promise<PkcheckRun>), over: Partial<Deps> = {}) {
  return deps({
    platform: 'linux',
    pkcheck: vi.fn(typeof run === 'function' ? run : async () => run),
    ...over,
  })
}

describe('verifyUserPresence on macOS', () => {
  it('passes once Touch ID (or the password it falls back to) succeeds, with our reason', async () => {
    const d = mac(async () => {})
    await expect(verifyUserPresence(REASON, d)).resolves.toEqual({ ok: true, via: 'touch-id' })
    expect(d.prompt).toHaveBeenCalledWith(REASON)
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it('refuses with cancelled when the human cancels the system prompt', async () => {
    const d = mac(async () => {
      throw new Error('Canceled by user.')
    })
    await expect(verifyUserPresence(REASON, d)).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
    })
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it('refuses with failed when authentication fails, without the Ostia dialog', async () => {
    const d = mac(async () => {
      throw new Error('Application retry limit exceeded.')
    })
    await expect(verifyUserPresence(REASON, d)).resolves.toEqual({
      ok: false,
      code: 'failed',
      detail: 'Touch ID failed: Application retry limit exceeded.',
    })
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it('refuses with timeout when the prompt is never answered', async () => {
    const d = mac(never, { timeoutMs: 10 })
    await expect(verifyUserPresence(REASON, d)).resolves.toMatchObject({
      ok: false,
      code: 'timeout',
    })
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it.each([
    ['has no Touch ID', () => false],
    [
      'cannot tell',
      () => {
        throw new Error('boom')
      },
    ],
  ])('asks with the Ostia dialog when the Mac %s', async (_what, canPrompt) => {
    const d = deps({ touchId: { canPrompt, prompt: vi.fn(async () => {}) } })
    await expect(verifyUserPresence(REASON, d)).resolves.toEqual({ ok: true, via: 'confirm' })
    expect(d.prompt).not.toHaveBeenCalled()
    expect(d.confirm).toHaveBeenCalledWith({ reason: REASON, polkitHint: false })
  })
})

describe('verifyUserPresence on Linux', () => {
  it('asks polkit for the Ostia action on this process', async () => {
    const d = linux({ code: 0, stderr: '' })
    await expect(verifyUserPresence(REASON, d)).resolves.toEqual({ ok: true, via: 'polkit' })
    expect(d.pkcheck).toHaveBeenCalledWith(
      ['--action-id', POLKIT_ACTION, '--process', '4242', '--allow-user-interaction'],
      1_000,
    )
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it.each<[string, PkcheckRun, string]>([
    ['refused', { code: 1, stderr: 'Not authorized.' }, 'failed'],
    ['dismissed', { code: 3, stderr: 'Authentication dialog was dismissed' }, 'cancelled'],
    ['timed out', { code: null, stderr: '', timedOut: true }, 'timeout'],
    ['broken', { code: 127, stderr: 'Error checking for authorization' }, 'failed'],
  ])('refuses when polkit is %s, without the Ostia dialog', async (_what, run, code) => {
    const d = linux(run)
    await expect(verifyUserPresence(REASON, d)).resolves.toMatchObject({ ok: false, code })
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it('asks with the Ostia dialog and the install hint when the polkit action is not installed', async () => {
    const d = linux({ code: 0, stderr: '' }, { policyInstalled: () => false })
    await expect(verifyUserPresence(REASON, d)).resolves.toEqual({ ok: true, via: 'confirm' })
    expect(d.pkcheck).not.toHaveBeenCalled()
    expect(d.confirm).toHaveBeenCalledWith({ reason: REASON, polkitHint: true })
  })

  it.each<[string, PkcheckRun]>([
    ['pkcheck is missing', { code: null, stderr: 'spawn pkcheck ENOENT', missing: true }],
    ['no authentication agent runs', { code: 2, stderr: 'No authentication agent found.' }],
    [
      'polkit does not know the action',
      { code: 127, stderr: `Action ${POLKIT_ACTION} is not registered` },
    ],
  ])('asks with the Ostia dialog when %s', async (_what, run) => {
    const d = linux(run)
    await expect(verifyUserPresence(REASON, d)).resolves.toEqual({ ok: true, via: 'confirm' })
    expect(d.confirm).toHaveBeenCalledWith({ reason: REASON, polkitHint: true })
  })

  it('refuses with failed when running pkcheck throws', async () => {
    const d = linux(async () => {
      throw new Error('EMFILE')
    })
    await expect(verifyUserPresence(REASON, d)).resolves.toMatchObject({
      ok: false,
      code: 'failed',
    })
    expect(d.confirm).not.toHaveBeenCalled()
  })
})

describe('verifyUserPresence through the Ostia dialog', () => {
  const fallback = (confirm: Deps['confirm'], over: Partial<Deps> = {}) =>
    deps({ platform: 'win32', confirm: vi.fn(confirm), ...over })

  it('is the only way on a platform with no system authentication', async () => {
    const d = fallback(async () => true)
    await expect(verifyUserPresence(REASON, d)).resolves.toEqual({ ok: true, via: 'confirm' })
    expect(d.prompt).not.toHaveBeenCalled()
    expect(d.pkcheck).not.toHaveBeenCalled()
  })

  it.each<[string, Deps['confirm'], number | undefined, string]>([
    ['declined', async () => false, undefined, 'cancelled'],
    ['never answered', never, 10, 'timeout'],
    ['impossible to show', async () => undefined, undefined, 'unavailable'],
    [
      'broken',
      async () => {
        throw new Error('no display')
      },
      undefined,
      'failed',
    ],
  ])('refuses when the dialog is %s', async (_what, confirm, timeoutMs, code) => {
    const d = fallback(confirm, timeoutMs ? { timeoutMs } : {})
    await expect(verifyUserPresence(REASON, d)).resolves.toMatchObject({ ok: false, code })
  })
})

describe('runPkcheck', () => {
  let dir = ''
  let path = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pkcheck-'))
    path = process.env.PATH ?? ''
    process.env.PATH = `${dir}:/usr/bin:/bin`
  })

  afterEach(() => {
    process.env.PATH = path
    rmSync(dir, { recursive: true, force: true })
  })

  function fake(script: string): void {
    const file = join(dir, 'pkcheck')
    writeFileSync(file, `#!/bin/sh\n${script}\n`)
    chmodSync(file, 0o755)
  }

  it('reports the exit code, stderr and the arguments it was given', async () => {
    fake('echo "$@" >&2; exit 3')
    await expect(runPkcheck(['--action-id', 'x'], 5_000)).resolves.toEqual({
      code: 3,
      stderr: '--action-id x\n',
    })
  })

  it('reports a missing pkcheck', async () => {
    process.env.PATH = dir
    await expect(runPkcheck([], 5_000)).resolves.toMatchObject({ code: null, missing: true })
  })

  it('stops a pkcheck that never answers', async () => {
    fake('exec sleep 30')
    await expect(runPkcheck([], 50)).resolves.toMatchObject({ timedOut: true })
  })
})

describe('the Ostia dialog', () => {
  const command = installPolkitCommand('/opt/Ostia/resources')

  it('defaults to cancel and names the action', () => {
    const options = fallbackOptions(
      { reason: REASON, polkitHint: false },
      'darwin',
      en.native.userPresence,
      command,
    )
    expect(options).toMatchObject({
      buttons: ['Allow', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Allow Ostia to ${REASON}?`,
    })
    expect(options.detail).not.toContain('install-polkit')
  })

  it('tells a Linux user how to turn on polkit, with a path sudo can find', () => {
    expect(command).toBe('sudo "/opt/Ostia/resources/bin/ostia" install-polkit')
    const options = fallbackOptions(
      { reason: '產生腳本權杖「ceo」', polkitHint: true },
      'linux',
      zhHant.native.userPresence,
      command,
    )
    expect(options.message).toBe('要讓 Ostia 產生腳本權杖「ceo」嗎？')
    expect(options.detail).toContain(command)
  })

  it('opens on the focused window, and cannot ask without one', async () => {
    const focused = { isDestroyed: () => false, isFocused: () => true }
    const other = { isDestroyed: () => false, isFocused: () => false }
    let windows: unknown[] = []
    const real = electronPresenceDeps(
      () => windows as never,
      () => en.native.userPresence,
      '/opt/Ostia/resources',
    )
    await expect(real.confirm({ reason: REASON, polkitHint: false })).resolves.toBeUndefined()
    windows = [other, focused]
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(real.confirm({ reason: REASON, polkitHint: false })).resolves.toBe(true)
    expect(showMessageBox.mock.calls[0][0]).toBe(focused)
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(real.confirm({ reason: REASON, polkitHint: false })).resolves.toBe(false)
  })

  it('reaches Touch ID through systemPreferences', async () => {
    const real = electronPresenceDeps(
      () => [],
      () => en.native.userPresence,
      '/opt/Ostia/resources',
    )
    canPromptTouchID.mockReturnValueOnce(true)
    promptTouchID.mockResolvedValueOnce(undefined)
    expect(real.touchId.canPrompt()).toBe(true)
    await real.touchId.prompt(REASON)
    expect(promptTouchID).toHaveBeenCalledWith(REASON)
  })
})
