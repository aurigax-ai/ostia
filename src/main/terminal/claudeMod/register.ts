export const MOD_TICK_MS = 2000
export const MOD_DRAFT_QUIET_MS = 10_000
export const MOD_SAFETY_MS = 30_000
export const MOD_BUSY_RETRY_MS = 10_000
const MOD_HOOK_TIMEOUT_MS = 20_000
export const MOD_WAITING_STATUS = 'mail waits for your prompt'

interface Timer {
  cancel: () => void
}

interface Mod$ {
  clock: { every: (ms: number, fn: () => void) => Timer }
  env: { get: (name: string) => Promise<string | undefined> }
  fs: { stat: (path: string) => Promise<{ size: number; mtimeMs: number }> }
  process: {
    run: (
      argv: readonly string[],
      init?: { env?: Record<string, string>; timeoutMs?: number },
    ) => Promise<{ exitCode: number; stdout: string }>
  }
  prompt: {
    read: () => Promise<{ text: string }>
    submit: (input: { text: string }) => Promise<unknown>
  }
  session: { id: () => Promise<string> }
  ui: { status: (text: string | undefined) => void }
}

type Next = (e?: unknown) => Promise<unknown>
type Hook = ($: Mod$, e: { isInteractive?: boolean }, next: Next) => unknown
export type ModOn = (event: string, hook: Hook) => unknown

interface Taken {
  text?: string
  lease?: string
  busy?: true
  limited?: true
  retryMs?: number
}

interface Link {
  file: string
  node: string
  cli: string
  session: string
}

interface ModState {
  link: Link | undefined
  timer: Timer | undefined
  working: boolean
  seen: string | undefined
  retryAt: number
  safetyAt: number
  editedAt: number
  reported: string
}

function freshState(): ModState {
  return {
    link: undefined,
    timer: undefined,
    working: false,
    seen: undefined,
    retryAt: 0,
    safetyAt: 0,
    editedAt: 0,
    reported: 'idle',
  }
}

const mod: ModState = freshState()

async function hook($: Mod$, args: readonly string[]): Promise<Taken | undefined> {
  const link = mod.link
  if (!link) return undefined
  try {
    const ran = await $.process.run([link.node, link.cli, 'bus', 'hook', ...args], {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: MOD_HOOK_TIMEOUT_MS,
    })
    const line = ran.stdout.trim()
    return ran.exitCode === 0 && line ? (JSON.parse(line) as Taken) : undefined
  } catch {
    return undefined
  }
}

async function report($: Mod$, state: string): Promise<void> {
  if (state === mod.reported || !mod.link) return
  mod.reported = state
  await hook($, ['mod-ready', mod.link.session, state])
}

async function tick($: Mod$): Promise<void> {
  const link = mod.link
  if (mod.working || !link) return
  mod.working = true
  try {
    const flag = await $.fs.stat(link.file).then(
      (stat) => `${stat.mtimeMs}:${stat.size}`,
      () => undefined,
    )
    const now = Date.now()
    const changed = flag !== undefined && flag !== mod.seen
    const due = changed || (mod.retryAt > 0 && now >= mod.retryAt) || now >= mod.safetyAt
    if (!due) return
    const box = await $.prompt.read()
    const drafting = box.text !== '' || now - mod.editedAt < MOD_DRAFT_QUIET_MS
    await report($, drafting ? 'draft' : 'idle')
    if (drafting) {
      mod.retryAt = now
      $.ui.status(MOD_WAITING_STATUS)
      return
    }
    $.ui.status(undefined)
    mod.seen = flag
    mod.retryAt = 0
    mod.safetyAt = now + MOD_SAFETY_MS
    const taken = await hook($, ['take'])
    if (!taken) return
    if (taken.busy) mod.retryAt = now + MOD_BUSY_RETRY_MS
    if (taken.retryMs !== undefined) mod.retryAt = now + Math.max(taken.retryMs, MOD_TICK_MS)
    if (!taken.text || !taken.lease) return
    await $.prompt.submit({ text: taken.text })
    await hook($, ['ack', taken.lease])
  } catch {
    mod.retryAt = Date.now() + MOD_BUSY_RETRY_MS
  } finally {
    mod.working = false
  }
}

async function begin($: Mod$): Promise<void> {
  const file = await $.env.get('OSTIA_MAIL_FILE')
  const node = await $.env.get('OSTIA_NODE')
  const cli = await $.env.get('OSTIA_CLI')
  if (!file || !node || !cli) return
  mod.link = { file, node, cli, session: await $.session.id() }
  mod.reported = ''
  await report($, 'idle')
  mod.timer?.cancel()
  mod.timer = $.clock.every(MOD_TICK_MS, () => void tick($))
}

async function finish($: Mod$): Promise<void> {
  mod.timer?.cancel()
  mod.timer = undefined
  await report($, 'gone')
  mod.link = undefined
}

export const register = (on: ModOn): void => {
  Object.assign(mod, freshState())
  on('prompt.edit', (_$, e, next) => {
    mod.editedAt = Date.now()
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (e.isInteractive) await begin($)
    return started
  })

  on('session.end', async ($, e, next) => {
    await finish($)
    return next(e)
  })
}
