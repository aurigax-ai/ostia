import { NODE_STATUS_PREFIX } from '../../../shared/remote/remoteNode'
import type { RemoteAgent, RemoteError, RemoteJob } from '../../../shared/remote/remoteSetup'
import { type ChannelOptions, HelperFailure, runLine } from '../channel'
import { type ConnectPlan, planRemote } from '../plan'
import { type NodeBundle, remoteWord } from './bundle'
import { PROBE_COMMAND, type Probe, parseProbe } from './probe'

const PING_OPTIONS = ['-T', '-o', 'ConnectTimeout=8']
const INSTALL_TIMEOUT_MS = 120_000

export class RemoteFailure extends Error {
  constructor(
    readonly code: RemoteError | 'missing' | 'corrupt' | 'not-signed-in',
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
  }
}

export function classify(err: unknown): RemoteFailure {
  if (err instanceof RemoteFailure) return err
  const detail = err instanceof HelperFailure ? err.detail : undefined
  if (err instanceof HelperFailure && err.code === 'connect-failed') {
    if (/permission denied|publickey/i.test(detail ?? '')) return new RemoteFailure('auth', detail)
    if (/host key/i.test(detail ?? '')) return new RemoteFailure('host-key', detail)
  }
  return new RemoteFailure('network', detail ?? (err instanceof Error ? err.message : String(err)))
}

interface Answer {
  ok?: false
  error?: string
  running?: string
}

export interface Pong {
  version: string
}

export class RunnerClient {
  constructor(
    private readonly plan: ConnectPlan,
    private readonly bundle: NodeBundle,
    private readonly opts: ChannelOptions = {},
  ) {}

  private async call<T>(command: string, params?: object, options?: string[]): Promise<T> {
    let line: string
    try {
      line = await runLine(
        planRemote(this.plan, this.bundle.run(command), options),
        params ? Buffer.from(JSON.stringify(params)) : null,
        NODE_STATUS_PREFIX,
        this.opts,
      )
    } catch (err) {
      throw classify(err)
    }
    const answer = JSON.parse(line) as T & Answer
    if (answer.ok === false) {
      if (answer.error === 'missing' || answer.error === 'corrupt') {
        throw new RemoteFailure(answer.error)
      }
      if (answer.error === 'incompatible') throw new RemoteFailure('incompatible', answer.running)
      throw new RemoteFailure('runner-stopped', answer.error)
    }
    return answer
  }

  async reach(): Promise<void> {
    try {
      await runLine(
        planRemote(this.plan, remoteWord(`echo "${NODE_STATUS_PREFIX}ok"`)),
        null,
        NODE_STATUS_PREFIX,
        this.opts,
      )
    } catch (err) {
      throw classify(err)
    }
  }

  async probe(): Promise<Probe> {
    try {
      return parseProbe(
        await runLine(planRemote(this.plan, PROBE_COMMAND), null, NODE_STATUS_PREFIX, this.opts),
      )
    } catch (err) {
      throw classify(err)
    }
  }

  async signedIn(agent: RemoteAgent): Promise<boolean> {
    const status = agent === 'claude' ? 'claude auth status' : 'codex login status'
    try {
      const line = await runLine(
        planRemote(
          this.plan,
          remoteWord(
            `if ${status} >/dev/null 2>&1; then echo "${NODE_STATUS_PREFIX}yes"; else echo "${NODE_STATUS_PREFIX}no"; fi`,
          ),
        ),
        null,
        NODE_STATUS_PREFIX,
        this.opts,
      )
      return line === 'yes'
    } catch (err) {
      throw classify(err)
    }
  }

  async install(): Promise<void> {
    let line: string
    try {
      line = await runLine(
        planRemote(this.plan, this.bundle.install),
        this.bundle.data,
        NODE_STATUS_PREFIX,
        { ...this.opts, requestTimeoutMs: INSTALL_TIMEOUT_MS },
      )
    } catch (err) {
      throw classify(err)
    }
    const answer = JSON.parse(line) as Answer
    if (answer.ok === false) throw new RemoteFailure('install-failed', answer.error)
  }

  ensure(replace = false): Promise<Pong> {
    return this.call('ensure', { replace })
  }

  ping(): Promise<Pong> {
    return this.call('ping', undefined, PING_OPTIONS)
  }

  async jobs(): Promise<RemoteJob[]> {
    return (await this.call<{ jobs: RemoteJob[] }>('jobs')).jobs
  }

  async paneNew(input: { agent: string; folder: string; name?: string }): Promise<string> {
    return (await this.call<{ pane: string }>('pane-new', input)).pane
  }

  stop(pane: string): Promise<unknown> {
    return this.call('stop', { pane })
  }

  async selftest(): Promise<boolean> {
    return (await this.call<{ ok: boolean }>('selftest')).ok
  }
}
