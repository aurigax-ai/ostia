import type { AgentRenderer } from './agentSessions'
import type { PiStream } from './piStream'

const ACCEPT_MS = 10_000

export type PortalPromptFailure = 'no-session' | 'no-window' | 'not-accepted'

export type PortalPromptResult = { ok: true } | { ok: false; error: PortalPromptFailure }

type Delivery = { ok: true; ended: Promise<boolean> } | { ok: false; error: PortalPromptFailure }

export interface PortalPromptHost {
  renderer: (sessionId: string) => AgentRenderer | null
  stream: (sessionId: string) => PiStream | undefined
}

const hasEvent =
  (type: string) =>
  (events: readonly { type: string }[]): boolean =>
    events.some((e) => e.type === type)

export class PortalPrompts {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly waits = new Map<string, Set<() => void>>()

  constructor(
    private readonly host: PortalPromptHost,
    private readonly acceptMs = ACCEPT_MS,
  ) {}

  async prompt(sessionId: string, text: string): Promise<PortalPromptResult> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    let release = (): void => {}
    this.tails.set(
      sessionId,
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    await previous
    const sent = await this.deliver(sessionId, text).catch(() => null)
    if (!sent?.ok) {
      release()
      return sent ?? { ok: false, error: 'no-window' }
    }
    void sent.ended.then(release)
    return { ok: true }
  }

  forget(sessionId: string): void {
    for (const stop of [...(this.waits.get(sessionId) ?? [])]) stop()
    this.waits.delete(sessionId)
    this.tails.delete(sessionId)
  }

  private until(
    sessionId: string,
    stream: PiStream,
    done: (events: readonly { type: string }[]) => boolean,
    ms?: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const waits = this.waits.get(sessionId) ?? new Set<() => void>()
      this.waits.set(sessionId, waits)
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (met: boolean): void => {
        if (timer) clearTimeout(timer)
        unsubscribe()
        waits.delete(cancel)
        resolve(met)
      }
      const cancel = (): void => finish(false)
      const unsubscribe = stream.subscribe((events) => {
        if (done(events)) finish(true)
      })
      waits.add(cancel)
      if (ms !== undefined) timer = setTimeout(cancel, ms)
    })
  }

  private async deliver(sessionId: string, text: string): Promise<Delivery> {
    const stream = this.host.stream(sessionId)
    if (!stream) return { ok: false, error: 'no-session' }
    if (stream.busy && !(await this.until(sessionId, stream, hasEvent('turn.ended')))) {
      return { ok: false, error: 'no-session' }
    }
    const renderer = this.host.renderer(sessionId)
    if (!renderer) return { ok: false, error: 'no-window' }
    const accepted = this.until(sessionId, stream, hasEvent('prompt'), this.acceptMs)
    renderer.send('agent:prompted', { sessionId, text })
    if (!(await accepted)) return { ok: false, error: 'not-accepted' }
    return { ok: true, ended: this.until(sessionId, stream, hasEvent('turn.ended')) }
  }
}
