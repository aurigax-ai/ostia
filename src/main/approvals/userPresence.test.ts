import type { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en, zhHant } from '../../shared/app/dict'
import { POLKIT_ACTION } from '../../shared/permissions/scriptTokens'

const canPromptTouchID = vi.hoisted(() => vi.fn())
const promptTouchID = vi.hoisted(() => vi.fn())
const opened = vi.hoisted(() => [] as FakeWindow[])

interface FakeWindow {
  options: Record<string, unknown>
  webContents: EventEmitter & { setWindowOpenHandler: ReturnType<typeof vi.fn> }
  events: EventEmitter
  url: string
  closed: boolean
}

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class BrowserWindow {
    options: Record<string, unknown>
    webContents = Object.assign(new Emitter(), { setWindowOpenHandler: vi.fn() })
    events = new Emitter()
    url = ''
    closed = false
    constructor(options: Record<string, unknown>) {
      this.options = options
      opened.push(this as unknown as FakeWindow)
    }
    once(event: string, fn: () => void) {
      this.events.once(event, fn)
    }
    async loadURL(url: string) {
      this.url = url
    }
    isDestroyed() {
      return this.closed
    }
    show() {}
    close() {
      this.closed = true
      this.events.emit('closed')
    }
  }
  return { BrowserWindow, systemPreferences: { canPromptTouchID, promptTouchID } }
})

const {
  electronPresenceDeps,
  fallbackAnswer,
  fallbackPage,
  installPolkitCommand,
  runPkcheck,
  verifyUserPresence,
} = await import('./userPresence')
type Deps = Parameters<typeof verifyUserPresence>[1]
type PkcheckRun = Awaited<ReturnType<Deps['pkcheck']>>
type Mock = ReturnType<typeof vi.fn>

const { JSDOM } = createRequire(__filename)('jsdom') as {
  JSDOM: new (
    html: string,
    options: { runScripts: 'dangerously' },
  ) => { window: Window & typeof globalThis }
}

const ASK = { reason: 'generate the script token "ceo"', name: 'ceo' }
const never = () => new Promise<never>(() => {})

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
    await expect(verifyUserPresence(ASK, d)).resolves.toEqual({ ok: true, via: 'touch-id' })
    expect(d.prompt).toHaveBeenCalledWith(ASK.reason)
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it.each(['Canceled by user.', '使用者已取消。', 'Application retry limit exceeded.'])(
    'refuses whatever the system prompt rejects with (%s), without the Ostia dialog',
    async (message) => {
      const d = mac(async () => {
        throw new Error(message)
      })
      await expect(verifyUserPresence(ASK, d)).resolves.toEqual({
        ok: false,
        code: 'failed',
        detail: `Touch ID did not confirm: ${message}`,
      })
      expect(d.confirm).not.toHaveBeenCalled()
    },
  )

  it('refuses with timeout when the prompt is never answered', async () => {
    const d = mac(never, { timeoutMs: 10 })
    await expect(verifyUserPresence(ASK, d)).resolves.toMatchObject({
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
    await expect(verifyUserPresence(ASK, d)).resolves.toEqual({ ok: true, via: 'confirm' })
    expect(d.prompt).not.toHaveBeenCalled()
    expect(d.confirm).toHaveBeenCalledWith({ ...ASK, polkitHint: false })
  })
})

describe('verifyUserPresence on Linux', () => {
  it('asks polkit for the Ostia action on this process', async () => {
    const d = linux({ code: 0, stderr: '' })
    await expect(verifyUserPresence(ASK, d)).resolves.toEqual({ ok: true, via: 'polkit' })
    expect(d.pkcheck).toHaveBeenCalledWith(
      ['--action-id', POLKIT_ACTION, '--process', '4242', '--allow-user-interaction'],
      1_000,
    )
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it.each<[string, PkcheckRun, string]>([
    ['refused', { code: 1, stderr: 'Not authorized.' }, 'failed'],
    ['without an agent', { code: 2, stderr: 'No authentication agent found.' }, 'unavailable'],
    ['dismissed', { code: 3, stderr: 'Authentication dialog was dismissed' }, 'cancelled'],
    ['timed out', { code: null, stderr: '', timedOut: true }, 'timeout'],
    ['missing pkcheck', { code: null, stderr: '', missing: true }, 'unavailable'],
    [
      'not told about the action',
      { code: 127, stderr: `Action ${POLKIT_ACTION} is not registered` },
      'failed',
    ],
    ['broken', { code: 127, stderr: 'Error checking for authorization' }, 'failed'],
  ])(
    'refuses when the action is installed and polkit is %s, never falling back to the Ostia dialog',
    async (_what, run, code) => {
      const d = linux(run)
      await expect(verifyUserPresence(ASK, d)).resolves.toMatchObject({ ok: false, code })
      expect(d.confirm).not.toHaveBeenCalled()
    },
  )

  it('asks with the Ostia dialog and the install hint only when the polkit action is not installed', async () => {
    const d = linux({ code: 0, stderr: '' }, { policyInstalled: () => false })
    await expect(verifyUserPresence(ASK, d)).resolves.toEqual({ ok: true, via: 'confirm' })
    expect(d.pkcheck).not.toHaveBeenCalled()
    expect(d.confirm).toHaveBeenCalledWith({ ...ASK, polkitHint: true })
  })

  it('refuses with failed when running pkcheck throws', async () => {
    const d = linux(async () => {
      throw new Error('EMFILE')
    })
    await expect(verifyUserPresence(ASK, d)).resolves.toMatchObject({
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
    await expect(verifyUserPresence(ASK, d)).resolves.toEqual({ ok: true, via: 'confirm' })
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
    await expect(verifyUserPresence(ASK, d)).resolves.toMatchObject({ ok: false, code })
  })
})

describe('runPkcheck', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pkcheck-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function fake(name: string, script: string): string {
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/sh\n${script}\n`)
    chmodSync(file, 0o755)
    return file
  }

  it('runs the first pkcheck that exists and reports its exit code and stderr', async () => {
    const second = fake('second', 'echo "second $@" >&2; exit 3')
    fake('pkcheck', 'exit 0')
    await expect(
      runPkcheck(['--action-id', 'x'], 5_000, [join(dir, 'gone'), second]),
    ).resolves.toEqual({
      code: 3,
      stderr: 'second --action-id x\n',
    })
  })

  it('looks only at fixed paths, not PATH', async () => {
    fake('pkcheck', 'exit 0')
    const path = process.env.PATH
    process.env.PATH = dir
    try {
      await expect(runPkcheck([], 5_000, [join(dir, 'nope')])).resolves.toMatchObject({
        code: null,
        missing: true,
      })
    } finally {
      process.env.PATH = path
    }
  })

  it('stops a pkcheck that never answers', async () => {
    const slow = fake('slow', 'exec sleep 30')
    await expect(runPkcheck([], 50, [slow])).resolves.toMatchObject({ timedOut: true })
  })
})

describe('the Ostia dialog', () => {
  const command = installPolkitCommand('/opt/Ostia/resources')

  function page(
    name = 'ceo',
    platform: NodeJS.Platform = 'linux',
    text = en.native.userPresence,
    reason = `generate the script token "${name}"`,
  ) {
    const dom = new JSDOM(
      fallbackPage({ reason, name, polkitHint: platform === 'linux' }, platform, text, command),
      { runScripts: 'dangerously' },
    )
    const doc = dom.window.document
    const input = doc.getElementById('name') as HTMLInputElement
    const allow = doc.getElementById('allow') as HTMLButtonElement
    const type = (value: string) => {
      input.value = value
      input.dispatchEvent(new dom.window.Event('input'))
    }
    const submit = () => (doc.getElementById('f') as HTMLFormElement).requestSubmit()
    return { dom, doc, allow, type, submit }
  }

  it('keeps Allow disabled and refuses Enter until the token name is typed exactly', () => {
    const p = page()
    const initial = p.doc.title
    expect(p.allow.disabled).toBe(true)
    p.submit()
    expect(p.doc.title).toBe(initial)
    for (const wrong of ['ce', 'CEO', 'ceo ', 'x']) {
      p.type(wrong)
      expect(p.allow.disabled).toBe(true)
      p.submit()
      expect(p.doc.title).toBe(initial)
    }
    p.type('ceo')
    expect(p.allow.disabled).toBe(false)
    p.submit()
    expect(fallbackAnswer(p.doc.title, 'ceo')).toBe(true)
  })

  it('answers cancel from the button and from Escape', () => {
    const p = page()
    ;(p.doc.getElementById('cancel') as HTMLButtonElement).click()
    expect(fallbackAnswer(p.doc.title, 'ceo')).toBe(false)
    const q = page()
    q.doc.dispatchEvent(new q.dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
    expect(fallbackAnswer(q.doc.title, 'ceo')).toBe(false)
  })

  it('accepts an allow only for the exact name, whatever the page says', () => {
    expect(fallbackAnswer('ostia-presence:allow:ceo', 'ceo')).toBe(true)
    expect(fallbackAnswer('ostia-presence:allow:ceo2', 'ceo')).toBe(false)
    expect(fallbackAnswer('ostia-presence:allow:', 'ceo')).toBe(false)
    expect(fallbackAnswer('Confirm it is you', 'ceo')).toBeUndefined()
  })

  it('tells a Linux user how to turn on polkit, with a path sudo can find', () => {
    expect(command).toBe('sudo "/opt/Ostia/resources/bin/ostia" install-polkit')
    const p = page('ceo', 'linux', zhHant.native.userPresence, '產生腳本權杖「ceo」')
    expect(p.doc.querySelector('h1')?.textContent).toBe('要讓 Ostia 產生腳本權杖「ceo」嗎？')
    expect(p.doc.querySelector('label')?.textContent).toBe('輸入「ceo」才能允許')
    expect(p.doc.querySelector('p')?.textContent).toContain(command)
    expect(page('ceo', 'darwin').doc.body.textContent).not.toContain('install-polkit')
  })

  it('escapes the name in the page', () => {
    const p = page('<b>"x"</b>')
    expect(p.doc.querySelector('b')).toBeNull()
    p.type('<b>"x"</b>')
    p.submit()
    expect(fallbackAnswer(p.doc.title, '<b>"x"</b>')).toBe(true)
  })
})

describe('electronPresenceDeps', () => {
  const focused = { isDestroyed: () => false, isFocused: () => true }
  const other = { isDestroyed: () => false, isFocused: () => false }

  beforeEach(() => {
    opened.length = 0
  })

  function real(windows: unknown[]) {
    return electronPresenceDeps(
      () => windows as never,
      () => en.native.userPresence,
      '/opt/Ostia/resources',
    )
  }

  const prompt = { ...ASK, polkitHint: false }
  const title = (w: FakeWindow, value: string) => {
    w.webContents.emit('page-title-updated', { preventDefault() {} }, value)
  }

  it('cannot ask without a window', async () => {
    await expect(real([]).confirm(prompt)).resolves.toBeUndefined()
    expect(opened).toEqual([])
  })

  it('opens a sandboxed modal page over the focused window and allows only the exact name', async () => {
    const answer = real([other, focused]).confirm(prompt)
    await Promise.resolve()
    const [w] = opened
    expect(w.options).toMatchObject({
      parent: focused,
      modal: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    expect(decodeURIComponent(w.url)).toContain('Type &quot;ceo&quot; to allow it')
    title(w, 'Confirm it is you')
    title(w, 'ostia-presence:allow:ceo')
    await expect(answer).resolves.toBe(true)
    expect(w.closed).toBe(true)
  })

  it('refuses a wrong name, a cancel, and closing the window', async () => {
    for (const end of [
      (w: FakeWindow) => title(w, 'ostia-presence:allow:other'),
      (w: FakeWindow) => title(w, 'ostia-presence:cancel'),
      (w: FakeWindow) => w.events.emit('closed'),
    ]) {
      opened.length = 0
      const answer = real([focused]).confirm(prompt)
      await Promise.resolve()
      end(opened[0])
      await expect(answer).resolves.toBe(false)
    }
  })

  it('blocks navigation and new windows from the page', async () => {
    void real([focused]).confirm(prompt)
    await Promise.resolve()
    const [w] = opened
    const nav = { preventDefault: vi.fn() }
    w.webContents.emit('will-navigate', nav)
    expect(nav.preventDefault).toHaveBeenCalled()
    const handler = w.webContents.setWindowOpenHandler.mock.calls[0][0]
    expect(handler()).toEqual({ action: 'deny' })
  })

  it('reaches Touch ID through systemPreferences', async () => {
    const d = real([])
    canPromptTouchID.mockReturnValueOnce(true)
    promptTouchID.mockResolvedValueOnce(undefined)
    expect(d.touchId.canPrompt()).toBe(true)
    await d.touchId.prompt(ASK.reason)
    expect(promptTouchID).toHaveBeenCalledWith(ASK.reason)
  })
})
